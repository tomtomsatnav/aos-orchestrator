// Multi-goal supervisor (design section 4 "Concurrency and ordering"): one process owns many goals, one engine tick loop per
// goal, a GLOBAL worker semaphore with least-running-first fairness, the shared plan-usage governor (governor.json is already
// shared by every engine; the gate also checks it), graceful shutdown and crash-safe restart (goals are re-adopted from disk;
// orphaned workers are handled by the engine's own adopt/lost logic). The control server only calls the methods below.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, createGoal } from './engine.mjs';
import { TERMINAL, ID_RE, orchRoot, goalsRoot, goalDirOf, paths, readJSON, loadState, loadHeartbeat, enqueueCommand, realClock, ensureDir,
  validateBudgetPatch, appendEvent } from './state.mjs';
import { Governor, checkBudgets } from './governor.mjs';
import * as G from './git.mjs';
import * as W from './worker.mjs';
import { listApprovals, decide } from './approvals.mjs';
import { planHash, tasksHash, sha256 } from './plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Typed error the control server maps to an HTTP status. */
export class SupervisorError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

/** Repo must exist, be a git work tree, and not be inside ~/.claude, the orchestrator state dir or the orchestrator source. Returns the git root. */
export async function validateRepo(repo, { orchDir, home = os.homedir() } = {}) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo) || repo.length > 1024 || repo.includes('\0')) throw new SupervisorError(400, 'invalid_repo', 'repo must be an absolute path');
  let real;
  try { real = fs.realpathSync(repo); if (!fs.statSync(real).isDirectory()) throw new Error('not a directory'); } catch { throw new SupervisorError(422, 'invalid_repo', 'repo does not exist or is not a directory'); }
  const forbidden = [path.join(home, '.claude'), orchDir, path.resolve(HERE, '..')].filter(Boolean).map((p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } });
  if (forbidden.some((f) => inside(real, f))) throw new SupervisorError(422, 'forbidden_repo', 'repo is inside ~/.claude or the orchestrator directory');
  let info;
  try { info = await G.repoInfo(real, 'HEAD'); } catch { throw new SupervisorError(422, 'invalid_repo', 'repo is not a git repository (or has no commits)'); }
  if (forbidden.some((f) => inside(info.root, f))) throw new SupervisorError(422, 'forbidden_repo', 'repo is inside ~/.claude or the orchestrator directory');
  return info.root;
}

/** Global worker semaphore. Fairness: a goal may take a free slot only if no other goal that was recently denied has fewer running. */
class SlotGate {
  constructor(sup) { this.sup = sup; this.reserved = new Map(); this.demand = new Map(); this.closed = false; }
  _count(goalId) { return (this.sup.handles.get(goalId)?.engine.workers.size || 0) + (this.reserved.get(goalId) || 0); }
  total() { let n = 0; for (const h of this.sup.handles.values()) n += h.engine.workers.size; for (const v of this.reserved.values()) n += v; return n; }
  acquire(goalId) {
    if (this.closed) return null;
    const now = this.sup.clock.now();
    let g; try { g = this.sup.governor.evaluate(now); } catch { g = { dispatch: true }; }
    if (!g.dispatch) return null;
    if (this.total() >= this.sup.maxWorkers) { this.demand.set(goalId, now); return null; }
    const mine = this._count(goalId);
    for (const [other, at] of this.demand) if (other !== goalId && (now - at > this.sup.demandTtlMs || !this.sup.handles.has(other))) this.demand.delete(other);
    // another goal wants a slot if it was recently denied one, or has a dispatchable (ready) task right now
    const wanting = new Set(this.demand.keys()); wanting.delete(goalId);
    for (const [other, h] of this.sup.handles) if (other !== goalId && !wanting.has(other) && this._hasReady(h)) wanting.add(other);
    for (const other of wanting) if (this._count(other) < mine) { this.demand.set(goalId, now); return null; }
    this.demand.delete(goalId);
    this.reserved.set(goalId, (this.reserved.get(goalId) || 0) + 1);
    return { goalId };
  }
  _hasReady(h) {
    try {
      const g = readJSON(h.engine.P.goal); if (!g || g.status !== 'active' || g.orch.halt_reason || loadHeartbeat(h.engine.dir).status === 'paused') return false;
      return (readJSON(h.engine.P.tasks, []) || []).some((t) => t.status === 'ready');
    } catch { return false; }
  }
  release(tok) {
    if (!tok || !tok.goalId) return;
    const n = (this.reserved.get(tok.goalId) || 0) - 1;
    if (n > 0) this.reserved.set(tok.goalId, n); else this.reserved.delete(tok.goalId);
  }
  hasDemand() { const now = this.sup.clock.now(); for (const at of this.demand.values()) if (now - at <= this.sup.demandTtlMs) return true; return false; }
}

