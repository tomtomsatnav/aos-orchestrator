// On-disk state for one goal: layout, atomic writes, append-only events, per-goal engine lock, command queue.
// All state lives in files (AOS-1 section 5 names unchanged) so a crashed engine can be replaced by a fresh one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateGoal, validateTask } from './schema.mjs';

export const VERSION = 1;
export const TERMINAL = new Set(['achieved', 'failed', 'cancelled']);
// Ids become path components and git ref components: no leading dot/dash ('.', '..' would make the worktree root
// <repo>-aos-worktrees/.. = the repo's PARENT, which _finalize removes recursively), no '..', no trailing '.' or '.lock'.
export const ID_RE = /^(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?<!\.)$/;

export function orchRoot(env = process.env) {
  if (env.AOS_ORCH_DIR) return path.resolve(env.AOS_ORCH_DIR);
  const data = env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'aos-dashboard-aos-local');
  return path.join(data, 'orch');
}

export const goalsRoot = (orch) => path.join(orch, 'goals');
export const goalDirOf = (orch, id) => path.join(goalsRoot(orch), id);

export function paths(dir) {
  return {
    dir,
    goal: path.join(dir, 'goal.json'), tasks: path.join(dir, 'tasks.json'), agents: path.join(dir, 'agents.json'),
    hb: path.join(dir, 'heartbeat.json'), events: path.join(dir, 'events.ndjson'), plan: path.join(dir, 'plan.json'),
    report: path.join(dir, 'report.md'), lock: path.join(dir, '.tick.lock'),
    approvals: path.join(dir, 'approvals'), workers: path.join(dir, 'workers'), commands: path.join(dir, 'commands'),
    tmp: path.join(dir, 'tmp'), policyDefault: path.join(path.dirname(path.dirname(dir)), 'policy.default.json'),
  };
}

export const ensureDir = (d) => { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };

export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

let tmpSeq = 0;
export function atomicWrite(file, obj) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`;
  fs.writeFileSync(tmp, typeof obj === 'string' ? obj : `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const iso = (ms) => new Date(ms).toISOString();
export const realClock = { now: () => Date.now() };

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---------------------------------------------------------------- events
const seqCache = new Map(); // events file -> { size, seq }

function tailSeq(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const len = Math.min(size, 65536);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) { try { return { size, seq: JSON.parse(lines[i]).seq | 0 }; } catch { /* partial */ } }
      return { size, seq: 0 };
    } finally { fs.closeSync(fd); }
  } catch { return { size: 0, seq: 0 }; }
}

/** Append one Event; seq is strictly increasing per goal. Returns the stored event. */
export function appendEvent(dir, e, clock = realClock) {
  const file = paths(dir).events;
  let c = seqCache.get(file);
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* not yet */ }
  if (!c || c.size !== size) c = tailSeq(file);
  const ev = { ts: iso(clock.now()), seq: c.seq + 1, type: e.type, actor: e.actor || 'orchestrator',
    goal_id: e.goal_id ?? null, task_id: e.task_id ?? null, data: e.data || {} };
  const line = `${JSON.stringify(ev)}\n`;
  fs.appendFileSync(file, line, { mode: 0o600 });
  seqCache.set(file, { size: size + Buffer.byteLength(line), seq: ev.seq });
  return ev;
}

export function readEvents(dir, { sinceSeq = 0, limit = Infinity } = {}) {
  let text = '';
  try { text = fs.readFileSync(paths(dir).events, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (e.seq > sinceSeq) out.push(e); } catch { /* partial last line */ }
  }
  return out.slice(-limit);
}

// ---------------------------------------------------------------- goal state
export function loadState(dir) {
  const P = paths(dir);
  return { goal: readJSON(P.goal), tasks: readJSON(P.tasks, []), agents: readJSON(P.agents, []) };
}
export function saveState(dir, st) {
  const P = paths(dir);
  atomicWrite(P.tasks, st.tasks);
  atomicWrite(P.agents, st.agents);
  atomicWrite(P.goal, st.goal);
}
export function loadHeartbeat(dir) {
  return { seq: 0, ts: null, interval_s: 10, status: 'running', liveness: 'alive', last_tick_ms: 0, consecutive_errors: 0,
    ...(readJSON(paths(dir).hb, {}) || {}) };
}

// ---------------------------------------------------------------- lock (O_EXCL + pid, stale takeover)
/** Returns {ok:true} or {ok:false, holder}. Stale = holder pid dead, or lock not refreshed within ttlMs. */
export function acquireLock(dir, { pid = process.pid, ttlMs = 60000, now = Date.now() } = {}) {
  const file = paths(dir).lock;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid, ts: now, token: crypto.randomBytes(6).toString('hex') }));
      fs.closeSync(fd);
      return { ok: true, takeover: attempt > 0 };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const l = readJSON(file, null);
      const stale = !l || !pidAlive(l.pid) || now - l.ts > ttlMs;
      if (!stale) return { ok: false, holder: l };
      try { fs.unlinkSync(file); } catch { /* raced with another taker */ }
    }
  }
  return { ok: false, holder: readJSON(file, null) };
}
export function touchLock(dir, { pid = process.pid, now = Date.now() } = {}) {
  const l = readJSON(paths(dir).lock, null);
  if (l && l.pid === pid) atomicWrite(paths(dir).lock, { ...l, ts: now });
}
export function releaseLock(dir, { pid = process.pid } = {}) {
  const file = paths(dir).lock;
  const l = readJSON(file, null);
  if (l && l.pid === pid) { try { fs.unlinkSync(file); } catch { /* gone */ } }
}

