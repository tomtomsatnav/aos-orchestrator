// Verdict records: `aos-orch verify` persists each verdict as <orchDir>/verdicts/<id>.json for a read-only dashboard (docs/orch-state-contract.md, "Verdicts").
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { INTEGRITY_KINDS } from './guard.mjs';
import { ensureDir, atomicWrite } from './state.mjs';

export const VERDICT_SCHEMA = 'aos.verdict/1';
export const VERDICT_ID_RE = /^v-\d{8}-\d{6}-[0-9a-f]{6}$/;
export const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SOURCES = ['cli', 'hook', 'eval'];
export const MAX_VERDICTS = 500;
export const MAX_RECORD_BYTES = 64 * 1024;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, n);

export const verdictsRoot = (orch) => path.join(orch, 'verdicts');
export function newVerdictId(now = Date.now()) {
  const d = new Date(now).toISOString(); // 2026-10-21T09:08:07.123Z
  return `v-${d.slice(0, 10).replace(/-/g, '')}-${d.slice(11, 19).replace(/:/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
}

/** r: a verifyTree result. meta: {repo, base_ref, tree ('working' | sha), source, session_id, duration_ms, tool_version, now?}. -> the record */
export function buildVerdictRecord(r, meta) {
  const now = meta.now ?? Date.now();
  return {
    schema: VERDICT_SCHEMA, id: newVerdictId(now), created_at: new Date(now).toISOString(),
    repo: meta.repo, repo_name: path.basename(meta.repo), base: r.base ?? null, base_ref: meta.base_ref ?? null, tree: meta.tree || 'working',
    accepted: !!r.accepted, integrity: r.rejections.some((x) => INTEGRITY_KINDS.has(x.kind)),
    rejections: r.rejections.map((x) => ({ kind: clean(x.kind, 100), detail: clean(x.detail, 300) })),
    warnings: (r.anticheat?.warnings || []).slice(0, 20).map((x) => clean(`${x.kind}${x.path ? ` ${x.path}` : ''}: ${x.detail}`, 200)),
    failing_tests: (r.failing_tests || []).slice(0, 20).map((t) => clean(t.file && t.file !== t.name ? `${t.file}: ${t.name}` : t.name, 200)),
    checks: (r.checks || []).slice(0, 20).map((c) => ({ argv: clean((c.argv || []).join(' '), 200), ok: !!c.ok, exit_code: Number.isInteger(c.exit_code) ? c.exit_code : null, duration_ms: Math.round(Number(c.duration_ms) || 0) })),
    duration_ms: Math.round(meta.duration_ms || 0), source: SOURCES.includes(meta.source) ? meta.source : 'cli', session_id: meta.session_id ?? null, tool_version: meta.tool_version,
  };
}

/** Writes the record atomically (0600, dir 0700), keeps at most `limit` newest files (by id). Returns {id, path}. Never touches the verified repo. */
export function writeVerdict(orch, rec, { limit = MAX_VERDICTS } = {}) {
  const dir = ensureDir(verdictsRoot(orch)); try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const rec2 = { ...rec };
  while (Buffer.byteLength(JSON.stringify(rec2, null, 2)) > MAX_RECORD_BYTES) {
    const k = ['warnings', 'failing_tests', 'checks', 'rejections'].find((a) => rec2[a].length > 0);
    if (!k) break; rec2[k] = rec2[k].slice(0, Math.floor(rec2[k].length / 2));
  }
  const file = path.join(dir, `${rec2.id}.json`);
  atomicWrite(file, rec2);
  const ids = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && VERDICT_ID_RE.test(f.slice(0, -5))).sort();
  for (const f of ids.slice(0, Math.max(0, ids.length - limit))) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* best effort */ } }
  return { id: rec2.id, path: file };
}
