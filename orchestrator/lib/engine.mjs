// The AOS-1 heartbeat engine for one goal (design sections 3-5, 8). No LLM in the control loop: every state change is
// code + an Event, all state is on disk, ticks are idempotent, workers are separate process groups that a fresh
// engine can re-adopt after a crash. Tick order (SPEC section 4): Beat, Observe, Reap, Verify, Plan, Dispatch, Budget, Emit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  TERMINAL, paths, ensureDir, readJSON, atomicWrite, iso, realClock, loadState, saveState, loadHeartbeat, appendEvent, readEvents,
  acquireLock, touchLock, releaseLock, drainCommands, enqueueCommand, pidAlive, goalDirOf, orchRoot, applyBudgetPatch, validateBudgetPatch,
} from './state.mjs';
import * as G from './git.mjs';
import { runChecks, runCheck, checkEnv, tail } from './checks.mjs';
import { matchAny, scopesOverlap } from './glob.mjs';
import { mergePolicy, DEFAULT_POLICY, isProtectedRel } from './policy.mjs';
import { realpathDeepest } from './policy-hook.mjs';
import * as W from './worker.mjs';
import { Governor, detectLimitFailure, checkBudgets, usageOf } from './governor.mjs';
import { buildPlannerPrompt, gatherRepoFacts, extractJson, validatePlan, toTasks, TIERS, humanReviewReason, planHash, tasksHash, reviewView } from './plan.mjs';
import { scanRepoConfig, INSTRUCTION_FILES, sha256Buf, formatFindings, instructionNotice } from './repo-config.mjs';
import { sandboxAvailable, SANDBOX_EXEC } from './sandbox.mjs';
import { listApprovals, expireDue, readApproval } from './approvals.mjs';
import { buildReport } from './report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.join(HERE, 'policy-hook.mjs');
const backoffS = (interval, errors) => Math.min(interval * 2 ** Math.min(errors || 0, 20), 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Engine {
  /**
   * @param {object} o  goalId|goalDir, orchDir, clock{now()}, intervalMs, killGraceMs, budgetGraceMs, plannerTimeoutMs,
   *                    pid (lock owner id; tests use a fake one to simulate a crashed engine), env, spawnFn, claudeBin
   */
  constructor(o) {
    this.orchDir = o.orchDir || orchRoot(o.env || process.env);
    this.dir = o.goalDir || goalDirOf(this.orchDir, o.goalId);
    this.P = paths(this.dir);
    this.clock = o.clock || realClock;
    this.env = o.env || process.env;
    this.intervalMs = o.intervalMs ?? 10000;
    this.killGraceMs = o.killGraceMs ?? 10000;
    this.budgetGraceMs = o.budgetGraceMs ?? 60000;
    this.plannerTimeoutMs = o.plannerTimeoutMs ?? 300000;
    this.pid = o.pid ?? process.pid;
    this.spawnFn = o.spawnFn;
    this.slotGate = o.slotGate || null; // supervisor: global worker semaphore {acquire(goalId)->token|null, release(token)}
    this.sandboxBin = o.sandboxBin || SANDBOX_EXEC; // tests may point this at a missing binary
    this.hookScript = o.hookScript || HOOK_SCRIPT; // tests may substitute a stub hook
    this.lockRefreshMs = o.lockRefreshMs ?? null; // default: a third of the lock TTL
    this.bin = o.claudeBin || W.claudeBin(this.env);
    this.workers = new Map(); // task id -> live worker record (in memory; rebuilt from pid files after a crash)
    this.gov = null;
    this.dead = false; this.stopped = false; this.started = false; this._inTick = false; this._wakeFn = null; this._chain = Promise.resolve();
  }

  // ------------------------------------------------------------------ helpers
  now() { return this.clock.now(); }
  ev(type, actor, task_id, data) { return appendEvent(this.dir, { type, actor: actor || 'orchestrator', goal_id: this.goalId, task_id: task_id ?? null, data }, this.clock); }
  _wake() { if (this._wakeFn) { const f = this._wakeFn; this._wakeFn = null; f(); } }
  get goalId() { return this._goalId ??= readJSON(this.P.goal)?.id ?? path.basename(this.dir); }
  wpath(task, seq, ext) { return path.join(this.P.workers, `${task}.${seq}.${ext}`); }
  lockTtlMs() { return Math.max(60000, this.intervalMs * 3); }

  // ------------------------------------------------------------------ lifecycle
  /** Take the per-goal lock. Throws when another live engine owns the goal. */
  async start() {
    if (this.started) return this;
    const l = acquireLock(this.dir, { pid: this.pid, ttlMs: this.lockTtlMs(), now: Date.now() });
    if (!l.ok) throw new Error(`goal ${this.goalId} is already owned by engine pid ${l.holder?.pid}`);
    this.started = true;
    // keep the lock fresh while a long tick (checks up to 3600 s, merges, kills) is in progress: a stale-looking lock
    // would let a second engine take the goal over and verify/merge/dispatch the same tasks concurrently
    clearInterval(this._lockTimer);
    this._lockTimer = setInterval(() => { if (!this.dead && this.started) touchLock(this.dir, { pid: this.pid, now: Date.now() }); }, this.lockRefreshMs ?? Math.floor(this.lockTtlMs() / 3));
    this._lockTimer.unref?.();
    for (const d of [this.P.approvals, this.P.workers, this.P.commands, this.P.tmp]) ensureDir(d);
    this.gov = new Governor(this.orchDir, readJSON(this.P.goal)?.orch?.governor || {});
    atomicWrite(path.join(this.P.workers, 'settings.json'), W.buildSettings(this.hookScript));
    if (!fs.existsSync(this.P.policyDefault)) { try { atomicWrite(this.P.policyDefault, DEFAULT_POLICY); } catch { /* read-only orch dir */ } }
    if (readJSON(this.P.goal)?.orch?.unsandboxed_checks) this.ev('orch.sandbox.disabled', 'orchestrator', null, { warning: 'unsandboxed_checks is set: acceptance checks run worker-written code WITHOUT the OS sandbox' });
    if (l.takeover) this.ev('orch.lock.broken', 'orchestrator', null, { note: 'stale engine lock taken over' });
    return this;
  }

  /** Release the lock; workers keep running (a later engine re-adopts them). */
  async stop() { this.stopped = true; this._wake(); await this._chain.catch(() => {}); clearInterval(this._lockTimer); releaseLock(this.dir, { pid: this.pid }); this.started = false; }

  /** Simulate a hard crash: stop everything in this process, leave lock + workers + files exactly as they are. */
  crash() { this.dead = true; this.stopped = true; clearInterval(this._lockTimer); this.workers.clear(); this._wake(); }

  isDone() {
    const g = readJSON(this.P.goal);
    if (!g) return true;
    if (TERMINAL.has(g.status)) return true;
    if (g.status === 'blocked') return this.workers.size === 0;
    if (g.status === 'draft' && g.orch.plan_state === 'awaiting_approval') return true;
    return false;
  }

  /** Tick until the goal ends (or awaits plan approval, or stop()/crash()). Returns final goal status. */
  async run({ pollMs = this.intervalMs } = {}) {
    await this.start();
    while (!this.stopped && !this.dead) {
      let r; try { r = await this.tick(); } catch { r = { error: true }; }
      if (this.isDone()) break;
      const wait = r && r.error ? backoffS(this.intervalMs / 1000, loadHeartbeat(this.dir).consecutive_errors) * 1000 : pollMs;
      await Promise.race([sleep(wait), new Promise((res) => { this._wakeFn = res; })]);
    }
    return readJSON(this.P.goal)?.status;
  }

  /** One tick (serialised). Never overlaps; a concurrent call emits heartbeat.skipped. */
  tick() {
    if (this.dead) return Promise.resolve({ dead: true });
    if (this._inTick) { this.ev('heartbeat.skipped', 'orchestrator', null, { reason: 'previous tick still running' }); return Promise.resolve({ skipped: 'overlap' }); }
    this._inTick = true;
    const p = this._chain.then(() => this._tickGuarded()).finally(() => { this._inTick = false; });
    this._chain = p.catch(() => {});
    return p;
  }

  /** Human commands that must act immediately (kill switch). Also queued via CLI when no engine is attached. */
  async command(cmd) {
    enqueueCommand(this.dir, cmd, this.clock);
    if (cmd.cmd === 'cancel' || cmd.cmd === 'kill') await this._chain.catch(() => {});
    return this.tick();
  }

  async _tickGuarded() {
    if (!this.started) await this.start();
    const t0 = Date.now();
    try { return await this._tick(t0); } catch (err) {
      const h = loadHeartbeat(this.dir);
      h.consecutive_errors = (h.consecutive_errors || 0) + 1; h.last_tick_ms = Date.now() - t0;
      atomicWrite(this.P.hb, h);
      this.ev('heartbeat.tick', 'orchestrator', null, { seq: h.seq, ok: false, error: String(err?.message || err), consecutive_errors: h.consecutive_errors,
        next_delay_s: backoffS(this.intervalMs / 1000, h.consecutive_errors) });
      return { error: String(err?.message || err) };
    }
  }

  // ------------------------------------------------------------------ the tick
  async _tick(t0) {
    const P = this.P;
    let S = loadState(this.dir);
    if (!S.goal) throw new Error('no goal.json');
    let goal = S.goal;
    let o = goal.orch;
    let hb = loadHeartbeat(this.dir);
    if (TERMINAL.has(goal.status)) { if (hb.status !== 'stopped') atomicWrite(P.hb, { ...hb, status: 'stopped' }); return { stopped: true, goal: goal.status }; }
    touchLock(this.dir, { pid: this.pid, now: Date.now() });

    // 1. Beat
    const now = this.now();
    const intervalS = this.intervalMs / 1000;
    const expectedMs = backoffS(intervalS, hb.consecutive_errors) * 1000;
    const gap = hb.ts ? now - Date.parse(hb.ts) : 0;
    const seq = hb.seq + 1;
    hb = { ...hb, seq, ts: iso(now), interval_s: Math.max(1, intervalS), liveness: 'alive' };
    if (hb.status === 'stopped') hb.status = 'running';
    atomicWrite(P.hb, hb);
    if (seq > 1 && gap > 3 * expectedMs && expectedMs >= 1000) this.ev('heartbeat.dead', 'orchestrator', null, { gap_s: Math.round(gap / 1000), expected_s: expectedMs / 1000 });
    else if (seq > 1 && gap > 1.5 * expectedMs && expectedMs >= 1000) this.ev('heartbeat.late', 'orchestrator', null, { gap_s: Math.round(gap / 1000), expected_s: expectedMs / 1000 });

    // 2. Observe: drain human commands
    await this._observe(S);
    S = loadState(this.dir); goal = S.goal; o = goal.orch; // S was reloaded: `o` must follow it, or halt_reason set later in this tick is invisible to the dispatch gate
    if (TERMINAL.has(goal.status)) return { goal: goal.status, seq };
    hb = loadHeartbeat(this.dir);

    // 3. Reap (also approvals, governor bookkeeping)
    this._governorStep(S);
    this._approvals(S); // before reap: a grant decided while the hook waited must count when the attempt is verified
    await this._reap(S);
    this._approvals(S);

    // 4. Verify
    await this._verify(S);
    if (TERMINAL.has(goal.status)) { saveState(this.dir, S); await this._finalize(S); return { goal: goal.status, seq }; }

    // 5. Plan (once)
    if (['draft', 'active'].includes(goal.status) && ['none', 'supplied', 'planning'].includes(o.plan_state)) await this._plan(S);
    if (TERMINAL.has(goal.status) || goal.status === 'blocked') { saveState(this.dir, S); if (goal.status === 'blocked' && !this.workers.size) await this._finalize(S); return { goal: goal.status, seq }; }

    // 6./7. Budget then Dispatch
    const paused = hb.status === 'paused';
    if (goal.status === 'active') {
      this._promote(S);
      this._budgets(S, seq);
      if (!paused && !o.halt_reason) { this._governorStep(S); await this._dispatch(S); }
    }

    // halted goals end as blocked once nothing is running
    if (goal.status === 'active' && o.halt_reason && !this.workers.size && !S.tasks.some((t) => t.status === 'running')) {
      goal.status = 'blocked'; goal.blocked_reason = o.halt_reason;
      this.ev('goal.blocked', 'orchestrator', null, { reason: o.halt_reason });
    }
    // nothing can ever run again (all remaining tasks wait on failed ones / nothing ready): blocked
    if (goal.status === 'active' && !o.halt_reason) this._stuckCheck(S);

    goal.updated_at = iso(this.now());
    saveState(this.dir, S);
    if (goal.status === 'blocked' && !this.workers.size) await this._finalize(S);

    // 8. Emit
    const counts = {};
    for (const t of S.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
    const ms = Date.now() - t0;
    atomicWrite(P.hb, { ...loadHeartbeat(this.dir), last_tick_ms: ms, consecutive_errors: 0, status: TERMINAL.has(goal.status) ? 'stopped' : loadHeartbeat(this.dir).status });
    this.ev('heartbeat.tick', 'orchestrator', null, { seq, ok: true, ms, goal_status: goal.status, tasks: counts, running: this.workers.size,
      new_tokens: o.usage.new_tokens, governor: this.gov.load().pause?.reason || null, paused: hb.status === 'paused' });
    return { seq, goal_status: goal.status, tasks: counts, ms };
  }

  // ------------------------------------------------------------------ observe: commands
  async _observe(S) {
    const cmds = drainCommands(this.dir);
    for (const c of cmds) {
      const hb = loadHeartbeat(this.dir);
      const goal = S.goal;
      switch (c.cmd) {
        case 'pause': atomicWrite(this.P.hb, { ...hb, status: 'paused' }); this.ev('human.pause', 'human', null, { by: c.by || 'cli' }); break;
        case 'resume':
          atomicWrite(this.P.hb, { ...hb, status: 'running' }); this.gov.resume(this.now());
          this.ev('human.resume', 'human', null, { by: c.by || 'cli' });
          if (goal.status === 'blocked') this._unblock(S);
          break;
        case 'budgets': {
          const v = validateBudgetPatch(c.patch);
          if (!v.ok) { this.ev('orch.budgets.refused', 'orchestrator', null, { errors: v.errors }); break; }
          applyBudgetPatch(goal, S.tasks, v.patch); saveState(this.dir, S);
          this.ev('orch.budgets.updated', 'human', null, { by: c.by || 'cli', patch: v.patch });
          break;
        }
        case 'approve-plan':
          if (goal.orch.plan_state === 'awaiting_approval') { this._activate(S, 'human', c.reviewed); saveState(this.dir, S); }
          break;
        case 'reject-plan':
          if (goal.orch.plan_state === 'awaiting_approval') {
            goal.orch.plan_state = 'rejected'; goal.status = 'blocked'; goal.blocked_reason = 'plan rejected by human';
            this.ev('orch.plan.rejected', 'human', null, { by: c.by || 'cli' }); this.ev('goal.blocked', 'orchestrator', null, { reason: goal.blocked_reason });
            saveState(this.dir, S); await this._finalize(S);
          }
          break;
        case 'cancel': case 'kill': await this._cancel(S, c.cmd, c.by || 'cli'); return;
        default: this.ev('human.note', 'human', null, { note: `ignored unknown command ${String(c.cmd).slice(0, 40)}` });
      }
    }
  }

  /** Resume a goal that stopped on a budget cap, once the caps were raised. Other blocks (failed task, rejected plan) stay blocked. */
  _unblock(S) {
    const goal = S.goal; const o = goal.orch;
    if (!String(o.halt_reason || '').startsWith('budget')) { this.ev('orch.resume.refused', 'orchestrator', null, { reason: 'not blocked by a budget cap', blocked_reason: goal.blocked_reason || null }); return false; }
    const b = checkBudgets(goal, { nowMs: this.now(), seq: loadHeartbeat(this.dir).seq, inflightTokens: 0 });
    if (b.hard.length) { this.ev('orch.resume.refused', 'orchestrator', null, { reason: 'budget still exceeded', hard: b.hard }); return false; }
    goal.status = 'active'; delete goal.blocked_reason; o.halt_reason = null; o.halt_at_ms = null; o.reported = false; o.soft = b.soft;
    goal.updated_at = iso(this.now());
    this.ev('orch.goal.unblocked', 'human', null, { previous: 'blocked' }); this.ev('goal.updated', 'orchestrator', null, { status: 'active' });
    saveState(this.dir, S);
    return true;
  }

  /** Current fingerprint of what a human approves: the stored plan and the engine's task commands/scopes. */
  _fingerprint(S) { return { plan_hash: planHash(readJSON(this.P.plan)?.plan ?? null), tasks_hash: tasksHash(S.tasks) }; }

  /** Activate the goal. The approval record stores the plan hash; a human approval of an edited plan is refused. */
  _activate(S, who, reviewed = null) {
    const goal = S.goal;
    const cur = this._fingerprint(S); const pending = goal.orch.plan_fingerprint;
    const stale = !pending || pending.plan_hash !== cur.plan_hash || pending.tasks_hash !== cur.tasks_hash
      || (reviewed && (reviewed.plan_hash !== cur.plan_hash || reviewed.tasks_hash !== cur.tasks_hash));
    if (stale) {
      this.ev('orch.plan.approval_refused', 'orchestrator', null, { by: who, reason: 'the plan changed since it was proposed or reviewed; re-review it', current: cur.plan_hash.slice(0, 12) });
      return false;
    }
    goal.orch.plan_approval = { by: who, at: iso(this.now()), ...cur, has_commands: !!humanReviewReason(S.tasks) };
    goal.status = 'active'; goal.orch.plan_state = 'approved'; goal.orch.started_ms ??= this.now();
    this.ev('orch.plan.approved', who === 'human' ? 'human' : 'orchestrator', null, { by: who, plan_hash: cur.plan_hash.slice(0, 12) });
    if (who === 'human') this.ev('human.approve', 'human', null, { what: 'plan' });
    this.ev('goal.updated', 'orchestrator', null, { status: 'active' });
    return true;
  }

  /** Every dispatch/verify re-checks that the approved plan is still the plan on disk. Fail closed: no approval record = no dispatch. */
  _planIntact(S) {
    const o = S.goal.orch; const a = o.plan_approval;
    const cur = this._fingerprint(S);
    const ok = !!a && a.plan_hash === cur.plan_hash && a.tasks_hash === cur.tasks_hash;
    if (!ok && !o.halt_reason) {
      o.halt_reason = a ? 'plan modified after approval: dispatch refused (plan.json or the task commands/scopes changed)' : 'no plan approval record: dispatch refused';
      o.halt_at_ms = this.now();
      this.ev('orch.plan.tampered', 'orchestrator', null, { approved: a ? a.plan_hash.slice(0, 12) : null, current: cur.plan_hash.slice(0, 12), tasks_match: !!a && a.tasks_hash === cur.tasks_hash });
    }
    return ok;
  }

  async _cancel(S, kind, by) {
    const goal = S.goal;
    this.ev('human.cancel', 'human', null, { by, kind });
    const pgids = new Set();
    for (const r of this.workers.values()) pgids.add(r.pgid);
    for (const t of S.tasks) if (t.status === 'running' && !this.workers.has(t.id)) { const pf = readJSON(this.wpath(t.id, t.orch.worker_seq, 'pid.json')); if (this._pidFileIsOurs(pf)) pgids.add(pf.pgid); }
    await Promise.all([...pgids].map((g) => W.killGroup(g, { graceMs: kind === 'kill' ? Math.min(this.killGraceMs, 2000) : this.killGraceMs })));
    for (const t of S.tasks) {
      if (['done', 'failed', 'cancelled'].includes(t.status)) continue;
      const e = t.orch.attempt_log.at(-1);
      if (t.status === 'running' && e && !e.ended_at) { e.ended_at = iso(this.now()); e.outcome = 'cancelled'; }
      t.status = 'cancelled'; t.updated_at = iso(this.now());
      this.ev('orch.worker.killed', 'orchestrator', t.id, { reason: 'cancel' });
    }
    for (const a of S.agents) if (a.status === 'running') { a.status = 'idle'; a.current_task = null; }
    this.workers.clear();
    goal.status = 'cancelled'; goal.updated_at = iso(this.now());
    this.ev('goal.cancelled', 'orchestrator', null, { by, tasks_cancelled: S.tasks.filter((t) => t.status === 'cancelled').length });
    saveState(this.dir, S);
    await this._finalize(S);
  }

  // ------------------------------------------------------------------ governor
  _governorStep(S) {
    const goal = S.goal; const o = goal.orch;
    const g = this.gov.evaluate(this.now());
    const was = o.paused_reason;
    if (g.paused || !g.dispatch) {
      const why = g.reason;
      if (was !== why) {
        o.paused_reason = why;
        this.ev('orch.governor.paused', 'orchestrator', null, { reason: why, resume_at: g.resume_at_ms ? iso(g.resume_at_ms) : null, manual: g.manual, dispatch_only: !g.paused });
      }
    } else if (was) {
      o.paused_reason = null; this.ev('orch.governor.resumed', 'orchestrator', null, { previous: was });
    }
    o.resume_at = g.resume_at_ms ? iso(g.resume_at_ms) : null;
    this._gate = g;
  }

  // ------------------------------------------------------------------ reap
  async _reap(S) {
    const goal = S.goal; const now = this.now(); const B = goal.orch.budgets;
    for (const task of S.tasks) {
      if (task.status !== 'running') continue;
      let rec = this.workers.get(task.id);
      const entry = task.orch.attempt_log.at(-1);
      if (!rec) {
        if (entry?.ended_at && entry.collected) { await this._decide(S, task, entry, readJSON(this.wpath(task.id, entry.n, 'result.json'))); continue; } // crash after collection
        rec = this._adopt(S, task);
        if (!rec) continue;
      }
      if (rec.tail.update()) rec.lastProgressMs = now;
      for (const info of rec.tail.takeRateLimits()) { this.gov.observe(info, now); rec.lastRL = info; }
      const alive = rec.exited ? false : rec.handle ? true : (pidAlive(rec.pid) && this._pidMatches(rec));
      if (alive && !rec.termAtReal) {
        if (now - rec.startedMs > B.task_wall_clock_s * 1000) this._term(rec, 'wall_clock');
        else if (now - rec.lastProgressMs > B.stall_after_s * 1000) this._term(rec, 'stall');
        else if (goal.orch.halt_at_ms && goal.orch.halt_reason?.startsWith('budget') && now - goal.orch.halt_at_ms >= this.budgetGraceMs) this._term(rec, 'budget');
      } else if (alive && rec.termAtReal && Date.now() - rec.termAtReal > this.killGraceMs) { W.signalGroup(rec.pgid, 'SIGKILL'); rec.termAtReal = Date.now() + 1e9; }
      if (alive) continue;
      rec.tail.update();
      await this._collect(S, task, rec);
    }
  }

  _term(rec, reason) {
    rec.killReason = reason; rec.termAtReal = Date.now();
    W.signalGroup(rec.pgid, 'SIGTERM');
    this.ev('orch.worker.killed', 'orchestrator', rec.task, { reason, pgid: rec.pgid, seq: rec.seq });
  }

  /** A pid file's process is still OUR worker (pid reuse after a crash/reboot must never get an unrelated group killed). */
  _pidFileIsOurs(pf) {
    if (!pf?.pgid || !pf.pid || !pf.session_id) return false;
    return pidAlive(pf.pid) && !!W.processCommand(pf.pid)?.includes(pf.session_id);
  }

  _pidMatches(rec) {
    const cmd = W.processCommand(rec.pid);
    return cmd != null && (!rec.session_id || cmd.includes(rec.session_id));
  }

  /** Re-adopt a worker from its pid file after an engine crash; null (and requeue) when it is lost. */
  _adopt(S, task) {
    const seq = task.orch.worker_seq;
    const pf = seq ? readJSON(this.wpath(task.id, seq, 'pid.json')) : null;
    const entry = task.orch.attempt_log.at(-1);
    if (!pf) return this._lost(S, task, entry, 'no pid file (crash between intent and spawn)');
    const tail = new W.StreamTail(this.wpath(task.id, seq, 'stream.ndjson'));
    tail.update();
    const alive = pidAlive(pf.pid) && W.processCommand(pf.pid)?.includes(pf.session_id);
    if (!alive && !tail.result) return this._lost(S, task, entry, 'worker process is gone and left no result');
    const rec = { task: task.id, seq, pid: pf.pid, pgid: pf.pgid, session_id: pf.session_id, tail, handle: null, exited: alive ? null : { exit_code: null, signal: null, adopted: true },
      startedMs: Date.parse(pf.started_at) || this.now(), lastProgressMs: this.now(), killReason: null, termAtReal: 0 };
    this.workers.set(task.id, rec);
    this.ev('orch.worker.adopted', 'orchestrator', task.id, { pid: pf.pid, alive: !!alive });
    return rec;
  }

  _lost(S, task, entry, why) {
    if (entry && !entry.ended_at) { entry.ended_at = iso(this.now()); entry.outcome = 'lost'; entry.counted = false; }
    task.attempts = Math.max(0, task.attempts - 1);
    task.status = 'ready'; task.orch.phase = null; task.updated_at = iso(this.now());
    const a = S.agents.find((x) => x.id === task.assignee); if (a) { a.status = 'idle'; a.current_task = null; }
    this.ev('orch.worker.lost', 'orchestrator', task.id, { why });
    this.ev('task.retried', 'orchestrator', task.id, { attempts: task.attempts, max_attempts: task.max_attempts, reason: 'lost', tier: task.orch.model_tier });
    saveState(this.dir, S);
    return null;
  }

  /** Stage A: read the final stream, account usage, persist result.json. Stage B: _decide. */
  async _collect(S, task, rec) {
    const goal = S.goal; const o = goal.orch;
    const entry = task.orch.attempt_log.at(-1);
    const res = rec.tail.result;
    const u = rec.tail.usage();
    const stderr = (() => { try { return fs.readFileSync(this.wpath(task.id, rec.seq, 'stderr'), 'utf8'); } catch { return ''; } })();
    const rl = rec.lastRL;
    const denials = res ? (res.permission_denials || []).map((d) => ({ tool_name: d.tool_name, tool_input_label: String(d.tool_input?.command ?? d.tool_input?.file_path ?? '').split(/\s+/)[0] })) : rec.tail.denials.map((d) => ({ tool_name: d.tool_name }));
    const collected = { task: task.id, seq: rec.seq, exit_code: rec.exited?.exit_code ?? null, signal: rec.exited?.signal ?? null, spawn_error: rec.exited?.error || null,
      killReason: rec.killReason, result: res ? { subtype: res.subtype, is_error: res.is_error, result: String(res.result ?? '').slice(0, 4000), errors: res.errors, api_error_status: res.api_error_status, usage: res.usage, total_cost_usd: res.total_cost_usd, num_turns: res.num_turns, terminal_reason: res.terminal_reason } : null,
      denials, usage: u, notional_usd: rec.tail.notionalUsd(), stderr_tail: stderr.slice(-2000), resets_at_ms: rl?.resets_at_ms ?? null };
    atomicWrite(this.wpath(task.id, rec.seq, 'result.json'), collected);
    if (!entry.accounted) {
      entry.accounted = true; entry.new_tokens = u.new_tokens; entry.notional_usd = collected.notional_usd; entry.exit_code = collected.exit_code; entry.denials = denials.length;
      o.usage.new_tokens += u.new_tokens; o.usage.cache_read_tokens += u.cache_read_tokens; o.usage.notional_usd = Math.round((o.usage.notional_usd + collected.notional_usd) * 1e6) / 1e6;
      goal.budget.spent_usd = o.usage.notional_usd;
      task.orch.tokens.new += u.new_tokens; task.orch.tokens.cache_read += u.cache_read_tokens;
    }
    entry.ended_at = iso(this.now()); entry.collected = true;
    const a = S.agents.find((x) => x.id === task.assignee); if (a) { a.status = 'idle'; a.current_task = null; a.last_event_at = entry.ended_at; }
    this.ev('orch.worker.exited', 'orchestrator', task.id, { exit_code: collected.exit_code, signal: collected.signal, subtype: res?.subtype ?? null, new_tokens: u.new_tokens, kill_reason: rec.killReason, denials: denials.length });
    this.workers.delete(task.id);
    // the leader is gone; anything left in its process group (background jobs the worker started) is ours to stop
    // (only while the leader pid is dead: a live pid that failed the identity check is someone else's process)
    if (rec.pgid && !pidAlive(rec.pid) && W.groupAlive(rec.pgid)) W.signalGroup(rec.pgid, 'SIGKILL');
    saveState(this.dir, S);
    await this._decide(S, task, entry, collected);
  }

  // ------------------------------------------------------------------ outcome -> action (design section 4 table)
  async _decide(S, task, entry, c) {
    const goal = S.goal; const o = goal.orch;
    const tier = entry.tier;
    const requeueUncounted = (outcome, note) => {
      entry.outcome = outcome; entry.counted = false;
      task.attempts = Math.max(0, task.attempts - 1); task.status = 'ready'; task.orch.phase = null; task.updated_at = iso(this.now());
      if (note) task.orch.last_failure = { kind: outcome, note };
      this.ev('task.retried', 'orchestrator', task.id, { attempts: task.attempts, max_attempts: task.max_attempts, reason: outcome, tier: task.orch.model_tier });
      saveState(this.dir, S);
    };
    // killed by the engine
    if (c.killReason === 'budget') return requeueUncounted('killed_budget');
    if (c.killReason === 'wall_clock' || c.killReason === 'stall') {
      if (c.killReason === 'stall') this.ev('task.stalled', 'orchestrator', task.id, { cause: 'no stream output', attempt: task.attempts });
      return this._failAttempt(S, task, entry, c.killReason, { escalate: true });
    }
    // plan-limit rejection: governor pauses, attempt not counted
    const lim = detectLimitFailure(c.result, c.stderr_tail, this.gov.cfg);
    if ((c.result?.is_error && lim.limited) || (!c.result && /usage limit|rate limit|limit reached/i.test(c.stderr_tail))) {
      if (!this.gov.load().pause) this.gov.noteLimitFailure(this.now(), `plan limit suspected: ${lim.why}`, c.resets_at_ms);
      this._governorStep(S);
      return requeueUncounted('rate_limited');
    }
    if (!c.result) return this._failAttempt(S, task, entry, c.spawn_error ? 'spawn_error' : 'crashed', { escalate: true, note: c.spawn_error || `worker exited ${c.exit_code ?? c.signal} without a result` });
    if (c.result.subtype === 'error_max_budget_usd') return this._failAttempt(S, task, entry, 'budget_usd', { escalate: true });
    if (c.result.is_error || c.result.subtype !== 'success') return this._failAttempt(S, task, entry, 'error', { escalate: true, note: (c.result.errors || [c.result.result]).join(' ').slice(0, 300) });

    // success exit: exit 0 means nothing. Look at denials, then verify with real commands.
    const pending = listApprovals(this.P.approvals, { status: 'pending', task_id: task.id }).filter((a) => a.attempt === task.attempts);
    if (c.denials.length && pending.length) {
      task.orch.phase = null; task.status = 'needs_review'; task.orch.review_attempt = task.attempts; task.updated_at = iso(this.now());
      entry.outcome = 'awaiting_approval'; entry.counted = false; task.attempts = Math.max(0, task.attempts - 1);
      this.ev('orch.approval.requested', 'orchestrator', task.id, { pending: pending.map((a) => a.id), note: 'task waits for a human; slot freed' });
      saveState(this.dir, S);
      return;
    }
    await this._verifyAttempt(S, task, entry, c);
  }

  _failAttempt(S, task, entry, cause, { escalate = true, note = null, check_output = null } = {}) {
    const ladder = task.orch.tier_ladder || TIERS;
    const idx = Math.max(0, ladder.indexOf(entry.tier));
    entry.outcome = cause; entry.counted = true;
    task.orch.phase = null; task.updated_at = iso(this.now());
    task.orch.last_failure = { kind: cause, note, check_output, denials: cause === 'denied' ? (task.orch.last_denials || []) : [] };
    this.ev('task.failed', task.assignee, task.id, { cause, attempt: task.attempts, tier: entry.tier, final: false });
    const sameTier = cause === 'denied' && task.orch.denial_retries < 1; // retry the same tier once with the denial list
    let nextIdx = idx;
    if (sameTier) task.orch.denial_retries++;
    else if (escalate) nextIdx = Math.min(idx + 1, ladder.length - 1);
    const final = task.attempts >= task.max_attempts || (escalate && !sameTier && idx >= ladder.length - 1); // a failure on the top tier is final
    if (final) {
      task.status = 'failed';
      this.ev('task.failed', 'orchestrator', task.id, { cause, attempts: task.attempts, tier: entry.tier, final: true });
      S.goal.orch.halt_reason ??= `task ${task.id} failed after ${task.attempts} attempt(s): ${cause}`;
      S.goal.orch.halt_at_ms ??= this.now();
      this._dropWorktree(S, task).catch(() => {});
    } else {
      task.orch.model_tier = ladder[nextIdx]; task.status = 'ready';
      this.ev('task.retried', 'orchestrator', task.id, { attempts: task.attempts, max_attempts: task.max_attempts, tier: task.orch.model_tier, reason: cause });
    }
    saveState(this.dir, S);
  }

  /** Snapshot (scope check) -> commit -> checks -> integrate. Keyed by (task, attempt). */
  async _verifyAttempt(S, task, entry, c) {
    const goal = S.goal;
    const wt = task.orch.worktree;
    if (!this._planIntact(S)) return this._failAttempt(S, task, entry, 'plan_tampered', { escalate: false, note: 'the approved plan changed on disk' });
    task.orch.phase = 'checking'; saveState(this.dir, S);
    try { await G.assertWorktreeIntegrity(S.goal.orch.repo, wt, task.orch.branch); } catch (e) {
      // never run git in (or commit from) a worktree whose .git the worker replaced; drop it and start over
      this.ev('orch.check.failed', 'orchestrator', task.id, { reason: 'worktree_tampered', error: String(e.message).slice(0, 300) });
      await this._dropWorktree(S, task, true).catch(() => {});
      return this._failAttempt(S, task, entry, 'worktree_tampered', { escalate: true, note: 'the worktree git metadata was modified; never touch .git' });
    }
    const changed = await G.changedPaths(wt);
    const granted = task.orch.grants.filter((g) => g.kind === 'path').map((g) => path.relative(realpathDeepest(wt), g.path).split(path.sep).join('/')).filter((r) => r && !r.startsWith('..'));
    const pol = this._policy(goal);
    // an approved path grant extends the scope; protected files (.git, .claude/settings*.json) never pass, whatever the scope
    const outside = changed.filter((p) => !matchAny([...task.orch.path_scope, ...granted], p) || isProtectedRel(pol, p));
    if (outside.length) {
      await G.discardChanges(wt);
      this.ev('orch.check.failed', 'orchestrator', task.id, { reason: 'scope_violation', paths: outside.slice(0, 20) });
      return this._failAttempt(S, task, entry, 'scope_violation', { escalate: true, note: `changed files outside path_scope: ${outside.slice(0, 5).join(', ')}` });
    }
    await G.commitAll(wt, `aos: ${task.id} attempt ${entry.n} (${entry.tier})`);
    const checks = await runChecks(task.orch.checks, { cwd: wt, env: checkEnv({ base: this.env, tmpDir: this._tmp(task.id) }), allowlist: this._checkAllowlist(goal), ...this._sandboxOpts(goal, wt, task.id) });
    entry.checks_ok = checks.ok;
    const last = checks.results.at(-1);
    this.ev(checks.ok ? 'orch.check.passed' : 'orch.check.failed', 'orchestrator', task.id, { attempt: entry.n, checks: checks.results.map((r) => ({ argv: r.argv.join(' '), ok: r.ok, exit_code: r.exit_code, timed_out: r.timed_out, sandboxed: r.sandboxed ?? null })) });
    if (c.denials.length) { // permission_denials in a success exit = failed attempt (denials without an approval request)
      task.orch.last_denials = c.denials.map((d) => `${d.tool_name}${d.tool_input_label ? ` ${d.tool_input_label}` : ''}`);
      this.ev('orch.policy.denied', 'orchestrator', task.id, { attempt: entry.n, denials: task.orch.last_denials });
      return this._failAttempt(S, task, entry, 'denied', { escalate: true, note: `denied tool calls: ${task.orch.last_denials.join(', ')}` });
    }
    if (!checks.ok) return this._failAttempt(S, task, entry, 'check_failed', { escalate: true, check_output: tail(last?.output || '', 4096) });

    task.orch.phase = 'integrating'; saveState(this.dir, S);
    const pre = await this._repoGuard(S, this._integrationWt(goal));
    if (pre) { // someone but the engine changed the repo instructions / config on the integration branch: do not merge on top of it
      this.ev('orch.repo_instructions.changed', 'orchestrator', task.id, { msg: pre.msg.slice(0, 300), phase: 'pre-merge' });
      return this._failAttempt(S, task, entry, 'repo_instructions_changed', { escalate: false, note: pre.msg });
    }
    const m = await G.mergeNoFf(this._integrationWt(goal), task.orch.branch, `aos: merge ${task.id}`);
    if (!m.ok) {
      this.ev('orch.integrate.conflict', 'orchestrator', task.id, { files: m.files, error: m.error?.slice(0, 300) });
      await this._dropWorktree(S, task, true);
      return this._failAttempt(S, task, entry, 'merge_conflict', { escalate: false, note: `merge conflict in ${m.files.join(', ') || 'files'}: the integration branch changed; redo the task on top of the current files` });
    }
    entry.outcome = 'success'; entry.counted = true;
    task.status = 'done'; task.orch.phase = null; task.orch.result_summary = (c.result?.result || '').slice(0, 400); task.artifacts = [{ type: 'commit', sha: m.sha, branch: task.orch.branch }];
    task.updated_at = iso(this.now());
    task.orch.grants = task.orch.grants.filter((g) => !g.once);
    goal.orch.instructions = await this._hashInstructions(goal.orch.integration_branch); // the engine's own integration commit is sanctioned
    this.ev('orch.integrate.merged', 'orchestrator', task.id, { sha: m.sha, branch: task.orch.branch });
    this.ev('task.completed', task.assignee, task.id, { result: task.orch.result_summary.slice(0, 200), tier: entry.tier, attempts: task.attempts });
    await this._dropWorktree(S, task);
    saveState(this.dir, S);
    await this._runCriteria(S);
  }

  /** Run the goal's criteria checks on the integration branch (after every merge). */
  async _runCriteria(S) {
    const goal = S.goal;
    const wt = this._integrationWt(goal);
    const allDone = S.tasks.length > 0 && S.tasks.every((t) => t.status === 'done');
    const results = {};
    for (const c of goal.success_criteria) {
      let met;
      if (c.check) { const r = await runCheck(c.check, { cwd: wt, env: checkEnv({ base: this.env, tmpDir: this._tmp('criteria') }), ...this._sandboxOpts(goal, wt, 'criteria') }); results[c.id] = r; met = r.ok; }
      else if (Array.isArray(c.requires) && c.requires.length) met = c.requires.every((id) => S.tasks.find((t) => t.id === id)?.status === 'done');
      else met = allDone;
      if (met !== !!c.met) { c.met = met; this.ev('goal.updated', 'orchestrator', null, { criterion: c.id, met }); }
    }
    this.criteriaResults = { ...(this.criteriaResults || {}), ...results };
    atomicWrite(path.join(this.dir, 'criteria.json'), this.criteriaResults);
    saveState(this.dir, S);
  }

  // ------------------------------------------------------------------ approvals
  _approvals(S) {
    const goal = S.goal; const o = goal.orch;
    const dir = this.P.approvals;
    for (const a of expireDue(dir, this.clock)) this.ev('orch.approval.expired', 'orchestrator', a.task_id, { id: a.id });
    o.approvals_seen ||= {};
    for (const a of listApprovals(dir)) {
      const seen = o.approvals_seen[a.id];
      if (!seen) { this.ev('orch.approval.requested', 'orchestrator', a.task_id, { id: a.id, tool: a.tool, rule: a.rule, reason: a.reason, expires_at: a.expires_at }); o.approvals_seen[a.id] = 'pending'; }
      if (a.status !== 'pending' && o.approvals_seen[a.id] === 'pending') {
        o.approvals_seen[a.id] = a.status;
        this.ev(a.status === 'expired' ? 'orch.approval.expired' : 'orch.approval.decided', a.decided_by === 'timeout' ? 'orchestrator' : 'human', a.task_id, { id: a.id, status: a.status, scope: a.scope, by: a.decided_by });
        if (a.status === 'approved') this.ev('human.approve', 'human', a.task_id, { id: a.id, by: a.decided_by, scope: a.scope });
        if (a.status === 'denied') this.ev('human.deny', 'human', a.task_id, { id: a.id, by: a.decided_by });
        const t = S.tasks.find((x) => x.id === a.task_id);
        if (t && a.status === 'approved' && (a.scope === 'task' || t.status === 'needs_review')) {
          t.orch.grants.push({ ...this._grantFor(a), approval: a.id, once: a.scope !== 'task' });
        }
      }
    }
    // needs_review tasks: continue once every request of the waiting attempt is decided
    for (const t of S.tasks) {
      if (t.status !== 'needs_review') continue;
      const rel = listApprovals(dir, { task_id: t.id }).filter((a) => a.attempt === t.orch.review_attempt);
      if (!rel.length || rel.some((a) => a.status === 'pending')) continue;
      const entry = t.orch.attempt_log.at(-1);
      if (rel.some((a) => a.status === 'approved')) {
        t.status = 'ready'; t.orch.phase = null; t.updated_at = iso(this.now());
        this.ev('task.retried', 'orchestrator', t.id, { attempts: t.attempts, reason: 'approval_granted', tier: t.orch.model_tier });
      } else { // denied or expired: the attempt now counts and the task retries without that capability
        t.attempts += 1; t.status = 'running'; // _failAttempt expects a counted attempt
        entry.outcome = 'approval_denied';
        this._failAttempt(S, t, entry, 'approval_denied', { escalate: true, note: 'a requested capability was denied or expired; do not use it' });
      }
    }
  }

  _grantFor(a) {
    if (a.tool === 'Bash') return { kind: 'command', command: String(a.input?.command || '').trim() };
    const p = a.input?.file_path || a.input?.notebook_path || '';
    return { kind: 'path', path: realpathDeepest(path.resolve(p)) };
  }

  // ------------------------------------------------------------------ verify
  async _verify(S) {
    const goal = S.goal; const o = goal.orch;
    if (goal.status !== 'active') return;
    const crit = goal.success_criteria;
    const allDone = S.tasks.length > 0 && S.tasks.every((t) => t.status === 'done');
    if (allDone && !crit.every((c) => c.met) && !o.final_checked) { await this._runCriteria(S); o.final_checked = true; saveState(this.dir, S); }
    if (crit.length && crit.every((c) => c.met) && (allDone || crit.some((c) => c.check))) {
      await Promise.all([...this.workers.values()].map((r) => W.killGroup(r.pgid, { graceMs: this.killGraceMs })));
      this.workers.clear();
      for (const t of S.tasks) if (['pending', 'ready', 'running', 'needs_review'].includes(t.status)) { t.status = 'cancelled'; t.updated_at = iso(this.now()); }
      goal.status = 'achieved'; goal.updated_at = iso(this.now());
      this.ev('goal.achieved', 'orchestrator', null, { criteria: crit.length });
    } else if (allDone) {
      goal.status = 'blocked'; goal.blocked_reason = `all tasks done but criteria not met: ${crit.filter((c) => !c.met).map((c) => c.id).join(', ')}`;
      this.ev('goal.blocked', 'orchestrator', null, { reason: goal.blocked_reason });
    }
  }

  _stuckCheck(S) {
    const goal = S.goal;
    const open = S.tasks.some((t) => ['ready', 'running', 'needs_review'].includes(t.status));
    if (S.tasks.length && !open && !S.tasks.every((t) => t.status === 'done') && !S.tasks.some((t) => t.status === 'pending' && t.depends_on.every((d) => S.tasks.find((x) => x.id === d)?.status === 'done'))) {
      goal.status = 'blocked'; goal.blocked_reason = goal.orch.halt_reason || 'no runnable tasks remain';
      this.ev('goal.blocked', 'orchestrator', null, { reason: goal.blocked_reason });
    }
  }

  // ------------------------------------------------------------------ plan
  async _plan(S) {
    const goal = S.goal; const o = goal.orch;
    const repo = await G.repoInfo(o.repo, o.base_branch);
    o.repo = repo.root; o.base_commit ||= repo.base_commit;
    let plan; let source;
    if (o.plan_state === 'supplied') { plan = readJSON(this.P.plan)?.plan; source = 'supplied'; } else {
      const old = readJSON(this.wpath('planner', 1, 'pid.json'));
      if (this._pidFileIsOurs(old)) await W.killGroup(old.pgid, { graceMs: this.killGraceMs }); // orphan from a crashed engine
      o.plan_state = 'planning'; saveState(this.dir, S);
      await this._ensureIntegration(S);
      const r = await this._runPlanner(S);
      if (r.error) return this._planRejected(S, [r.error]);
      plan = r.plan; source = 'planner';
    }
    const v = validatePlan(plan, { max_tasks: o.budgets.max_tasks, check_allowlist: this._checkAllowlist(goal) });
    if (!v.ok) return this._planRejected(S, v.errors);
    S.tasks = toTasks(v.tasks, goal, this.now());
    S.agents = S.tasks.map((t) => ({ id: t.assignee, role: 'worker', capabilities: ['edit', 'bash'], can_delegate: false, status: 'idle', current_task: null, last_event_at: null, orch: { tier: t.orch.model_tier } }));
    atomicWrite(this.P.plan, { source, plan });
    for (const t of S.tasks) this.ev('task.created', 'orchestrator', t.id, { depends_on: t.depends_on, tier: t.orch.model_tier });
    this.ev('orch.plan.created', 'orchestrator', null, { tasks: S.tasks.length, source, risks: Array.isArray(plan.risks) ? plan.risks.slice(0, 10) : [] });
    o.plan_fingerprint = this._fingerprint(S);
    const review = humanReviewReason(S.tasks);
    if (o.approval_policy.plan === 'auto' && !review && this._activate(S, 'auto')) { /* only plans without commands may auto-approve */ } else {
      if (o.approval_policy.plan === 'auto' && review) this.ev('orch.plan.approval_required', 'orchestrator', null, { reason: review, note: 'plan_approval "auto" does not apply to plans with commands' });
      o.plan_state = 'awaiting_approval'; o.plan_awaiting_since_ms = this.now(); this.ev('goal.updated', 'orchestrator', null, { status: 'draft', plan_state: 'awaiting_approval' });
    }
    saveState(this.dir, S);
  }

  async _planRejected(S, errors) {
    const goal = S.goal;
    goal.orch.plan_state = 'rejected'; goal.status = 'blocked'; goal.blocked_reason = `plan rejected: ${errors.slice(0, 5).join('; ')}`;
    this.ev('orch.plan.rejected', 'orchestrator', null, { errors: errors.slice(0, 20) });
    this.ev('goal.blocked', 'orchestrator', null, { reason: goal.blocked_reason });
    saveState(this.dir, S);
  }

  async _runPlanner(S) {
    const goal = S.goal; const o = goal.orch;
    const wt = this._integrationWt(goal);
    const guard = this._configGuard(goal, wt);
    if (guard) return { error: guard };
    const { prompt } = buildPlannerPrompt({ goal, facts: gatherRepoFacts(wt), constraints: { max_tasks: o.budgets.max_tasks, tiers: TIERS, check_allowlist: this._checkAllowlist(goal) } });
    const sessionId = crypto.randomUUID();
    const policyFile = path.join(this.P.workers, 'planner.policy.json');
    atomicWrite(policyFile, { policy: this._policy(goal), ctx: { worktree: realpathDeepest(wt), path_scope: [], allowed_tools: ['Read', 'Glob', 'Grep'], allowed_commands: [], grants: [], home: this.env.HOME, base_branch: o.base_branch } });
    const stdout = this.wpath('planner', 1, 'stream.ndjson'); const stderr = this.wpath('planner', 1, 'stderr');
    for (const f of [stdout, stderr]) { try { fs.unlinkSync(f); } catch { /* none */ } }
    const args = W.buildArgs({ prompt, tier: 'opus', sessionId, maxTurns: o.budgets.max_turns, maxBudgetUsd: o.budgets.attempt_usd_cap, tools: W.READ_ONLY_TOOLS, allowedTools: W.READ_ONLY_TOOLS, appendSystemPrompt: 'You are the planner for an AOS-1 goal. You do not edit files. Output ONLY one JSON object.', settingsFile: path.join(this.P.workers, 'settings.json') });
    const env = W.buildEnv({ base: this.env, goalId: goal.id, taskId: 'planner', attempt: 1, worktree: wt, policyFile, approvalsDir: this.P.approvals, tmpDir: this._tmp('planner'), decisionLog: path.join(this.P.workers, 'decisions.ndjson'), bin: this.bin });
    const h = W.startWorker({ bin: this.bin, args, env, cwd: wt, stdoutFile: stdout, stderrFile: stderr, spawnFn: this.spawnFn });
    if (h.pid) atomicWrite(this.wpath('planner', 1, 'pid.json'), { pid: h.pid, pgid: h.pgid, started_at: iso(this.now()), session_id: sessionId, tier: 'opus' });
    o.plan_session_id = sessionId; o.usage.workers_started++;
    this.ev('orch.worker.started', 'orchestrator', null, { role: 'planner', pid: h.pid, tier: 'opus', session_id: sessionId });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; W.signalGroup(h.pgid, 'SIGTERM'); setTimeout(() => W.signalGroup(h.pgid, 'SIGKILL'), this.killGraceMs).unref(); }, this.plannerTimeoutMs);
    const exit = await h.done; clearTimeout(timer);
    const tailer = new W.StreamTail(stdout); tailer.update();
    for (const info of tailer.takeRateLimits()) this.gov.observe(info, this.now());
    const u = tailer.usage(); o.usage.new_tokens += u.new_tokens; o.usage.cache_read_tokens += u.cache_read_tokens; o.usage.notional_usd += tailer.notionalUsd();
    this.ev('orch.worker.exited', 'orchestrator', null, { role: 'planner', exit_code: exit.exit_code, new_tokens: u.new_tokens });
    if (timedOut) return { error: 'planner timed out' };
    const res = tailer.result;
    if (!res || res.is_error) return { error: `planner failed: ${res ? (res.errors || [res.result]).join(' ').slice(0, 200) : exit.error || `exit ${exit.exit_code}`}` };
    const j = extractJson(res.result);
    return j.error ? { error: j.error } : { plan: j.value };
  }

  // ------------------------------------------------------------------ dispatch
  _promote(S) {
    const byId = new Map(S.tasks.map((t) => [t.id, t]));
    for (const t of S.tasks) {
      if (t.status === 'pending' && t.depends_on.every((d) => byId.get(d)?.status === 'done')) {
        t.status = 'ready'; t.updated_at = iso(this.now()); this.ev('task.ready', 'orchestrator', t.id, {});
      }
    }
  }

  _budgets(S, seq) {
    const goal = S.goal; const o = goal.orch;
    let inflight = 0; for (const r of this.workers.values()) { r.tail.update(); inflight += r.tail.usage().new_tokens; }
    const b = checkBudgets(goal, { nowMs: this.now(), seq, inflightTokens: inflight });
    o.soft = b.soft;
    if (b.hard.length && !o.halt_reason) {
      o.halt_reason = `budget: ${b.hard.join('; ')}`; o.halt_at_ms = this.now();
      this.ev('budget.exceeded', 'orchestrator', null, { ticks: seq, new_tokens: o.usage.new_tokens + inflight, notional_usd: o.usage.notional_usd, reasons: b.hard });
    }
  }

  async _dispatch(S) {
    const goal = S.goal; const o = goal.orch; const B = o.budgets;
    if (!this._gate?.dispatch) return;
    if (!o.unsandboxed_checks && !sandboxAvailable({ bin: this.sandboxBin }).ok) {
      o.halt_reason ??= `OS sandbox unavailable (${sandboxAvailable({ bin: this.sandboxBin }).reason}): checks refuse to run; set orch.unsandboxed_checks=true to override`; o.halt_at_ms ??= this.now();
      return;
    }
    if (!this._planIntact(S)) return;
    if (S.tasks.some((t) => t.status === 'ready')) {
      const wt = await this._ensureIntegration(S);
      const g = await this._repoGuard(S, wt);
      if (g) {
        const t = S.tasks.find((x) => x.status === 'ready');
        if (g.kind === 'instructions') { // fail the task that would have run, never start it
          t.status = 'failed'; t.updated_at = iso(this.now()); t.orch.last_failure = { kind: 'repo_instructions_changed', note: g.msg };
          this.ev('task.failed', 'orchestrator', t.id, { cause: 'repo_instructions_changed', attempt: t.attempts, tier: t.orch.model_tier, final: true });
        }
        o.halt_reason ??= g.msg; o.halt_at_ms ??= this.now();
        saveState(this.dir, S);
        return;
      }
    }
    const running = () => S.tasks.filter((t) => t.status === 'running');
    let slots = B.max_parallel - running().length;
    for (const task of S.tasks) {
      if (slots <= 0) break;
      if (task.status !== 'ready') continue;
      if ((o.soft || []).length && task.orch.model_tier === 'opus') continue; // soft budget: no new opus-tier work
      if (running().some((r) => scopesOverlap(r.orch.path_scope, task.orch.path_scope))) continue; // SPEC section 6
      const tok = this.slotGate ? this.slotGate.acquire(goal.id) : true;
      if (!tok) break; // global worker cap / fairness: try again next tick
      try { await this._startAttempt(S, task); slots--; } catch (e) {
        task.status = 'ready'; task.attempts = Math.max(0, task.attempts - 1); task.orch.phase = null;
        const le = task.orch.attempt_log.at(-1); if (le && !le.ended_at) { le.ended_at = iso(this.now()); le.outcome = 'dispatch_failed'; le.counted = false; }
        o.halt_reason ??= `dispatch of ${task.id} failed: ${String(e.message).slice(0, 200)}`; o.halt_at_ms ??= this.now();
        this.ev('agent.errored', 'orchestrator', task.id, { error: String(e.message).slice(0, 300) });
        break;
      } finally { if (this.slotGate) this.slotGate.release(tok); }
    }
  }

  async _startAttempt(S, task) {
    const goal = S.goal; const o = goal.orch;
    const seq = (task.orch.worker_seq || 0) + 1;
    const tier = task.orch.model_tier;
    const sessionId = crypto.randomUUID();
    task.orch.worker_seq = seq; task.status = 'running'; task.attempts += 1; task.orch.phase = 'working'; task.updated_at = iso(this.now());
    task.orch.attempt_log.push({ n: seq, tier, session_id: sessionId, started_at: iso(this.now()), ended_at: null, outcome: null, denials: 0, new_tokens: 0, exit_code: null, counted: true });
    const agent = S.agents.find((a) => a.id === task.assignee);
    if (agent) { agent.status = 'running'; agent.current_task = task.id; agent.last_event_at = iso(this.now()); agent.orch = { pid: null, session_id: sessionId, tier }; }
    o.usage.workers_started++;
    this.ev('task.started', task.assignee, task.id, { attempt: task.attempts, tier, seq });
    saveState(this.dir, S); // intent first, spawn second (crash in between = lost, requeued uncounted)

    await this._ensureIntegration(S);
    const wt = path.join(o.worktree_root, task.id);
    const w = await G.worktreeAdd(o.repo, goal.id, wt, task.orch.branch, o.integration_branch);
    if (w.branch_created) o.created_branches.push(task.orch.branch);
    task.orch.worktree = wt;
    const real = realpathDeepest(wt);
    const policyFile = this.wpath(task.id, seq, 'policy.json');
    atomicWrite(policyFile, { policy: this._policy(goal), ctx: { worktree: real, path_scope: task.orch.path_scope, allowed_tools: task.orch.allowed_tools,
      allowed_commands: task.orch.allowed_commands, grants: task.orch.grants, home: this.env.HOME, base_branch: o.base_branch } });
    const deps = task.depends_on.map((d) => S.tasks.find((x) => x.id === d)).filter(Boolean).map((d) => ({ id: d.id, title: d.title, summary: d.orch.result_summary }));
    const prompt = W.buildWorkerPrompt({ goal, task, deps, previous: task.orch.last_failure ? { check_output: task.orch.last_failure.check_output, denials: task.orch.last_failure.denials, note: task.orch.last_failure.note } : null });
    fs.writeFileSync(this.wpath(task.id, seq, 'prompt.txt'), prompt, { mode: 0o600 });
    const args = W.buildArgs({ prompt, tier, sessionId, maxTurns: o.budgets.max_turns, maxBudgetUsd: o.budgets.attempt_usd_cap, settingsFile: path.join(this.P.workers, 'settings.json') });
    const env = W.buildEnv({ base: this.env, goalId: goal.id, taskId: task.id, attempt: task.attempts, worktree: real, policyFile, approvalsDir: this.P.approvals, tmpDir: this._tmp(task.id), decisionLog: path.join(this.P.workers, 'decisions.ndjson'), bin: this.bin });
    const stdout = this.wpath(task.id, seq, 'stream.ndjson'); const stderr = this.wpath(task.id, seq, 'stderr');
    const h = W.startWorker({ bin: this.bin, args, env, cwd: wt, stdoutFile: stdout, stderrFile: stderr, spawnFn: this.spawnFn });
    const rec = { task: task.id, seq, pid: h.pid, pgid: h.pgid, session_id: sessionId, tail: new W.StreamTail(stdout), handle: h, exited: null,
      startedMs: this.now(), lastProgressMs: this.now(), killReason: null, termAtReal: 0 };
    this.workers.set(task.id, rec);
    if (h.pid) atomicWrite(this.wpath(task.id, seq, 'pid.json'), { pid: h.pid, pgid: h.pgid, started_at: iso(this.now()), session_id: sessionId, tier, attempt: task.attempts });
    if (agent?.orch) agent.orch.pid = h.pid;
    h.done.then((info) => { if (this.workers.get(task.id) === rec) { rec.exited = info; this._wake(); } });
    this.ev('agent.spawned', task.assignee, task.id, { pid: h.pid, tier, session_id: sessionId });
    this.ev('orch.worker.started', 'orchestrator', task.id, { pid: h.pid, tier, attempt: task.attempts, seq });
    saveState(this.dir, S);
  }

  // ------------------------------------------------------------------ git / policy plumbing
  async _ensureIntegration(S) {
    const goal = S.goal; const o = goal.orch;
    if (!o.worktree_root) {
      const repo = await G.repoInfo(o.repo, o.base_branch);
      o.repo = repo.root; o.base_commit ||= repo.base_commit;
      o.worktree_root = G.worktreeRootFor(o.repo, goal.id);
    }
    const wt = path.join(o.worktree_root, 'integration');
    const w = await G.worktreeAdd(o.repo, goal.id, wt, o.integration_branch, o.base_commit);
    if (w.branch_created && !o.created_branches.includes(o.integration_branch)) o.created_branches.push(o.integration_branch);
    saveState(this.dir, S);
    return wt;
  }
  _integrationWt(goal) { return path.join(goal.orch.worktree_root, 'integration'); }
  _sandboxOpts(goal, wt, name) {
    const o = goal.orch;
    return { sandbox: { worktree: wt, tmpDir: this._tmp(name), goalDir: this.dir, orchDir: this.orchDir, home: this.env.HOME, ports: o.check_localhost_ports || [], profileDir: path.join(this.dir, 'sandbox') },
      sandboxBin: this.sandboxBin, unsandboxed: o.unsandboxed_checks === true };
  }
  async _hashInstructions(ref) {
    const out = {}; const repo = readJSON(this.P.goal).orch.repo;
    for (const rel of INSTRUCTION_FILES) { const b = await G.showBlob(repo, ref, rel); out[rel] = b ? sha256Buf(b) : null; }
    return out;
  }
  /** Hostile repo config on disk in `wt` (unless trusted) -> message, else null. */
  _configGuard(goal, wt) {
    if (goal.orch.trust_repo_config) return null;
    const { findings } = scanRepoConfig(wt, wt);
    if (!findings.length) return null;
    this.ev('orch.repo_config.refused', 'orchestrator', null, { findings: findings.slice(0, 10).map((f) => ({ kind: f.kind, detail: f.detail })) });
    return `repo configuration is not trusted (pass --trust-repo-config to the goal to override): ${formatFindings(findings).slice(0, 400)}`;
  }
  /** {kind,msg} when the integration checkout has hostile config, or the CLAUDE.md hashes differ from what the engine last recorded. */
  async _repoGuard(S, wt) {
    const goal = S.goal; const o = goal.orch;
    const cfg = this._configGuard(goal, wt);
    if (cfg) return { kind: 'config', msg: cfg };
    if (!o.instructions) return null;
    const cur = await this._hashInstructions(o.integration_branch);
    const diff = INSTRUCTION_FILES.filter((rel) => (cur[rel] || null) !== (o.instructions[rel] || null));
    if (!diff.length) return null;
    const msg = `repo instructions changed since plan approval by something other than the engine's integration commits: ${diff.map((d) => `${d} ${String(o.instructions[d] || 'absent').slice(0, 12)} -> ${String(cur[d] || 'absent').slice(0, 12)}`).join(', ')}`;
    this.ev('orch.repo_instructions.changed', 'orchestrator', null, { files: diff, phase: 'dispatch' });
    return { kind: 'instructions', msg };
  }
  _tmp(name) { return ensureDir(path.join(this.P.tmp, name)); }
  _checkAllowlist(goal) {
    const base = goal.orch.check_allowlist || [];
    const crit = goal.success_criteria.filter((c) => c.check).map((c) => c.check.argv);
    return [...base, ...crit];
  }
  _policy(goal) {
    const o = goal.orch;
    let file = null;
    if (typeof o.policy === 'string') file = readJSON(path.join(this.orchDir, o.policy), null);
    const over = o.policy && typeof o.policy === 'object' ? o.policy : null;
    return mergePolicy(file, over, { approval: { ttl_s: o.budgets.approval_ttl_s, ...(over?.approval || {}) } });
  }

  async _dropWorktree(S, task, deleteBranch = false) {
    const o = S.goal.orch;
    const wt = task.orch.worktree;
    if (wt) await G.worktreeRemove(o.repo, wt);
    task.orch.worktree = null;
    if (deleteBranch && o.created_branches.includes(task.orch.branch)) { // only branches this engine created
      await G.deleteOwnBranch(o.repo, S.goal.id, task.orch.branch);
      o.created_branches = o.created_branches.filter((b) => b !== task.orch.branch);
    }
  }

  // ------------------------------------------------------------------ finalize: report + cleanup
  async _finalize(S) {
    const goal = S.goal; const o = goal.orch;
    if (o.reported) return;
    try {
      const diffStat = o.worktree_root ? await G.diffStat(o.repo, o.base_commit, o.integration_branch) : '';
      for (const t of S.tasks) if (t.orch.worktree) { try { await this._dropWorktree(S, t); } catch { /* best effort */ } }
      if (o.worktree_root) {
        await G.worktreeRemove(o.repo, this._integrationWt(goal)).catch(() => {});
        // only ever the exact <repo>-aos-worktrees/<goal> directory this engine computed (never a parent)
        if (o.worktree_root === G.worktreeRootFor(o.repo, goal.id) && G.isUnderWorktreeRoot(o.repo, o.worktree_root)) {
          try { fs.rmSync(o.worktree_root, { recursive: true, force: true }); fs.rmdirSync(path.dirname(o.worktree_root)); } catch { /* not empty / gone */ }
        }
      }
      const decisions = (() => { try { return fs.readFileSync(path.join(this.P.workers, 'decisions.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((d) => d.decision === 'deny'); } catch { return []; } })();
      const criteria = readJSON(path.join(this.dir, 'criteria.json'), {});
      const md = buildReport({ goal, tasks: S.tasks, approvals: listApprovals(this.P.approvals), denials: decisions, diffStat, criteriaResults: criteria, events: readEvents(this.dir), governor: this.gov.load() });
      atomicWrite(this.P.report, md);
      o.reported = true;
      this.ev('orch.report.written', 'orchestrator', null, { path: this.P.report, status: goal.status });
    } finally {
      saveState(this.dir, S);
      atomicWrite(this.P.hb, { ...loadHeartbeat(this.dir), status: 'stopped' });
    }
  }

  /** Snapshot for `status`. */
  summary() {
    const S = loadState(this.dir); const hb = loadHeartbeat(this.dir);
    return summarize(S, hb);
  }
}

export function summarize(S, hb) {
  const counts = {}; for (const t of S.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  return { id: S.goal.id, title: S.goal.title, status: S.goal.status, blocked_reason: S.goal.blocked_reason || null, plan_state: S.goal.orch.plan_state,
    heartbeat: { seq: hb.seq, status: hb.status, ts: hb.ts }, tasks: counts, usage: S.goal.orch.usage, paused_reason: S.goal.orch.paused_reason, resume_at: S.goal.orch.resume_at || null,
    task_list: S.tasks.map((t) => ({ id: t.id, status: t.status, tier: t.orch.model_tier, attempts: t.attempts })),
    plan_review: reviewView(S.tasks), plan_approval: S.goal.orch.plan_approval || null, trust_repo_config: !!S.goal.orch.trust_repo_config, unsandboxed_checks: !!S.goal.orch.unsandboxed_checks };
}

/**
 * Create a goal directory from a user-written spec (see README). Resolves the repo and base commit, validates,
 * emits goal.created. `spec.plan` (optional) is a pre-made plan that skips the planner call (still fully validated).
 */
export async function createGoal(orchDir, spec, { clock = realClock } = {}) {
  const { normalizeGoalSpec, createGoalDir } = await import('./state.mjs');
  const goal = normalizeGoalSpec(spec, { clock });
  const start = goal.orch.repo;
  const info = await G.repoInfo(start, goal.orch.base_branch);
  goal.orch.repo = info.root; goal.orch.base_commit = info.base_commit;
  // condition 2: refuse repos whose own Claude Code configuration could steer a worker, unless the human opted in
  const { findings } = scanRepoConfig(G.realpath(start), info.root);
  const trusted = goal.orch.trust_repo_config === true;
  if (findings.length && !trusted) throw new Error(`refusing repo ${info.root}: it carries Claude Code configuration that could add hooks, permissions, env, MCP servers or commands to workers:\n  ${formatFindings(findings)}\nReview it; if you wrote it and trust it, set orch.trust_repo_config (CLI: --trust-repo-config).`);
  goal.orch.repo_config_findings = findings.map((f) => ({ path: path.relative(info.root, f.path) || '.', kind: f.kind, detail: f.detail }));
  // CLAUDE.md files are trusted input: not refused, but hashed (committed content a worker will load) and announced
  const instructions = {};
  for (const rel of INSTRUCTION_FILES) { const b = await G.showBlob(info.root, info.base_commit, rel); instructions[rel] = b ? sha256Buf(b) : null; }
  goal.orch.instructions = instructions;
  const dir = createGoalDir(orchDir, goal, spec.plan || null);
  const notices = instructionNotice(info.root, instructions);
  appendEvent(dir, { type: 'goal.created', actor: 'human', goal_id: goal.id, data: { title: goal.title, criteria: goal.success_criteria.length } }, clock);
  if (notices.length) appendEvent(dir, { type: 'orch.repo_instructions', actor: 'orchestrator', goal_id: goal.id, data: { notices, files: Object.fromEntries(Object.entries(instructions).filter(([, h]) => h).map(([k, h]) => [k, h.slice(0, 12)])) } }, clock);
  if (findings.length) {
    notices.push(`WARNING: --trust-repo-config: repo configuration accepted without review by the engine: ${formatFindings(findings)}`);
    appendEvent(dir, { type: 'orch.repo_config.trusted', actor: 'human', goal_id: goal.id, data: { warning: 'repo config accepted via trust_repo_config; workers may be steered by it', findings: goal.orch.repo_config_findings.slice(0, 20) } }, clock);
  }
  if (goal.orch.unsandboxed_checks) {
    notices.push('WARNING: unsandboxed_checks is set: acceptance checks will run worker-written code without the OS sandbox');
    appendEvent(dir, { type: 'orch.sandbox.disabled', actor: 'human', goal_id: goal.id, data: { warning: 'unsandboxed_checks is set; checks run without the OS sandbox' } }, clock);
  }
  return { dir, goal, notices };
}

/** Re-check an existing goal's repo at `aos-orch run` time (config may have changed since creation). Throws when refused. */
export function assertRepoTrusted(goal) {
  if (goal.orch.trust_repo_config) return;
  const { findings } = scanRepoConfig(G.realpath(goal.orch.repo), goal.orch.repo);
  if (findings.length) throw new Error(`refusing repo ${goal.orch.repo}: untrusted Claude Code configuration:\n  ${formatFindings(findings)}`);
}