export class Supervisor {
  /**
   * @param {object} o orchDir, env, clock, maxWorkers (default config max_workers_global or 3), intervalMs, pollMs, scanMs, demandTtlMs,
   *   spawnFn, claudeBin, pid, engineOpts (extra Engine options: killGraceMs, budgetGraceMs, plannerTimeoutMs, hookScript, sandboxBin ...)
   */
  constructor(o = {}) {
    this.env = o.env || process.env;
    this.orchDir = o.orchDir || orchRoot(this.env);
    this.clock = o.clock || realClock;
    const cfg = readJSON(path.join(this.orchDir, 'config.json'), {}) || {};
    const mw = o.maxWorkers ?? cfg.max_workers_global ?? 3;
    this.maxWorkers = Number.isInteger(mw) && mw >= 1 && mw <= 64 ? mw : 3;
    this.intervalMs = o.intervalMs ?? 10000;
    this.pollMs = o.pollMs ?? this.intervalMs;
    this.scanMs = o.scanMs ?? 2000;
    this.demandTtlMs = o.demandTtlMs ?? Math.max(3000, this.pollMs * 3);
    this.pid = o.pid; this.spawnFn = o.spawnFn; this.claudeBin = o.claudeBin; this.engineOpts = o.engineOpts || {};
    this.handles = new Map(); // goal id -> {engine, stopped, wake, loop}
    this.gate = new SlotGate(this);
    this.governor = new Governor(this.orchDir);
    this.running = false; this._scanTimer = null; this.draining = false;
    ensureDir(this.orchDir); ensureDir(goalsRoot(this.orchDir));
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    if (this.running) return this;
    this.running = true;
    await this.scan();
    this._scanTimer = setInterval(() => { this.scan().catch(() => {}); }, this.scanMs);
    this._scanTimer.unref?.();
    return this;
  }

  goalIds() { try { return fs.readdirSync(goalsRoot(this.orchDir)).filter((n) => ID_RE.test(n) && fs.existsSync(paths(goalDirOf(this.orchDir, n)).goal)); } catch { return []; } }

  /** Adopt every non-terminal goal on disk (restart recovery, goals created by the CLI). Goals owned by another live engine are retried later. */
  async scan() {
    if (!this.running || this.draining) return;
    for (const id of this.goalIds()) {
      const h = this.handles.get(id);
      const g = readJSON(paths(goalDirOf(this.orchDir, id)).goal);
      if (!g || TERMINAL.has(g.status)) { if (h && h.idle) await this._release(id); continue; }
      if (!h) await this._attach(id);
    }
  }

  async _attach(id) {
    if (this.handles.has(id)) return this.handles.get(id);
    const engine = new Engine({ goalDir: goalDirOf(this.orchDir, id), orchDir: this.orchDir, env: this.env, clock: this.clock, intervalMs: this.intervalMs,
      pid: this.pid, spawnFn: this.spawnFn, claudeBin: this.claudeBin, slotGate: this.gate, ...this.engineOpts });
    try { await engine.start(); } catch { return null; } // owned by another live engine
    const h = { id, engine, stopped: false, idle: false, wakeFn: null };
    h.wake = () => { const f = h.wakeFn; h.wakeFn = null; if (f) f(); };
    this.handles.set(id, h);
    h.loop = this._loop(h).catch(() => {});
    return h;
  }