// ---------------------------------------------------------------- command queue (CLI/control -> engine)
let cmdSeq = 0;
export function enqueueCommand(dir, cmd, clock = realClock) {
  const d = ensureDir(paths(dir).commands);
  const name = `${String(clock.now()).padStart(15, '0')}-${String(cmdSeq++ % 1e6).padStart(6, '0')}-${crypto.randomBytes(3).toString('hex')}.json`;
  atomicWrite(path.join(d, name), { ...cmd, queued_at: iso(clock.now()) });
  return name;
}
export function drainCommands(dir) {
  const d = paths(dir).commands;
  let names = [];
  try { names = fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const f = path.join(d, n);
    const c = readJSON(f, null);
    try { fs.unlinkSync(f); } catch { /* raced */ }
    if (c && typeof c.cmd === 'string') out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------- goal creation
export const DEFAULT_BUDGETS = { max_new_tokens: 2000000, max_parallel: 3, max_attempts: 3, max_tasks: 12,
  task_wall_clock_s: 900, approval_ttl_s: 86400, stall_after_s: 300, max_turns: 30, attempt_usd_cap: 2 };

export function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'goal'; }

/**
 * Build goal.json (+ empty tasks/agents/heartbeat) from a user-written spec. Throws Error with a readable message
 * when the spec is invalid. `spec.orch.repo` must be a git work tree (checked by the caller via git.mjs).
 */
export function normalizeGoalSpec(spec, { clock = realClock } = {}) {
  if (!spec || typeof spec !== 'object') throw new Error('goal spec must be an object');
  const ts = iso(clock.now());
  const id = spec.id || `g-${ts.slice(0, 10).replace(/-/g, '')}-${slug(spec.title || 'goal')}`;
  if (!ID_RE.test(id)) throw new Error(`invalid goal id "${id}"`);
  if (typeof spec.title !== 'string' || !spec.title.trim()) throw new Error('goal.title is required');
  const o = spec.orch || {};
  if (typeof o.repo !== 'string' || !path.isAbsolute(o.repo)) throw new Error('goal.orch.repo must be an absolute path');
  const criteria = (spec.success_criteria || []).map((c, i) => ({ id: c.id || `c${i + 1}`, text: c.text || '', met: false,
    ...(c.check ? { check: c.check } : {}), ...(c.requires ? { requires: c.requires } : {}) }));
  if (!criteria.length) throw new Error('goal.success_criteria needs at least one criterion');
  for (const c of criteria) {
    if (c.check && (!Array.isArray(c.check.argv) || !c.check.argv.length || !(c.check.timeout_s > 0))) throw new Error(`criterion ${c.id}: check needs argv[] and timeout_s > 0`);
  }
  const budget = { max_ticks: 500, max_usd: 5, max_wall_clock_s: 7200, ...(spec.budget || {}) };
  if (!(budget.max_ticks >= 1) || !(budget.max_wall_clock_s >= 1) || !(budget.max_usd >= 0)) throw new Error('goal.budget is invalid (mandatory per SPEC section 7)');
  const goal = {
    id, title: spec.title, description: spec.description || '', status: 'draft', success_criteria: criteria, budget,
    created_at: ts, updated_at: ts,
    orch: {
      repo: o.repo, base_branch: o.base_branch || 'main', base_commit: o.base_commit || null,
      integration_branch: `aos/${id}/integration`, worktree_root: null,
      budgets: { ...DEFAULT_BUDGETS, ...(o.budgets || {}) },
      approval_policy: { plan: 'required', outside_allowlist: 'ask', dangerous: 'deny', ...(o.approval_policy || {}) },
      policy: o.policy || 'policy.default.json',
      check_allowlist: o.check_allowlist || null,
      governor: o.governor || {},
      usage: { new_tokens: 0, cache_read_tokens: 0, notional_usd: 0, workers_started: 0 },
      plan_state: spec.plan ? 'supplied' : 'none', plan_session_id: null, paused_reason: null, halt_reason: null,
      started_ms: null, reported: false, created_branches: [],
    },
  };
  const errs = validateGoal(goal);
  if (errs.length) throw new Error(`goal invalid: ${errs.join('; ')}`);
  return goal;
}

/** Create the goal directory and initial files. Refuses to overwrite an existing goal. */
export function createGoalDir(orch, goal, plan = null) {
  const dir = goalDirOf(orch, goal.id);
  if (fs.existsSync(paths(dir).goal)) throw new Error(`goal ${goal.id} already exists at ${dir}`);
  ensureDir(dir);
  const P = paths(dir);
  for (const d of [P.approvals, P.workers, P.commands, P.tmp]) ensureDir(d);
  saveState(dir, { goal, tasks: [], agents: [] });
  if (plan) atomicWrite(P.plan, { source: 'supplied', plan });
  return dir;
}

export function checkTasks(tasks) {
  return tasks.flatMap((t) => validateTask(t).map((e) => `${t.id}: ${e}`));
}
