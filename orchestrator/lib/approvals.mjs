// File-based approvals inbox (design section 7). One file per request in <goal>/approvals/<id>.json, created with
// O_EXCL by the policy hook; decided by the CLI/control server; timeout = deny; every change is audited.
// The HTTP API (phase 3) will sit on top of these same functions.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, readJSON, ensureDir, iso } from './state.mjs';

export const STATUSES = ['pending', 'approved', 'denied', 'expired'];
const nowMs = (clock) => (clock ? clock.now() : Date.now());
const file = (dir, id) => path.join(dir, `${id}.json`);

export function audit(dir, entry, clock) {
  try { fs.appendFileSync(path.join(dir, 'audit.ndjson'), `${JSON.stringify({ ts: iso(nowMs(clock)), ...entry })}\n`, { mode: 0o600 }); } catch { /* best effort */ }
}

// cwd is part of the request: `rm -r build` approved in one directory must not be replayed in another
export const requestKey = ({ goal_id, task_id, attempt, tool, input, cwd = null }) =>
  crypto.createHash('sha256').update(JSON.stringify([goal_id, task_id, attempt, tool, input, cwd])).digest('hex').slice(0, 16);

export function readApproval(dir, id) { return readJSON(file(dir, id), null); }

export function listApprovals(dir, { status, task_id } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^A-\d+\.json$/.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) {
    const a = readJSON(path.join(dir, n), null);
    if (!a) continue;
    if (status && a.status !== status) continue;
    if (task_id && a.task_id !== task_id) continue;
    out.push(a);
  }
  return out.sort((x, y) => Number(x.id.slice(2)) - Number(y.id.slice(2)));
}

/** Create a pending request (or return the existing one for the same call in the same attempt). */
export function createApproval(dir, req, { clock, ttl_s = 86400 } = {}) {
  ensureDir(dir);
  const key = requestKey(req);
  const existing = listApprovals(dir).find((a) => a.key === key);
  if (existing) return existing;
  const t = nowMs(clock);
  for (let n = listApprovals(dir).length + 1; n < 100000; n++) {
    const id = `A-${n}`;
    const rec = { id, key, goal_id: req.goal_id, task_id: req.task_id, attempt: req.attempt, tool: req.tool, input: req.input, cwd: req.cwd ?? null,
      reason: req.reason, rule: req.rule, rule_id: req.rule_id ?? null, requested_at: iso(t), expires_at: iso(t + ttl_s * 1000), status: 'pending' };
    try {
      const fd = fs.openSync(file(dir, id), 'wx', 0o600);
      fs.writeSync(fd, `${JSON.stringify(rec, null, 2)}\n`);
      fs.closeSync(fd);
      audit(dir, { event: 'requested', id, task_id: req.task_id, tool: req.tool, rule: req.rule, rule_id: req.rule_id ?? null }, clock);
      return rec;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('approvals: could not allocate an id');
}

/** decision: 'approve' | 'deny'; scope: 'once' | 'task'. Only pending requests can be decided. */
export function decide(dir, id, { decision, scope = 'once', note = '', by = 'cli' }, clock) {
  const a = readApproval(dir, id);
  if (!a) throw new Error(`no such approval ${id}`);
  if (a.status !== 'pending') throw new Error(`approval ${id} is already ${a.status}`);
  if (!['approve', 'deny'].includes(decision)) throw new Error('decision must be approve or deny');
  const rec = { ...a, status: decision === 'approve' ? 'approved' : 'denied', scope, note, decided_by: by, decided_at: iso(nowMs(clock)) };
  atomicWrite(file(dir, id), rec);
  audit(dir, { event: 'decided', id, task_id: a.task_id, decision, scope, by }, clock);
  return rec;
}

/** Mark pending requests past expires_at as expired (= deny). Returns the newly expired. */
export function expireDue(dir, clock) {
  const t = nowMs(clock);
  const out = [];
  for (const a of listApprovals(dir, { status: 'pending' })) {
    if (Date.parse(a.expires_at) <= t) {
      const rec = { ...a, status: 'expired', decided_by: 'timeout', decided_at: iso(t) };
      atomicWrite(file(dir, a.id), rec);
      audit(dir, { event: 'expired', id: a.id, task_id: a.task_id }, clock);
      out.push(rec);
    }
  }
  return out;
}

/** Poll until decided or timeout. Resolves with the (possibly still pending) record. Uses real timers. */
export async function waitForDecision(dir, id, { timeoutMs, pollMs = 100 }) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const a = readApproval(dir, id);
    if (!a || a.status !== 'pending') return a;
    if (Date.now() >= end) return a;
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, end - Date.now()))));
  }
}