  async _loop(h) {
    const { engine } = h;
    while (!h.stopped && !engine.dead) {
      try { await engine.tick(); } catch { /* engine records heartbeat errors itself */ }
      if (h.stopped || engine.dead) break;
      // a freed slot may belong to another goal that was denied: let those tick now
      if (this.gate.hasDemand() && this.gate.total() < this.maxWorkers) for (const o of this.handles.values()) if (o !== h) o.wake();
      const g = readJSON(engine.P.goal);
      if (!g || TERMINAL.has(g.status)) { h.idle = true; break; }
      if (engine.isDone()) { h.idle = true; await new Promise((res) => { h.wakeFn = res; }); h.idle = false; continue; }
      await new Promise((res) => { const t = setTimeout(res, this.pollMs); h.wakeFn = () => { clearTimeout(t); res(); }; engine._wakeFn = h.wakeFn; });
    }
    if (!h.stopped && !engine.dead) await this._release(h.id);
  }

  async _release(id) {
    const h = this.handles.get(id);
    if (!h) return;
    this.handles.delete(id); h.stopped = true; h.wake();
    await h.engine.stop().catch(() => {});
  }

  /**
   * Graceful shutdown (SIGTERM): stop dispatching, then `workers`: 'drain' (default: let running workers finish for up to drainMs,
   * then kill the rest), 'kill' (kill at once) or 'leave' (leave them; the next supervisor re-adopts them). State stays resumable:
   * killed workers are requeued as `lost` (not counted) by the next start.
   */
  async stop({ workers = 'drain', drainMs = 30000 } = {}) {
    this.draining = true; this.gate.closed = true; clearInterval(this._scanTimer);
    if (workers === 'drain') {
      const end = Date.now() + drainMs;
      while (Date.now() < end && this.gate.total() > 0) { for (const h of this.handles.values()) h.wake(); await sleep(50); }
    }
    for (const h of [...this.handles.values()]) {
      h.stopped = true; h.wake();
      await h.loop?.catch(() => {});
      await h.engine._chain.catch(() => {});
      if (workers !== 'leave') await Promise.all([...h.engine.workers.values()].map((r) => W.killGroup(r.pgid, { graceMs: this.engineOpts.killGraceMs ?? 3000 })));
      await h.engine.stop().catch(() => {});
    }
    this.handles.clear(); this.running = false;
  }

  /** Simulate a hard crash (tests): loops stop, locks and workers stay exactly as they are. */
  crash() {
    clearInterval(this._scanTimer); this.running = false;
    for (const h of this.handles.values()) { h.stopped = true; h.engine.crash(); h.wake(); }
    this.handles.clear();
  }

  // ------------------------------------------------------------------ reads
  dirOf(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new SupervisorError(400, 'invalid_id', 'invalid goal id');
    const d = goalDirOf(this.orchDir, id);
    if (!fs.existsSync(paths(d).goal)) throw new SupervisorError(404, 'not_found', 'no such goal');
    return d;
  }
  state(id) { const d = this.dirOf(id); const S = loadState(d); return { dir: d, S, hb: loadHeartbeat(d) }; }
  workerCount() { return this.gate.total(); }
  governorState() { try { return { ...this.governor.evaluate(this.clock.now()), raw: this.governor.load() }; } catch { return { dispatch: true, paused: false, raw: {} }; } }
  /** The hash a human approves: binds plan.json and the engine's task commands/scopes. */
  reviewHash(id) {
    const { dir, S } = this.state(id);
    if (!S.tasks.length) return null;
    const ph = planHash(readJSON(paths(dir).plan)?.plan ?? null); const th = tasksHash(S.tasks);
    return { combined: sha256(`${ph}:${th}`), plan_hash: ph, tasks_hash: th };
  }

  allApprovals() {
    const out = [];
    for (const id of this.goalIds()) for (const a of listApprovals(paths(goalDirOf(this.orchDir, id)).approvals)) out.push({ goal: id, ...a });
    return out;
  }

  // ------------------------------------------------------------------ mutations
  async createGoal(spec) {
    const made = await createGoal(this.orchDir, spec, { clock: this.clock });
    if (this.running) await this._attach(made.goal.id);
    return made;
  }

  /** Queue a command for the goal's engine, wake its loop and wait (bounded) until it was applied. */
  async _command(id, cmd) {
    const { dir } = this.state(id);
    enqueueCommand(dir, cmd, this.clock);
    let h = this.handles.get(id);
    if (!h && this.running) h = await this._attach(id);
    if (!h) return false; // no engine here (another process owns the goal): applied by that engine
    h.wake();
    const q = paths(dir).commands;
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      let pending = 0; try { pending = fs.readdirSync(q).filter((n) => n.endsWith('.json')).length; } catch { /* none */ }
      if (!pending) { await h.engine._chain.catch(() => {}); return true; }
      h.wake(); await sleep(15);
    }
    return false;
  }

  async pause(id, by) {
    const { S } = this.state(id);
    if (TERMINAL.has(S.goal.status)) throw new SupervisorError(409, 'invalid_state', `goal is ${S.goal.status}`);
    return this._command(id, { cmd: 'pause', by });
  }
  async resume(id, by) {
    const { S, dir } = this.state(id);
    const g = S.goal;
    if (TERMINAL.has(g.status)) throw new SupervisorError(409, 'invalid_state', `goal is ${g.status}`);
    if (g.status === 'blocked') {
      if (!String(g.orch.halt_reason || '').startsWith('budget')) throw new SupervisorError(409, 'not_resumable', 'only goals blocked by a budget cap can be resumed (raise the budget first)');
      const b = checkBudgets(g, { nowMs: this.clock.now(), seq: loadHeartbeat(dir).seq, inflightTokens: 0 });
      if (b.hard.length) throw new SupervisorError(409, 'budget_exceeded', `budget still exceeded: ${b.hard.join('; ')}`);
    }
    return this._command(id, { cmd: 'resume', by });
  }
  async cancel(id, by, kind = 'cancel') {
    const { S } = this.state(id);
    if (TERMINAL.has(S.goal.status)) throw new SupervisorError(409, 'invalid_state', `goal is ${S.goal.status}`);
    return this._command(id, { cmd: kind, by });
  }
  kill(id, by) { return this.cancel(id, by, 'kill'); }

  async setBudgets(id, patch, by) {
    const v = validateBudgetPatch(patch);
    if (!v.ok) throw new SupervisorError(400, 'invalid_budgets', v.errors.join('; '));
    const { S } = this.state(id);
    if (TERMINAL.has(S.goal.status)) throw new SupervisorError(409, 'invalid_state', `goal is ${S.goal.status}`);
    return this._command(id, { cmd: 'budgets', patch: v.patch, by });
  }

  async approvePlan(id, planHashCombined, by) {
    const { S } = this.state(id);
    if (S.goal.orch.plan_state !== 'awaiting_approval') throw new SupervisorError(409, 'invalid_state', 'the plan is not awaiting approval');
    const cur = this.reviewHash(id);
    if (!cur || cur.combined !== planHashCombined) throw new SupervisorError(409, 'plan_changed', 'plan_hash does not match the current plan; re-review it');
    const ok = await this._command(id, { cmd: 'approve-plan', by, reviewed: { plan_hash: cur.plan_hash, tasks_hash: cur.tasks_hash } });
    return ok;
  }
  async rejectPlan(id, by) {
    const { S } = this.state(id);
    if (S.goal.orch.plan_state !== 'awaiting_approval') throw new SupervisorError(409, 'invalid_state', 'the plan is not awaiting approval');
    return this._command(id, { cmd: 'reject-plan', by });
  }

  decideApproval(goalId, approvalId, decision, scope, by) {
    const { dir } = this.state(goalId);
    const ad = paths(dir).approvals;
    try { const rec = decide(ad, approvalId, { decision, scope, by }, this.clock); this.handles.get(goalId)?.wake(); return rec; } catch (e) {
      if (/no such approval/.test(e.message)) throw new SupervisorError(404, 'not_found', 'no such approval');
      throw new SupervisorError(409, 'invalid_state', e.message.replace(/[A-Za-z0-9_-]+~/, ''));
    }
  }

  /** Append an audit Event (type human.note, actor 'control') to the goal's log. */
  audit(goalId, action, data) {
    try { return appendEvent(goalDirOf(this.orchDir, goalId), { type: 'human.note', actor: 'control', goal_id: goalId, data: { audit: true, action, ...data } }, this.clock); } catch { return null; }
  }
}
