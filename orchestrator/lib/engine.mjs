// The AOS-1 heartbeat engine for one goal (design sections 3-5, 8). No LLM in the control loop: every state change is
// code + an Event, all state is on disk, ticks are idempotent, workers are separate process groups that a fresh
// engine can re-adopt after a crash. Tick order (SPEC section 4): Beat, Observe, Reap, Verify, Plan, Dispatch, Budget, Emit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  TERMINAL, paths, ensureDir, readJSON, atomicWrite, iso, realClock, loadState, saveState, loadHeartbeat, appendEvent, readEvents,
  acquireLock, touchLock, releaseLock, lockStatus, describeOwner, drainCommands, enqueueCommand, pidAlive, goalDirOf, orchRoot, applyBudgetPatch, validateBudgetPatch,
} from './state.mjs';
import * as G from './git.mjs';
import { escCtrl } from './ctrl.mjs';
import { runChecks, runCheck, checkEnv, tail, argvProblem } from './checks.mjs';
import * as SC from './selfcheck.mjs';
import { isSelfCheckDenial } from './selfcheck.mjs';
import { matchAny, scopesOverlap } from './glob.mjs';
import { mergePolicy, DEFAULT_POLICY, isProtectedRel } from './policy.mjs';
import { DEFAULT_RULES, q, buildSnapshot, snapshotHash, rulesFingerprint, applyCompiledToGoal, validateRules, toPolicy } from './rules.mjs';
import { compileGoal, recompileSnapshot, previewGoal, parseRepoRules, REPO_RULES_PATH, REPO_RULES_FILE } from './rules-store.mjs';
import { realpathDeepest } from './policy-hook.mjs';
import * as W from './worker.mjs';
import { Governor, DEFAULTS as GOV_DEFAULTS, detectLimitFailure, checkBudgets, usageOf } from './governor.mjs';
import { listTestFiles, runnerFor, scopeHitsTests, serverWarnings } from './protect.mjs';
import { startableTiers, buildPlannerPrompt, gatherRepoFacts, extractJson, validatePlan, toTasks, TIERS, humanReviewReason, planHash, tasksHashFor, tasksHashV, reviewView, canonical, sha256 } from './plan.mjs';
import { scanRepoConfig, INSTRUCTION_FILES, sha256Buf, formatFindings, instructionNotice } from './repo-config.mjs';
import { developerDirs, sandboxAvailable, workerSandboxAvailable, wrapWorkerCommand, DEFAULT_SANDBOX_BIN } from './sandbox.mjs';
import { listApprovals, expireDue, readApproval } from './approvals.mjs';
import { buildReport } from './report.mjs';
import { probeClaudeVersion } from './cli-version.mjs';
import { runAdvisoryReview } from './review.mjs';
import * as HG from './harness-guard.mjs';
const BASELINE_RUNS = 2;
import { attemptDiff, analyzeDiff, failsOf, summarizeFindings, attemptRecord, rollup, reviewerNotes, forceTapArgv, parseTestSummary, summaryOfRun, mergeBaselineRuns, judgeRun, checkKey, isTestRunArgv, staticTestCount, checkInputPaths, isConfigPath, failingTestsLine } from './anticheat.mjs';
import { isTestPath } from './protect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.join(HERE, 'policy-hook.mjs');
/** The last ~20 lines of a worker's stderr, every control character escaped (it is worker-controlled text a human will read). */
const stderrTail = (text, lines = 20, max = 2000) => String(text).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l, i, a) => l || i < a.length - 1).slice(-lines).map((l) => escCtrl(l.length > 300 ? `${l.slice(0, 300)}...` : l)).join('\n').slice(-max);
const budgetRule = (why) => (/new-token/.test(why) ? 'budgets.max_new_tokens' : /wall-clock/.test(why) ? 'budgets.max_wall_clock_s' : /tick/.test(why) ? 'budgets.max_ticks' : /USD/.test(why) ? 'budgets.max_usd' : 'budgets');
const backoffS = (interval, errors) => Math.min(interval * 2 ** Math.min(errors || 0, 20), 900);
/** Automatic re-plans after a planner plan fails validation (the validation errors are fed back); `aos-orch run <goal> --replan` is the human's explicit extra attempt. */
export const AUTO_REPLANS = 1;
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
    this.budgetGraceMs = o.budgetGraceMs ?? null; // null: the compiled budgets.hard_grace_s (R8); tests pass a value
    this.plannerTimeoutMs = o.plannerTimeoutMs ?? null; // null: the compiled plan.planner_timeout_s
    this.pid = o.pid ?? process.pid;
    this.spawnFn = o.spawnFn;
    this.slotGate = o.slotGate || null; // supervisor: global worker semaphore {acquire(goalId)->token|null, release(token)}
    this.testUnsandboxed = o.testUnsandboxedChecks === true; // TEST HARNESS ONLY (hosts without a sandbox): a constructor option, not a goal/CLI/env setting
    this.testFakeEnv = o.testFakeEnv ?? W.testFakeEnvDefault(); // TEST HARNESS ONLY: pass AOS_FAKE_* to the scripted fake claude
    this.sandboxBin = o.sandboxBin || DEFAULT_SANDBOX_BIN; // tests may point this at a missing binary
    this.hookScript = o.hookScript || HOOK_SCRIPT; // tests may substitute a stub hook
    this.workerSandbox = o.workerSandbox || null;
    this.selfCheckPollMs = o.selfCheckPollMs || 150; // tests: overrides for wrapWorkerCommand (e.g. sysTmp)
    this.ownerLabel = o.ownerLabel || 'run';
    this.lockRefreshMs = o.lockRefreshMs ?? null; // default: a third of the lock TTL
    this.bin = o.claudeBin || W.claudeBin(this.env);
    this.claudeVersionProbe = o.claudeVersion ?? null; // tests: a string or an async function replacing `claude --version`
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
    const l = acquireLock(this.dir, { pid: this.pid, ttlMs: this.lockTtlMs(), now: Date.now(), label: this.ownerLabel });
    if (!l.ok) { const st = lockStatus(this.dir); throw Object.assign(new Error(`goal ${this.goalId} is already owned by engine pid ${l.holder?.pid}: ${describeOwner(st)}`), { code: 'LOCKED', lock: st }); }
    this.started = true;
    // keep the lock fresh while a long tick (checks up to 3600 s, merges, kills) is in progress: a stale-looking lock
    // would let a second engine take the goal over and verify/merge/dispatch the same tasks concurrently
    clearInterval(this._lockTimer);
    this._lockTimer = setInterval(() => { if (!this.dead && this.started) touchLock(this.dir, { pid: this.pid, now: Date.now() }); }, this.lockRefreshMs ?? Math.floor(this.lockTtlMs() / 3));
    this._lockTimer.unref?.();
    clearInterval(this._scTimer); // worker.self_check requests are answered between ticks (a tick can be seconds away)
    this._scTimer = setInterval(() => { if (!this.dead && this.started) this._serviceSelfChecks(); }, this.selfCheckPollMs);
    this._scTimer.unref?.();
    for (const d of [this.P.approvals, this.P.workers, this.P.commands, this.P.tmp]) ensureDir(d);
    this.gov = new Governor(this.orchDir, {}); // thresholds come from the rules (user layer only, G5): _syncGovernor() at the first tick
    atomicWrite(path.join(this.P.workers, 'settings.json'), W.buildSettings(this.hookScript));
    if (!fs.existsSync(this.P.policyDefault)) { try { atomicWrite(this.P.policyDefault, DEFAULT_POLICY); } catch { /* read-only orch dir */ } }
    if (readJSON(this.P.goal)?.orch?.unsandboxed_checks) this.ev('orch.sandbox.disabled', 'orchestrator', null, { warning: 'unsandboxed_checks is set: acceptance checks run worker-written code WITHOUT the OS sandbox' });
    if (l.takeover) this.ev('orch.lock.broken', 'orchestrator', null, { note: 'stale engine lock taken over' });
    return this;
  }

  /** Release the lock; workers keep running (a later engine re-adopts them). */
  async stop() {
    this.stopped = true; this._wake(); await this._chain.catch(() => {}); clearInterval(this._lockTimer); clearInterval(this._scTimer);
    for (const rec of this.workers.values()) await this._endSelfChecks(rec); // an engine-run self-check (own process group) never outlives the engine
    releaseLock(this.dir, { pid: this.pid }); this.started = false;
  }

  /** Simulate a hard crash: stop everything in this process, leave lock + workers + files exactly as they are. */
  crash() { this.dead = true; this.stopped = true; clearInterval(this._lockTimer); clearInterval(this._scTimer); this.workers.clear(); this._wake(); }

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
    this._ensureRules(S);
    this._syncGovernor(goal);

    // 1. Beat
    const now = this.now();
    const intervalS = this.intervalMs / 1000;
    const expectedMs = backoffS(intervalS, hb.consecutive_errors) * 1000;
    const gap = hb.ts ? now - Date.parse(hb.ts) : 0;
    const seq = hb.seq + 1;
    // a goal parked on purpose (waiting for plan approval, blocked, paused) is not ticked while it waits: an old heartbeat there is not a dead engine
    const parked = goal.status === 'blocked' || (goal.status === 'draft' && o.plan_state === 'awaiting_approval') || hb.status === 'paused' || hb.status === 'stopped';
    hb = { ...hb, seq, ts: iso(now), interval_s: Math.max(1, intervalS), liveness: 'alive' };
    if (hb.status === 'stopped') hb.status = 'running';
    atomicWrite(P.hb, hb);
    if (parked) { /* no heartbeat.dead / heartbeat.late after a deliberate wait */ } else if (seq > 1 && gap > 3 * expectedMs && expectedMs >= 1000) this.ev('heartbeat.dead', 'orchestrator', null, { gap_s: Math.round(gap / 1000), expected_s: expectedMs / 1000 });
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
        case 'accept-repo-loosening': this._acceptRepoLoosening(S, c); break;
        case 'confirm': this._confirmCriterion(S, c); break;
        case 'approve-plan':
          if (goal.orch.plan_state === 'awaiting_approval') { this._activate(S, 'human', c.reviewed); saveState(this.dir, S); }
          break;
        case 'replan': // a goal blocked at planning (plan rejected by the validator or by the human): back to 'none' so the next step asks the planner again
          if (goal.status === 'blocked' && goal.orch.plan_state === 'rejected' && !this.workers.size) {
            for (const t of S.tasks) if (t.orch.worktree) { try { await this._dropWorktree(S, t); } catch { /* best effort */ } }
            S.tasks = []; S.agents = []; goal.status = 'draft'; goal.blocked_reason = null; goal.orch.plan_state = 'none'; goal.orch.replans = 0; goal.orch.reported = false;
            delete goal.orch.plan_fingerprint; delete goal.orch.plan_approval;
            this.ev('orch.plan.replan_requested', 'human', null, { by: c.by || 'cli', previous: 'rejected' }); this.ev('goal.updated', 'orchestrator', null, { status: 'draft', plan_state: 'none' });
            saveState(this.dir, S);
            atomicWrite(this.P.hb, { ...loadHeartbeat(this.dir), status: 'running' });
          }
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

  /**
   * `confirm <goal> <criterion>`: a human confirms a verify:"human" criterion. Only once every task is done (a human cannot pre-confirm work that has not happened),
   * only for a criterion that asks for it. A goal that was blocked on exactly this ("awaiting human confirmation") goes back to active, and the verify step of the
   * same tick finishes it (achieved) or re-blocks it on the next unconfirmed criterion.
   */
  _confirmCriterion(S, c) {
    const goal = S.goal; const refuse = (reason) => this.ev('orch.criterion.refused', 'orchestrator', null, { reason, criterion: String(c.criterion).slice(0, 40) });
    const crit = goal.success_criteria.find((x) => x.id === c.criterion);
    if (!crit) return refuse('no such criterion');
    if (crit.verify !== 'human') return refuse('this criterion is verified by a check, not by a human');
    if (TERMINAL.has(goal.status)) return refuse(`goal is ${goal.status}`);
    if (!(S.tasks.length > 0 && S.tasks.every((t) => t.status === 'done'))) return refuse('confirm only after every task is done');
    if (crit.met) return refuse('already confirmed');
    crit.met = true; crit.confirmed = { by: String(c.by || 'cli').slice(0, 60), at: iso(this.now()) };
    this.ev('orch.criterion.confirmed', 'human', null, { criterion: crit.id, by: crit.confirmed.by, rule: 'ask_human.on_human_criterion' });
    this.ev('goal.updated', 'orchestrator', null, { criterion: crit.id, met: true });
    if (goal.status === 'blocked' && String(goal.blocked_reason || '').startsWith('awaiting human confirmation') && !goal.orch.halt_reason) {
      goal.status = 'active'; delete goal.blocked_reason; goal.orch.reported = false;
      this.ev('orch.goal.unblocked', 'human', null, { previous: 'blocked', why: 'criterion confirmed' });
    }
    saveState(this.dir, S);
  }

  /** Resume a goal that stopped on a budget cap, once the caps were raised. Other blocks (failed task, rejected plan) stay blocked. */
  _unblock(S) {
    const goal = S.goal; const o = goal.orch;
    if (!String(o.halt_reason || '').startsWith('budget')) { this.ev('orch.resume.refused', 'orchestrator', null, { reason: 'not blocked by a budget cap', blocked_reason: goal.blocked_reason || null }); return false; }
    const b = checkBudgets(goal, { nowMs: this.now(), seq: loadHeartbeat(this.dir).seq, inflightTokens: 0, softFrac: this._R(goal).budgets.soft_frac });
    if (b.hard.length) { this.ev('orch.resume.refused', 'orchestrator', null, { reason: 'budget still exceeded', hard: b.hard }); return false; }
    goal.status = 'active'; delete goal.blocked_reason; o.halt_reason = null; o.halt_at_ms = null; o.reported = false; o.soft = b.soft;
    goal.updated_at = iso(this.now());
    this.ev('orch.goal.unblocked', 'human', null, { previous: 'blocked' }); this.ev('goal.updated', 'orchestrator', null, { status: 'active' });
    saveState(this.dir, S);
    return true;
  }

  /** Current fingerprint of what a human approves: the stored plan and the engine's task commands/scopes. */
  _fingerprint(S) {
    const rules_hash = rulesFingerprint(S.goal, readJSON(this.P.rules, null));
    return { plan_hash: planHash(readJSON(this.P.plan)?.plan ?? null), tasks_hash: tasksHashFor(S.goal, S.tasks), ...(tasksHashV(S.goal) >= 2 ? { tasks_hash_v: tasksHashV(S.goal) } : {}), ...(rules_hash ? { rules_hash } : {}) };
  }

  /** Activate the goal. The approval record stores the plan hash; a human approval of an edited plan is refused. */
  _activate(S, who, reviewed = null) {
    const goal = S.goal;
    const cur = this._fingerprint(S); const pending = goal.orch.plan_fingerprint;
    const stale = !pending || pending.plan_hash !== cur.plan_hash || pending.tasks_hash !== cur.tasks_hash || pending.rules_hash !== cur.rules_hash
      || (reviewed && (reviewed.plan_hash !== cur.plan_hash || reviewed.tasks_hash !== cur.tasks_hash || reviewed.rules_hash !== cur.rules_hash));
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
    const planOk = !!a && a.plan_hash === cur.plan_hash && a.tasks_hash === cur.tasks_hash;
    const rules = this._rulesCheck(S);
    const ok = planOk && rules.ok;
    if (!rules.ok && !o.halt_reason && planOk) {
      o.halt_reason = 'rules modified after approval: dispatch refused (rules.snapshot.json changed or is missing)'; o.halt_at_ms = this.now();
      this.ev('orch.rules.tampered', 'orchestrator', null, { approved: (a?.rules_hash || o.rules?.sha256 || '').slice(0, 12) || null, current: rules.actual.slice(0, 12) });
    } else if (!ok && !o.halt_reason) {
      o.halt_reason = a ? 'plan modified after approval: dispatch refused (plan.json or the task commands/scopes changed)' : 'no plan approval record: dispatch refused';
      o.halt_at_ms = this.now();
      this.ev('orch.plan.tampered', 'orchestrator', null, { approved: a ? a.plan_hash.slice(0, 12) : null, current: cur.plan_hash.slice(0, 12), tasks_match: !!a && a.tasks_hash === cur.tasks_hash });
    }
    return ok;
  }

  /** The compiled rules of the goal's intact snapshot, else the engine defaults (a legacy goal, or a snapshot that no longer matches goal.json: _planIntact halts such a goal anyway). */
  _R(goal) { return this._rulesView(goal)?.compiled ?? DEFAULT_RULES; }
  /** G5: the governor is shared by every goal, so its thresholds come from the USER layer only (via the compiled rules). Legacy (pre-rule-set) goals keep reading goal.orch.governor. */
  _syncGovernor(goal) {
    const legacy = !goal.orch.rules || goal.orch.rules.legacy;
    const cfg = legacy ? (goal.orch.governor || {}) : (this._rulesView(goal)?.compiled.governor ?? {});
    this.gov.cfg = { ...GOV_DEFAULTS, ...cfg };
  }
  _graceMs(goal) { return this.budgetGraceMs ?? this._R(goal).budgets.hard_grace_s * 1000; }

  /**
   * The rule set is snapshotted once per goal (rules.snapshot.json, 0600) when the engine first loads it, so the planner and every worker run under
   * the same rules for the whole run and a later edit of policy.default.json or of a goal policy file has no effect (G2). A goal that already has a
   * plan but no snapshot (created before R4) gets one flagged legacy: its plan hash is unchanged, and the snapshot hash is recorded in goal.json.
   */
  _ensureRules(S) {
    const goal = S.goal; const o = goal.orch;
    if (o.rules || String(o.halt_reason || '').startsWith('rules refused')) return;
    if (!(o.plan_fingerprint || o.plan_approval || S.tasks.length)) return this._compileRules(S);
    const file = typeof o.policy === 'string' ? readJSON(path.join(this.orchDir, o.policy), null) : null;
    const over = o.policy && typeof o.policy === 'object' ? o.policy : null;
    const legacy = !!(o.plan_fingerprint || o.plan_approval || S.tasks.length);
    const snap = buildSnapshot({ policy: this._effectivePolicy(goal, file, over), legacy,
      layers: [{ layer: 'policy-file', source: typeof o.policy === 'string' ? o.policy : null, sha256: file ? sha256(canonical(file)) : null }, { layer: 'goal-policy', source: null, sha256: over ? sha256(canonical(over)) : null }] });
    atomicWrite(this.P.rules, snap);
    o.rules = { hash: snap.rules_hash.slice(0, 12), sha256: snap.rules_hash, version: snap.rules_version, profile: snap.compiled.profile, profile_name: o.profile_name || snap.compiled.profile, legacy,
      layers: snap.layers.map((l) => ({ layer: l.layer, sha12: l.sha256 ? l.sha256.slice(0, 12) : null })), loosenings: [] };
    this.ev('orch.rules.snapshotted', 'orchestrator', null, { rules_hash: o.rules.hash, profile: o.rules.profile_name, legacy, loosenings: 0 });
    saveState(this.dir, S);
  }

  /** R5/R6: compile default + user + repo + goal layers into the snapshot; an invalid layer refuses the goal (no plan, no worker). Compiled values are written back into goal.json. */
  _compileRules(S) {
    const goal = S.goal; const o = goal.orch;
    const r = compileGoal({ orchDir: this.orchDir, goal, dir: this.dir });
    if (!r.ok) {
      o.halt_reason = `rules refused: ${r.errors.slice(0, 3).join('; ').slice(0, 400)}`; o.halt_at_ms = this.now();
      goal.status = 'blocked'; goal.blocked_reason = o.halt_reason;
      this.ev('orch.rules.refused', 'orchestrator', null, { errors: r.errors.slice(0, 5) }); this.ev('goal.blocked', 'orchestrator', null, { reason: goal.blocked_reason });
      saveState(this.dir, S); return;
    }
    this._storeSnapshot(S, r.snap);
    this.ev('orch.rules.snapshotted', 'orchestrator', null, { rules_hash: o.rules.hash, profile: o.rules.profile_name, legacy: false, loosenings: r.snap.loosenings.length, dropped: r.snap.dropped.length, notes: r.snap.notes.slice(0, 5) });
    const dep = r.snap.notes.filter((n) => n.startsWith('deprecated: '));
    if (dep.length) this.ev('orch.rules.deprecated', 'orchestrator', null, { notes: dep.slice(0, 10) });
    saveState(this.dir, S);
  }

  /** Write a (new) non-legacy snapshot and the goal.json summary of it; applies the compiled values the engine reads from goal.json. */
  _storeSnapshot(S, snap, prev = null) {
    const o = S.goal.orch;
    applyCompiledToGoal(S.goal, snap.compiled, prev);
    atomicWrite(this.P.rules, snap);
    o.rules = { hash: snap.rules_hash.slice(0, 12), sha256: snap.rules_hash, version: snap.rules_version, profile: snap.compiled.profile, profile_name: o.profile_name || snap.compiled.profile, legacy: false,
      layers: snap.layers.map((l) => ({ layer: l.layer, sha12: l.sha256 ? l.sha256.slice(0, 12) : null })),
      loosenings: snap.loosenings.map((l) => ({ rule_id: l.rule_id, layer: l.layer })), dropped: snap.dropped.map((l) => ({ rule_id: l.rule_id, layer: l.layer, reason: l.reason })) };
  }

  /** `approve-plan --accept-repo-loosening <ids>`: recompile with those repo loosenings accepted. Only before the plan is approved; the rules hash changes, so the plan must be reviewed and approved again. */
  _acceptRepoLoosening(S, c) {
    const o = S.goal.orch;
    const refuse = (reason) => this.ev('orch.rules.refused', 'orchestrator', null, { reason, command: 'accept-repo-loosening' });
    if (!o.rules || o.rules.legacy) return refuse('this goal has no rule-set snapshot');
    if (!['none', 'supplied', 'awaiting_approval'].includes(o.plan_state) || o.plan_approval) return refuse('loosenings can only be accepted before the plan is approved');
    if (!this._rulesCheck(S).ok) return refuse('the rules snapshot is not intact');
    const snap = readJSON(this.P.rules, null);
    const want = Array.isArray(c.ids) ? c.ids.filter((x) => typeof x === 'string').slice(0, 64) : [];
    const known = new Set((snap.dropped || []).filter((d) => d.layer === 'repo' && d.reason === 'loosening').map((d) => d.rule_id));
    const ids = want.filter((x) => known.has(x));
    if (!ids.length) return refuse(`none of the given ids is a dropped repo loosening (${want.length} given)`);
    const r = recompileSnapshot(snap, [...new Set([...(o.accept_repo_loosening || []), ...ids])], S.goal);
    if (!r.ok) return refuse(r.errors.join('; ').slice(0, 200));
    if (r.snap.rules_hash === snapshotHash(snap)) return refuse('accepting these loosenings changes nothing (a repo can never loosen the sandbox, plan approval or trust settings)');
    o.accept_repo_loosening = [...new Set([...(o.accept_repo_loosening || []), ...ids])];
    this._storeSnapshot(S, r.snap, snap.compiled); // a budget patch made since the snapshot survives the recompile
    if (S.tasks.length) o.plan_fingerprint = this._fingerprint(S);
    this.ev('orch.rules.changed', 'human', null, { rules_hash: o.rules.hash, by: c.by || 'cli', direction: 'loosen', accepted: ids });
    saveState(this.dir, S);
  }

  /** Does the snapshot on disk still hash to what goal.json (and the plan approval, when it carries one) recorded? */
  _rulesCheck(S) {
    const o = S.goal.orch; const actual = snapshotHash(readJSON(this.P.rules, null));
    const a = o.plan_approval;
    return { ok: !!o.rules && actual === o.rules.sha256 && (!a?.rules_hash || a.rules_hash === actual), actual };
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
        this.ev('orch.governor.paused', 'orchestrator', null, { rule: /seven-day utilisation/.test(why || '') ? 'governor.hold_7d' : /five-hour utilisation/.test(why || '') ? 'governor.reserve_5h' : /overload/i.test(why || '') ? 'governor.overload_backoff_s' : 'governor.backoff_min', reason: why, resume_at: g.resume_at_ms ? iso(g.resume_at_ms) : null, manual: g.manual, dispatch_only: !g.paused });
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
      if (rec.tail.update() || rec.selfCheck?.busy) rec.lastProgressMs = now;
      for (const info of rec.tail.takeRateLimits()) { this.gov.observe(info, now); rec.lastRL = info; }
      const alive = rec.exited ? false : rec.handle ? true : (pidAlive(rec.pid) && this._pidMatches(rec));
      if (alive && !rec.termAtReal) {
        if (now - rec.startedMs > B.task_wall_clock_s * 1000) this._term(rec, 'wall_clock');
        else if (now - rec.lastProgressMs > B.stall_after_s * 1000) this._term(rec, 'stall');
        else if (goal.orch.halt_at_ms && goal.orch.halt_reason?.startsWith('budget') && !rec.tail.result && now - goal.orch.halt_at_ms >= this._graceMs(goal)) this._term(rec, 'budget'); // a worker that already delivered its result is only exiting: killing it would throw away finished work
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
    rec.selfCheck = this._adoptSelfCheck(task, seq); // the attempt's self-check state, rebuilt from its policy file
    this.workers.set(task.id, rec);
    this.ev('orch.worker.adopted', 'orchestrator', task.id, { pid: pf.pid, alive: !!alive });
    return rec;
  }

  /** Self-check state of an adopted attempt, from the policy file the engine wrote at dispatch (inbox, response dir, checks, cap). The run count restarts at 0 (not persisted). */
  _adoptSelfCheck(task, seq) {
    const c = readJSON(this.wpath(task.id, seq, 'policy.json'))?.ctx;
    const sc = c?.self_check;
    if (!sc || !Array.isArray(sc.checks) || typeof sc.dir !== 'string' || typeof sc.res_dir !== 'string') return null;
    return { dir: sc.dir, resDir: sc.res_dir, checks: sc.checks, max: sc.max, wt: c.worktree, attempt: task.attempts, busy: false, bad: 0, flooded: false, aborted: false, running: null, kill: null, stats: { runs: 0, capped: 0, ms: 0, output_bytes: 0 } };
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
    await this._endSelfChecks(rec); // an in-flight self-check never outlives its attempt (it could still write into the worktree the authoritative checks run in)
    if (rec.selfCheck) this._cleanSelfCheckDirs(task.id); // no stale *.res.json / selfcheck-<task> tmp dir carried into the next attempt
    const goal = S.goal; const o = goal.orch;
    const entry = task.orch.attempt_log.at(-1);
    const res = rec.tail.result;
    const u = rec.tail.usage();
    const stderr = (() => { try { return fs.readFileSync(this.wpath(task.id, rec.seq, 'stderr'), 'utf8'); } catch { return ''; } })();
    const rl = rec.lastRL;
    // a self-check is a Bash call the hook denies on purpose (the engine ran the approved argv instead): not a policy denial
    const scChecks = rec.selfCheck?.checks || null;
    const denials = res ? (res.permission_denials || []).filter((d) => !(scChecks && isSelfCheckDenial(d, scChecks))).map((d) => ({ tool_name: d.tool_name, tool_input_label: String(d.tool_input?.command ?? d.tool_input?.file_path ?? '').split(/\s+/)[0] })) : rec.tail.denials.map((d) => ({ tool_name: d.tool_name }));
    const collected = { task: task.id, seq: rec.seq, exit_code: rec.exited?.exit_code ?? null, signal: rec.exited?.signal ?? null, spawn_error: rec.exited?.error || null,
      killReason: rec.killReason === 'budget' && res ? null : rec.killReason, // a budget kill that raced a delivered result changes nothing
      result: res ? { subtype: res.subtype, is_error: res.is_error, result: String(res.result ?? '').slice(0, 4000), errors: res.errors, api_error_status: res.api_error_status, usage: res.usage, total_cost_usd: res.total_cost_usd, num_turns: res.num_turns, terminal_reason: res.terminal_reason } : null,
      denials, usage: u, notional_usd: rec.tail.notionalUsd(), stderr_tail: stderr.slice(-2000), resets_at_ms: rl?.resets_at_ms ?? null,
      rate_limit: rec.tail.lastRateLimit ? { status: rec.tail.lastRateLimit.status, type: rec.tail.lastRateLimit.type, resets_at_ms: rec.tail.lastRateLimit.resets_at_ms } : null, api_error: rec.tail.apiError };
    atomicWrite(this.wpath(task.id, rec.seq, 'result.json'), collected);
    if (!entry.accounted) {
      entry.accounted = true; entry.new_tokens = u.new_tokens; entry.notional_usd = collected.notional_usd; entry.exit_code = collected.exit_code; entry.denials = denials.length;
      o.usage.new_tokens += u.new_tokens; o.usage.cache_read_tokens += u.cache_read_tokens; o.usage.notional_usd = Math.round((o.usage.notional_usd + collected.notional_usd) * 1e6) / 1e6;
      goal.budget.spent_usd = o.usage.notional_usd;
      task.orch.tokens.new += u.new_tokens; task.orch.tokens.cache_read += u.cache_read_tokens;
    }
    if (rec.selfCheck) entry.self_checks = { ...rec.selfCheck.stats, max: rec.selfCheck.max };
    if (stderr.trim() && (!res || res.is_error || collected.exit_code)) entry.stderr_tail = stderrTail(stderr); // what a human needs to see when a worker crashed or errored
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
    const lim = detectLimitFailure(c.result, c.stderr_tail, this.gov.cfg, { rateLimit: c.rate_limit, apiError: c.api_error });
    // an UNCERTAIN (text-only) match twice in a row for the same task is probably not a limit: count the attempt instead of pausing forever
    const uncertain = (lim.limited || lim.overloaded) && !lim.certain;
    task.orch.uncertain_limit = uncertain ? (task.orch.uncertain_limit || 0) + 1 : 0;
    const uMax = this._R(goal).retry.uncertain_limit_max;
    if (uncertain && task.orch.uncertain_limit >= uMax) {
      task.orch.uncertain_limit = 0;
      return this._failAttempt(S, task, entry, 'error', { escalate: true, rule: 'retry.uncertain_limit_max', note: `${lim.why} matched ${uMax} times in a row without a structured rate-limit signal: counted as a failed attempt`.slice(0, 300) });
    }
    if (lim.overloaded) { // 529: short backoff, attempt not counted (never an hours-long plan pause)
      if (!this.gov.load().pause) this.gov.noteOverloaded(this.now(), `API overloaded: ${lim.why}`);
      this._governorStep(S);
      return requeueUncounted('overloaded');
    }
    if (lim.limited) {
      this.gov.noteLimitFailure(this.now(), `plan limit${lim.kind && lim.kind !== 'limit' ? ` (${lim.kind})` : ''}: ${lim.why}`, c.rate_limit?.resets_at_ms ?? c.resets_at_ms);
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

  _failAttempt(S, task, entry, cause, { escalate = true, note = null, check_output = null, rule = null } = {}) {
    const R = this._R(S.goal).retry;
    const ladder = task.orch.tier_ladder || R.ladder;
    escalate = escalate && !R.no_escalate.includes(cause); // retry.no_escalate (union-only: a layer can add causes, never remove the built-in ones)
    entry.outcome = cause; entry.counted = true;
    task.orch.phase = null; task.updated_at = iso(this.now());
    task.orch.last_failure = { kind: cause, note, check_output, denials: cause === 'denied' ? (task.orch.last_denials || []) : [] };
    this.ev('task.failed', task.assignee, task.id, { cause, attempt: task.attempts, tier: entry.tier, final: false });
    // retry.same_tier_retries: cause -> how many times that cause is retried on the same tier before escalating (default {denied: 1})
    const used = (task.orch.same_tier_used ||= {});
    const sameTier = (R.same_tier_retries[cause] ?? 0) > (cause === 'denied' ? task.orch.denial_retries : used[cause] || 0);
    // retry.ladder: the next rung above this tier (the task's tier may be absent from a custom ladder: then the next higher rung; none above = the top)
    const rank = (t) => TIERS.indexOf(t);
    const next = ladder.includes(entry.tier) ? ladder[ladder.indexOf(entry.tier) + 1] : ladder.find((t) => rank(t) > rank(entry.tier));
    if (sameTier) { if (cause === 'denied') task.orch.denial_retries++; else used[cause] = (used[cause] || 0) + 1; }
    const atTop = escalate && !sameTier && !next; // a failure on the top tier is final
    const final = task.attempts >= task.max_attempts || atTop;
    if (final) {
      task.status = 'failed';
      this.ev('task.failed', 'orchestrator', task.id, { cause, attempts: task.attempts, tier: entry.tier, final: true, rule: atTop && task.attempts < task.max_attempts ? 'retry.ladder' : 'retry.max_attempts' });
      const failing = cause === 'check_failed' && check_output ? failingTestsLine(check_output, task.orch.worktree ? [task.orch.worktree, realpathDeepest(task.orch.worktree)] : null) : null;
      S.goal.orch.halt_reason ??= `task ${task.id} failed after ${task.attempts} attempt(s): ${cause}${cause === 'merge_conflict' && note ? ` (${note})` : ''}${failing ? ` (failing: ${failing})` : ''}`.slice(0, 600);
      S.goal.orch.halt_at_ms ??= this.now();
      this._dropWorktree(S, task).catch(() => {});
    } else {
      if (escalate && !sameTier && next) task.orch.model_tier = next;
      task.status = 'ready';
      this.ev('task.retried', 'orchestrator', task.id, { attempts: task.attempts, max_attempts: task.max_attempts, tier: task.orch.model_tier, reason: cause, rule: rule || (sameTier ? 'retry.same_tier_retries' : escalate ? 'retry.ladder' : 'retry.no_escalate') });
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
    const headBefore = await G.head(wt);
    // anti-cheat, before any check runs worker-written test code: skipped / deleted tests, test configuration, acceptance tests, copied expectations
    const ac = await this._anticheatDiff(S, task, entry, wt);
    if (ac.fail) return this._failAttempt(S, task, entry, ac.fail.kind, { escalate: true, note: ac.note });
    const checks = await runChecks(task.orch.checks, { cwd: wt, env: checkEnv({ base: this.env, tmpDir: this._tmp(task.id) }), allowlist: this._checkAllowlist(goal), ...this._sandboxOpts(goal, wt, task.id) });
    // the authoritative checks must leave the committed worktree exactly as it was (a leftover self-check process, or the check itself, writing into it = fail)
    const dirty = await G.changedPaths(wt).catch((e) => [`(git status failed: ${String(e.message).slice(0, 80)})`]);
    const headAfter = await G.head(wt).catch(() => null);
    if (dirty.length || headAfter !== headBefore) {
      this.ev('orch.check.failed', 'orchestrator', task.id, { reason: 'worktree_mutated_during_checks', paths: dirty.slice(0, 20), head_moved: headAfter !== headBefore });
      await G.git(wt, ['reset', '--hard', headBefore], { allowFail: true }).catch(() => {}); await G.discardChanges(wt).catch(() => {});
      return this._failAttempt(S, task, entry, 'worktree_mutated_during_checks', { escalate: true, note: `the worktree changed while the checks ran: ${dirty.slice(0, 5).join(', ') || 'HEAD moved'}` });
    }
    entry.checks_ok = checks.ok;
    const last = checks.results.at(-1);
    this.ev(checks.ok ? 'orch.check.passed' : 'orch.check.failed', 'orchestrator', task.id, { attempt: entry.n, checks: checks.results.map((r) => ({ argv: r.argv.join(' '), ok: r.ok, exit_code: r.exit_code, timed_out: r.timed_out, sandboxed: r.sandboxed ?? null })) });
    if (c.denials.length) { // permission_denials in a success exit = failed attempt (denials without an approval request)
      task.orch.last_denials = c.denials.map((d) => `${d.tool_name}${d.tool_input_label ? ` ${d.tool_input_label}` : ''}`);
      this.ev('orch.policy.denied', 'orchestrator', task.id, { attempt: entry.n, denials: task.orch.last_denials });
      return this._failAttempt(S, task, entry, 'denied', { escalate: true, note: `denied tool calls: ${task.orch.last_denials.join(', ')}` });
    }
    const tam = checks.results.find((r) => r.harness_tamper);
    if (tam) { this.ev('orch.anticheat.failed', 'orchestrator', task.id, { kind: 'harness_tamper', attempt: entry.n, reason: tam.harness_problems.slice(0, 3).join(' | ').slice(0, 200) }); entry.anticheat = attemptRecord({ findings: entry.anticheat?.findings || [], failed: 'harness_tamper' }); return this._failAttempt(S, task, entry, 'harness_tamper', { escalate: true, note: `anti-cheat harness_tamper: ${tam.harness_problems.slice(0, 3).join(' | ')}`.slice(0, 300) }); }
    for (const r of checks.results) if (r.harness_problems && !r.harness_tamper) this.ev('orch.anticheat.warning', 'orchestrator', task.id, { attempt: entry.n, kinds: ['harness_tamper'], detail: r.harness_problems.slice(0, 2).join(' | ').slice(0, 200) });
    if (!checks.ok) return this._failAttempt(S, task, entry, 'check_failed', { escalate: true, check_output: tail(last?.output || '', 4096) });
    const vac = this._judgeChecks(S.goal, checks.results, entry, task);
    if (vac) return this._failAttempt(S, task, entry, vac.kind, { escalate: true, note: `anti-cheat ${vac.kind}: ${vac.reason}`.slice(0, 300) });

    task.orch.phase = 'integrating'; saveState(this.dir, S);
    const pre = await this._repoGuard(S, this._integrationWt(goal));
    if (pre) { // someone but the engine changed the repo instructions / config on the integration branch: do not merge on top of it
      this.ev('orch.repo_instructions.changed', 'orchestrator', task.id, { msg: pre.msg.slice(0, 300), phase: 'pre-merge' });
      return this._failAttempt(S, task, entry, 'repo_instructions_changed', { escalate: false, note: pre.msg });
    }
    const m = await G.mergeNoFf(this._integrationWt(goal), task.orch.branch, `aos: merge ${task.id}`);
    if (!m.ok) {
      this.ev('orch.integrate.conflict', 'orchestrator', task.id, { rule: 'merge.on_conflict', files: m.files, error: m.error?.slice(0, 300) });
      await this._dropWorktree(S, task, true);
      return this._failAttempt(S, task, entry, 'merge_conflict', { escalate: false, note: `merge conflict in ${m.files.join(', ') || 'files'}: the integration branch changed; redo the task on top of the current files` });
    }
    entry.outcome = 'success'; entry.counted = true;
    task.status = 'done'; task.orch.phase = null; task.orch.result_summary = (c.result?.result || '').slice(0, 400); task.artifacts = [{ type: 'commit', sha: m.sha, branch: task.orch.branch }];
    task.updated_at = iso(this.now());
    task.orch.grants = task.orch.grants.filter((g) => !g.once);
    goal.orch.instructions = await this._hashInstructions(goal.orch.integration_branch); // the engine's own integration commit is sanctioned
    this.ev('orch.integrate.merged', 'orchestrator', task.id, { sha: m.sha, branch: task.orch.branch });
    if (task.orch.role === 'acceptance') { // these test files are now read-only for every other task and re-run from this commit at verify
      const A = this._anti(goal); A.acceptance ||= { items: [] };
      A.acceptance.items = A.acceptance.items.filter((i) => i.task !== task.id); A.acceptance.items.push({ task: task.id, files: ac.acceptFiles, commit: m.sha, counts: await this._acceptanceCounts(goal, wt, ac.acceptFiles) });
      this.ev('orch.anticheat.acceptance', 'orchestrator', task.id, { files: ac.acceptFiles.slice(0, 20), commit: m.sha.slice(0, 12) });
    }
    this.ev('task.completed', task.assignee, task.id, { result: task.orch.result_summary.slice(0, 200), tier: entry.tier, attempts: task.attempts });
    await this._dropWorktree(S, task);
    saveState(this.dir, S);
    // goal criteria run only once every task is done (see _verify): a partial integration branch must never satisfy them
  }

  /** Run the goal's criteria checks on the integration branch (after every merge). */
  async _runCriteria(S) {
    const goal = S.goal;
    const wt = this._integrationWt(goal);
    const allDone = S.tasks.length > 0 && S.tasks.every((t) => t.status === 'done');
    const results = {};
    for (const c of goal.success_criteria) {
      let met;
      if (c.verify === 'human') met = c.met === true; // only a human's `confirm` sets it (never the engine, never a check)
      else if (c.check) {
        const r = await runCheck({ ...c.check, argv: forceTapArgv(c.check.argv) }, { cwd: wt, env: checkEnv({ base: this.env, tmpDir: this._tmp('criteria') }), ...this._sandboxOpts(goal, wt, 'criteria') });
        r.argv = c.check.argv;
        if (r.harness_tamper) { r.output = `ANTI-CHEAT harness_tamper: ${r.harness_problems.slice(0, 3).join(' | ')}\n${r.output}`; (this._anti(goal).criteria ||= {})[c.id] = { kind: 'harness_tamper', reason: r.harness_problems.slice(0, 3).join(' | ').slice(0, 300) }; this.ev('orch.anticheat.failed', 'orchestrator', null, { kind: 'harness_tamper', criterion: c.id, reason: r.harness_problems.slice(0, 2).join(' | ').slice(0, 200) }); }
        if (r.ok) { // a criterion that "passes" by running no / only skipped tests, or fewer tests than the base commit, is not met
          const bl = this._anti(goal).baselines?.[checkKey(r.argv)]; let v = judgeRun(r.argv, parseTestSummary(r.summary_text ?? r.output), bl);
          if (v.ok) v = HG.judgePerFile(bl?.files, r.test_files);
          if (!v.ok) { r.ok = false; r.output = `ANTI-CHEAT ${v.kind}: ${v.reason}\n${r.output}`; (this._anti(goal).criteria ||= {})[c.id] = { kind: v.kind, reason: v.reason }; this.ev('orch.anticheat.failed', 'orchestrator', null, { kind: v.kind, reason: v.reason.slice(0, 200), criterion: c.id }); }
        }
        delete r.summary_text; delete r.test_files; results[c.id] = r; met = r.ok;
      }
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
    if (allDone && !crit.every((c) => c.met) && !o.final_checked) { await this._runCriteria(S); if (o.protected_tests?.files?.length) await this._runProtectedTests(S); if (o.anticheat?.acceptance?.items?.length) await this._runAcceptanceTests(S); o.final_checked = true; saveState(this.dir, S); }
    if (allDone && o.protected_tests?.files?.length && !o.protected_result) await this._runProtectedTests(S); // fail closed: protection on and never run -> run it before anything can be achieved
    if (allDone && o.anticheat?.acceptance?.items?.length && !o.anticheat.acceptance_result) await this._runAcceptanceTests(S); // fail closed, like the protected tests
    if (allDone && o.anticheat?.acceptance_result?.ok === false) {
      goal.status = 'blocked'; goal.blocked_reason = `the ACCEPTANCE tests (written first, read-only for the other tasks) fail against the integration branch: ${whyFailed(o.anticheat.acceptance_result)}`;
      this.ev('goal.blocked', 'orchestrator', null, { reason: goal.blocked_reason });
      return;
    }
    if (allDone && o.protected_result && o.protected_result.ok === false) {
      goal.status = 'blocked'; goal.blocked_reason = `the ORIGINAL existing tests fail against the integration branch (a test was deleted, weakened or the code broke it): ${whyFailed(o.protected_result)}`;
      this.ev('goal.blocked', 'orchestrator', null, { reason: goal.blocked_reason });
      return;
    }
    if (crit.length && crit.every((c) => c.met) && allDone) {
      await Promise.all([...this.workers.values()].map((r) => W.killGroup(r.pgid, { graceMs: this.killGraceMs })));
      this.workers.clear();
      if (this._R(goal).review?.advisory === true && !o.review) await this._advisoryReview(S); // opt-in, advisory only: results go to report.md, never to task or goal state
      for (const t of S.tasks) if (['pending', 'ready', 'running', 'needs_review'].includes(t.status)) { t.status = 'cancelled'; t.updated_at = iso(this.now()); }
      goal.status = 'achieved'; goal.updated_at = iso(this.now());
      this.ev('goal.achieved', 'orchestrator', null, { criteria: crit.length });
    } else if (allDone) {
      const unmet = crit.filter((c) => !c.met);
      goal.status = 'blocked';
      goal.blocked_reason = unmet.every((c) => c.verify === 'human') ? `awaiting human confirmation: ${unmet.map((c) => c.id).join(', ')}` : `all tasks done but criteria not met: ${unmet.map((c) => c.id).join(', ')}`;
      this.ev('goal.blocked', 'orchestrator', null, { reason: goal.blocked_reason });
    }
  }

  async _advisoryReview(S) {
    const goal = S.goal; const o = goal.orch;
    const tier = this._R(goal).review.tier || 'haiku';
    const r = await runAdvisoryReview({ goal, anticheat: reviewerNotes(S), orchDir: this.orchDir, env: this.env, bin: this.bin, tier, spawnFn: this.spawnFn, killGraceMs: this.killGraceMs });
    o.review = { tier, text: r.text ?? null, error: r.error ?? null, new_tokens: r.usage?.new_tokens ?? 0, notional_usd: r.usage?.notional_usd ?? 0, at: iso(this.now()) };
    o.usage.new_tokens += o.review.new_tokens; o.usage.notional_usd = (o.usage.notional_usd || 0) + o.review.notional_usd;
    this.ev('orch.review.advisory', 'orchestrator', null, { tier, ok: !r.error, error: r.error ?? null, new_tokens: o.review.new_tokens });
    saveState(this.dir, S);
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
    if (!this._rulesCheck(S).ok) return this._planRejected(S, ['rules.snapshot.json was modified or is missing']);
    const rv = this._rulesView(goal); // compiled rules and worker policy of the (intact) snapshot: the plan must lie inside them (R7, G4)
    const validate = (pl) => validatePlan(pl, { max_tasks: rv ? rv.compiled.plan.max_tasks : o.budgets.max_tasks, check_allowlist: this._checkAllowlist(goal), acceptance_first: rv?.compiled.checks.acceptance_first === true && goal.success_criteria.some((c) => c.check), ...(rv ? { rules: rv.compiled, policy: rv.policy } : {}) });
    let v = validate(plan);
    // a planner plan that breaks the rules gets AUTO_REPLANS automatic re-plan(s) with the exact validation errors fed back (its tokens are counted in the goal's usage like any planner call)
    while (!v.ok && source === 'planner' && (o.replans || 0) < AUTO_REPLANS && !o.halt_reason && o.usage.new_tokens < o.budgets.max_new_tokens) {
      o.replans = (o.replans || 0) + 1;
      this.ev('orch.plan.replan', 'orchestrator', null, { attempt: o.replans, of: AUTO_REPLANS, errors: v.errors.slice(0, 20), counted_in_budget: true });
      saveState(this.dir, S);
      const r2 = await this._runPlanner(S, { errors: v.errors });
      if (r2.error) return this._planRejected(S, [`re-plan failed: ${r2.error}`, ...v.errors]);
      plan = r2.plan; v = validate(plan);
    }
    if (!v.ok) return this._planRejected(S, o.replans ? [`still invalid after ${o.replans} automatic re-plan(s)`, ...v.errors] : v.errors);
    o.plan_warnings = await this._planWarnings(goal, v.tasks, v.notes);
    for (const n of v.notes || []) this.ev('orch.plan.deps_added', 'orchestrator', n.task, { added: n.added, rule: 'plan.whole_suite_check' });
    o.tasks_hash_v = 2; // new plans are hashed with their description/output_contract/acceptance too (older goals keep v1 so their approval still verifies)
    S.tasks = toTasks(v.tasks, goal, this.now(), this._R(goal).retry.ladder);
    S.agents = S.tasks.map((t) => ({ id: t.assignee, role: 'worker', capabilities: ['edit', 'bash'], can_delegate: false, status: 'idle', current_task: null, last_event_at: null, orch: { tier: t.orch.model_tier } }));
    atomicWrite(this.P.plan, { source, plan });
    for (const t of S.tasks) this.ev('task.created', 'orchestrator', t.id, { depends_on: t.depends_on, tier: t.orch.model_tier });
    this.ev('orch.plan.created', 'orchestrator', null, { tasks: S.tasks.length, source, risks: Array.isArray(plan.risks) ? plan.risks.slice(0, 10) : [] });
    o.plan_fingerprint = this._fingerprint(S);
    let review = humanReviewReason(S.tasks);
    const repoLoose = (readJSON(this.P.rules, null)?.loosenings || []).filter((l) => l.layer === 'repo');
    if (!review && repoLoose.length) review = `${repoLoose.length} repo rule loosening(s) are applied (${repoLoose.slice(0, 3).map((l) => l.rule_id.split('@')[0]).join(', ')}): a human must review them`;
    if (o.approval_policy.plan === 'auto' && !review && this._activate(S, 'auto')) { /* only plans without commands may auto-approve */ } else {
      if (o.approval_policy.plan === 'auto' && review) this.ev('orch.plan.approval_required', 'orchestrator', null, { rule: 'plan.approval', reason: review, note: 'plan_approval "auto" does not apply to plans with commands or applied repo loosenings' });
      o.plan_state = 'awaiting_approval'; o.plan_awaiting_since_ms = this.now(); this.ev('goal.updated', 'orchestrator', null, { status: 'draft', plan_state: 'awaiting_approval' });
    }
    saveState(this.dir, S);
  }

  /** Informational warnings shown at plan approval: {taskId|'goal': [text]}. (a) a path_scope that includes an EXISTING test file; (b) a check on a test that looks like it needs a local server while checks.allow_loopback is false. */
  async _planWarnings(goal, tasks, notes = []) {
    const o = goal.orch; const w = {}; const add = (k, m) => { (w[k] ||= []).push(m); };
    for (const n of notes) add(n.task, n.text); // dependencies validatePlan added for a whole-suite task check
    const prot = o.protected_tests?.files || [];
    if (o.acceptance_first === true && !goal.success_criteria.some((c) => c.check)) add('goal', 'checks.acceptance_first is on but NO success criterion has a check, so no acceptance tests are required for this goal (the rule applies only to goals with a code criterion). Add a criterion with a check, or accept that nothing is written test-first.');
    for (const t of tasks) {
      const hit = scopeHitsTests(t.path_scope, prot);
      if (hit.length) add(t.id, `path_scope includes EXISTING test file(s) ${hit.slice(0, 5).join(', ')}${hit.length > 5 ? ` (+${hit.length - 5})` : ''}. Existing tests must stay unchanged: the originals from the base commit are re-run at verify and the goal cannot be achieved if one fails. Approve only if modifying them is really intended.`);
    }
    const critArgvs = goal.success_criteria.filter((c) => c.check).map((c) => c.check.argv);
    for (const c of goal.success_criteria) if (c.check && argvProblem(c.check.argv)) add('goal', `success criterion ${c.id}: ${argvProblem(c.check.argv)}`); // hand-written goals skip the draft validator
    for (const t of tasks) { // anti-cheat: what a human is asked to approve here lifts a rule for exactly these files / this task
      const inputs = new Set(checkInputPaths([...t.checks.map((c) => c.argv), ...critArgvs]));
      const hot = t.path_scope.filter((g) => !/[*?{}[\]!]/.test(g) && (isConfigPath(g) || inputs.has(g.replace(/^\.\//, ''))));
      if (hot.length) add(t.id, `CONFIG FILE IN SCOPE: ${hot.join(', ')}. This task may change test configuration or a file a check runs (package.json scripts, runner config, check scripts); the anti-cheat check_config_changed rule is lifted for exactly these files. Approve only if that is intended.`);
      if (t.allow_skip?.length) add(t.id, `ALLOW_SKIP: this task may add skipped/todo tests (the tests_skipped rule is lifted for it). Reason(s): ${t.allow_skip.join(' | ')}`);
    }
    if (o.allow_loopback !== true && o.worktree_root) { // (a supplied plan has no integration worktree yet: nothing to read)
      const wt = this._integrationWt(goal);
      const read = async (rel) => { const f = path.join(wt, rel); return fs.existsSync(f) && fs.statSync(f).size < 200000 ? fs.readFileSync(f, 'utf8') : null; };
      for (const t of tasks) for (const m of await serverWarnings(t.checks.map((c) => c.argv), read, { label: (i) => `check ${i + 1}` })) add(t.id, m);
      for (const m of await serverWarnings(goal.success_criteria.filter((c) => c.check).map((c) => c.check.argv), read, { label: (i) => `success-criteria check ${i + 1}` })) add('goal', m);
    }
    for (const [k, v] of Object.entries(w)) this.ev('orch.plan.warning', 'orchestrator', k === 'goal' ? null : k, { warnings: v.slice(0, 5) });
    return w;
  }

  /** Re-run the ORIGINAL test files (base_commit) against the integration branch: they are written over the integration tree, run sandboxed, and the tree is restored. */
  async _runProtectedTests(S) {
    const goal = S.goal; const o = goal.orch; const pt = o.protected_tests;
    const wt = this._integrationWt(goal);
    const { js, other } = runnerFor(pt.files);
    const res = { ok: true, files: js.length, not_executed: other.slice(0, 20), at: iso(this.now()) };
    if (js.length) {
      try {
        for (const f of js) { const b = await G.showBlob(o.repo, pt.base_commit, f); if (b) { fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true }); fs.writeFileSync(path.join(wt, f), b); } }
        const r = await runCheck({ argv: forceTapArgv(['node', '--test', ...js]), timeout_s: Math.min(this._R(goal).checks.max_timeout_s, 600) }, { cwd: wt, env: checkEnv({ base: this.env, tmpDir: this._tmp('protected') }), ...this._sandboxOpts(goal, wt, 'protected') });
        res.ok = r.ok; if (!r.ok) { res.output = tail(r.output || '', 2000); res.failing = failingTestsLine(r.output, [wt, realpathDeepest(wt)]); }
        const sm = parseTestSummary(r.summary_text ?? r.output);
        if (r.harness_tamper) { res.ok = false; res.kind = 'harness_tamper'; res.output = `anti-cheat harness_tamper: ${r.harness_problems.slice(0, 3).join(' | ')}`.slice(0, 600); }
        else if (r.ok && !(sm && sm.tests > 0 && sm.pass > 0)) { res.ok = false; res.output = `anti-cheat: the original tests ran ${sm ? `${sm.tests} test(s) of which ${sm.pass} passed` : 'with no countable test summary'}`; }
        else if (r.ok) { const v = HG.judgePerFile(this._anti(goal).protected_counts?.files, r.test_files); if (!v.ok) { res.ok = false; res.kind = v.kind; res.output = `anti-cheat ${v.kind}: ${v.reason}`; } }
      } catch (e) { res.ok = false; res.output = `could not run the original tests: ${String(e.message).slice(0, 300)}`; } finally { await G.discardChanges(wt).catch(() => {}); }
    }
    o.protected_result = res;
    this.ev('orch.protected_tests.checked', 'orchestrator', null, { ok: res.ok, files: res.files, not_executed: other.length });
    saveState(this.dir, S);
    return res;
  }

  // ------------------------------------------------------------------ anti-cheat (lib/anticheat.mjs)
  _anti(goal) { return (goal.orch.anticheat ||= { baselines: {}, criteria: {} }); }

  /** Test files of a worktree: [{path, text}] (bounded). */
  async _readTestFiles(wt) {
    const out = [];
    const ls = (await G.git(wt, ['ls-files', '-z'], { allowFail: true })).stdout.split('\0').filter((f) => f && isTestPath(f) && !f.split('/').includes('node_modules'));
    for (const f of ls.slice(0, 300)) { try { const abs = path.join(wt, f); if (fs.statSync(abs).size <= 200000) out.push({ path: f, text: fs.readFileSync(abs, 'utf8') }); } catch { /* gone */ } }
    return out;
  }

  /** Before the first dispatch the integration branch IS the base commit: run each test check there once and record how many tests it counts. Static declaration counts are the fallback. */
  async _ensureBaselines(S, wt) {
    const goal = S.goal; const A = this._anti(goal);
    A.baselines_done = true;
    const checks = new Map();
    for (const c of goal.success_criteria) if (c.check && isTestRunArgv(c.check.argv)) checks.set(checkKey(c.check.argv), c.check);
    for (const t of S.tasks) for (const c of t.orch.checks) if (isTestRunArgv(c.argv)) checks.set(checkKey(c.argv), c);
    let files = null;
    for (const [key, c] of checks) {
      let b = null; const runs = [];
      for (let i = 0; i < BASELINE_RUNS; i++) { // twice, the larger count wins: a test file that registers a different number of tests per run (clock, randomness) cannot record a low baseline by luck
        try {
          const r = await runCheck({ argv: forceTapArgv(c.argv), timeout_s: Math.min(c.timeout_s || 300, 600) }, { cwd: wt, env: checkEnv({ base: this.env, tmpDir: this._tmp('baseline') }), ...this._sandboxOpts(goal, wt, 'baseline') });
          const sm = r.rejected ? null : summaryOfRun(r);
          runs.push(sm ? { tests: sm.tests, pass: sm.pass, skipped: sm.skipped, todo: sm.todo, source: 'run', ...(r.test_files ? { files: HG.compactFiles(r.test_files) } : {}) } : null);
        } catch { runs.push(null); /* static fallback */ } finally { await G.discardChanges(wt).catch(() => {}); }
        if (!runs[i]) break;
      }
      b = mergeBaselineRuns(runs);
      if (b?.unstable) this.ev('orch.anticheat.warning', 'orchestrator', null, { kinds: ['baseline_unstable'], detail: `${key.slice(0, 80)}: the baseline runs counted different numbers of tests; the larger count is enforced` });
      if (!b) { files ||= await this._readTestFiles(wt); b = { tests: staticTestCount(c.argv, files), source: 'static' }; }
      A.baselines[key] = { ...b, at: iso(this.now()) };
    }
    await this._ensureProtectedCounts(S, wt);
    this.ev('orch.anticheat.baseline', 'orchestrator', null, { checks: Object.entries(A.baselines).slice(0, 20).map(([k, b]) => ({ check: k.slice(0, 120), tests: b.tests, source: b.source })) });
    saveState(this.dir, S);
  }

  /** Per-file test counts of the protected (existing) test files on the base commit: the integration branch IS the base commit here. */
  async _ensureProtectedCounts(S, wt) {
    const goal = S.goal; const o = goal.orch; const A = this._anti(goal);
    const { js } = runnerFor(o.protected_tests?.files || []);
    if (!js.length || A.protected_counts) return;
    const runs = [];
    for (let i = 0; i < BASELINE_RUNS; i++) {
      try {
        const r = await runCheck({ argv: forceTapArgv(['node', '--test', ...js]), timeout_s: Math.min(this._R(goal).checks.max_timeout_s, 600) }, { cwd: wt, env: checkEnv({ base: this.env, tmpDir: this._tmp('baseline') }), ...this._sandboxOpts(goal, wt, 'baseline') });
        if (!r.test_files) break;
        runs.push({ tests: 0, files: HG.compactFiles(r.test_files) });
      } catch { break; /* no per-file counts: the total-count rules still apply */ } finally { await G.discardChanges(wt).catch(() => {}); }
    }
    const m = mergeBaselineRuns(runs);
    if (m) A.protected_counts = { files: m.files, at: iso(this.now()), ...(m.unstable ? { unstable: true } : {}) };
  }

  /** Per-file test counts of an acceptance task's files, from the attempt worktree (== the committed version). null when they cannot be counted. */
  async _acceptanceCounts(goal, wt, files) {
    const { js } = runnerFor(files || []);
    if (!js.length) return null;
    try {
      const r = await runCheck({ argv: forceTapArgv(['node', '--test', ...js]), timeout_s: Math.min(this._R(goal).checks.max_timeout_s, 600) }, { cwd: wt, env: checkEnv({ base: this.env, tmpDir: this._tmp('acceptance') }), ...this._sandboxOpts(goal, wt, 'acceptance') });
      return r.test_files ? HG.compactFiles(r.test_files) : null;
    } catch { return null; }
  }

  /** Diff-based rules for one attempt. Sets entry.anticheat. -> {fail?: finding, note?, acceptFiles[]}. */
  async _anticheatDiff(S, task, entry, wt) {
    const goal = S.goal; const o = goal.orch;
    let res;
    try {
      const { base, files } = await attemptDiff(wt, o.integration_branch);
      const accTasks = S.tasks.filter((t) => t.orch.role === 'acceptance');
      const items = o.anticheat?.acceptance?.items || [];
      const ctx = { path_scope: task.orch.path_scope, allow_skip: task.orch.allow_skip || [], checks: [...task.orch.checks.map((c) => c.argv), ...goal.success_criteria.filter((c) => c.check).map((c) => c.check.argv)],
        acceptance: accTasks.length ? { files: items.flatMap((i) => i.files), scopes: accTasks.flatMap((t) => t.orch.path_scope) } : null, is_acceptance: task.orch.role === 'acceptance', literal_copy: o.literal_copy === 'fail' ? 'fail' : 'warn', harness_tamper: o.harness_tamper === 'warn' ? 'warn' : 'fail' };
      const io = { before: async (p) => { if (!base) return null; const b = await G.showBlob(o.repo, base, p).catch(() => null); return b ? b.toString('utf8') : null; },
        after: async (p) => { try { return fs.readFileSync(path.join(wt, p), 'utf8'); } catch { return null; } }, tests: () => this._readTestFiles(wt) };
      const { findings } = await analyzeDiff(files, ctx, io);
      const acceptFiles = files.filter((f) => f.status !== 'D' && isTestPath(f.path)).map((f) => f.path);
      if (ctx.is_acceptance) { // an acceptance task that adds no test is vacuous
        const texts = []; for (const p of acceptFiles) { const t = await io.after(p); if (t !== null) texts.push({ path: p, text: t }); }
        if (!staticTestCount(['node', '--test'], texts)) findings.push({ kind: 'acceptance_empty', severity: 'fail', detail: 'an acceptance task must add at least one test( / it( declaration in a test file' });
      }
      res = { findings, acceptFiles };
    } catch (e) { // a failure of the analysis itself is not a verdict on the worker: record it and go on (the checks and the final re-runs still apply)
      this.ev('orch.anticheat.warning', 'orchestrator', task.id, { error: `anti-cheat analysis failed: ${String(e.message).slice(0, 200)}` });
      return { acceptFiles: [] };
    }
    const fails = failsOf(res.findings); const first = fails[0] || null;
    entry.anticheat = attemptRecord({ findings: res.findings, failed: first ? first.kind : null });
    if (first) {
      this.ev('orch.anticheat.failed', 'orchestrator', task.id, { kind: first.kind, attempt: entry.n, reason: summarizeFindings(fails, 3), paths: fails.map((f) => f.path).filter(Boolean).slice(0, 10) });
      return { fail: first, note: `anti-cheat ${first.kind}: ${summarizeFindings(fails, 3)}`.slice(0, 300), acceptFiles: res.acceptFiles };
    }
    const soft = res.findings.filter((f) => f.severity !== 'fail');
    if (soft.length) this.ev('orch.anticheat.warning', 'orchestrator', task.id, { attempt: entry.n, kinds: [...new Set(soft.map((f) => `${f.kind}${f.severity === 'allowed' ? ':allowed' : ''}`))], count: soft.length, detail: summarizeFindings(soft, 2) });
    return { acceptFiles: res.acceptFiles };
  }

  /** Judge the (passing) check results of an attempt: 0 tests, only skipped tests, fewer tests than the base commit. -> {kind, reason} for the first bad result, else null. */
  _judgeChecks(goal, results, entry, task) {
    const A = this._anti(goal); const tests = []; let bad = null;
    for (const r of results) {
      const sm = summaryOfRun(r); const b = A.baselines?.[checkKey(r.argv)];
      let v = judgeRun(r.argv, sm, b, { allowSkip: !!task?.orch.allow_skip?.length });
      if (v.ok) v = HG.judgePerFile(b?.files, r.test_files);
      if (sm) tests.push({ check: checkKey(r.argv).slice(0, 120), tests: sm.tests, pass: sm.pass, skipped: sm.skipped, todo: sm.todo, baseline: b ? b.tests : null });
      if (!v.ok && !bad) bad = { kind: v.kind, reason: v.reason };
    }
    const rec = entry.anticheat || attemptRecord({});
    entry.anticheat = attemptRecord({ findings: rec.findings, failed: bad ? bad.kind : rec.failed, tests });
    if (bad) this.ev('orch.anticheat.failed', 'orchestrator', null, { kind: bad.kind, attempt: entry.n, reason: bad.reason.slice(0, 200) });
    else this.ev('orch.anticheat.passed', 'orchestrator', null, { attempt: entry.n, tests: tests.map((t) => t.tests), warnings: rec.findings.filter((f) => f.severity !== 'fail').length });
    return bad;
  }

  /** Re-run the acceptance test files from the commit of the task that wrote them (not from whatever the integration tree now holds). */
  async _runAcceptanceTests(S) {
    const goal = S.goal; const o = goal.orch; const A = this._anti(goal);
    const wt = this._integrationWt(goal);
    const files = []; for (const i of A.acceptance.items) for (const f of i.files) files.push({ f, commit: i.commit });
    const js = files.filter((x) => /\.(m?js|cjs)$/.test(x.f));
    let lastFiles = null;
    const res = { ok: true, files: js.length, not_executed: files.filter((x) => !js.includes(x)).map((x) => x.f).slice(0, 20), at: iso(this.now()) };
    try {
      for (const { f, commit } of js) { const b = await G.showBlob(o.repo, commit, f); if (b) { fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true }); fs.writeFileSync(path.join(wt, f), b); } }
      if (js.length) {
        const r = await runCheck({ argv: forceTapArgv(['node', '--test', ...js.map((x) => x.f)]), timeout_s: Math.min(this._R(goal).checks.max_timeout_s, 600) }, { cwd: wt, env: checkEnv({ base: this.env, tmpDir: this._tmp('acceptance') }), ...this._sandboxOpts(goal, wt, 'acceptance') });
        const sm = summaryOfRun(r); res.tests = sm ? sm.tests : null; lastFiles = r.test_files || null;
        res.ok = r.ok; if (!r.ok) { res.output = tail(r.output || '', 2000); res.failing = failingTestsLine(r.output, [wt, realpathDeepest(wt)]); }
        else if (r.harness_tamper) { res.ok = false; res.kind = 'harness_tamper'; res.output = `anti-cheat harness_tamper: ${r.harness_problems.slice(0, 3).join(' | ')}`.slice(0, 600); }
        else if (!(sm && sm.tests > 0 && sm.pass > 0)) { res.ok = false; res.output = `anti-cheat: the acceptance tests ran ${sm ? `${sm.tests} test(s) of which ${sm.pass} passed` : 'with no countable test summary'}`; }
      }
    } catch (e) { res.ok = false; res.output = `could not run the acceptance tests: ${String(e.message).slice(0, 300)}`; } finally { await G.discardChanges(wt).catch(() => {}); }
    if (res.ok && lastFiles) for (const i of A.acceptance.items) { const v = HG.judgePerFile(i.counts, lastFiles); if (!v.ok) { res.ok = false; res.kind = v.kind; res.output = `anti-cheat ${v.kind}: ${v.reason}`; break; } }
    A.acceptance_result = res;
    this.ev('orch.anticheat.acceptance', 'orchestrator', null, { ok: res.ok, files: res.files, tests: res.tests ?? null, rerun: true });
    saveState(this.dir, S);
    return res;
  }

  async _planRejected(S, errors) {
    const goal = S.goal;
    goal.orch.plan_state = 'rejected'; goal.status = 'blocked'; goal.blocked_reason = `plan rejected: ${errors.slice(0, 5).join('; ')}`;
    this.ev('orch.plan.rejected', 'orchestrator', null, { errors: errors.slice(0, 20) });
    this.ev('goal.blocked', 'orchestrator', null, { reason: goal.blocked_reason });
    saveState(this.dir, S);
  }

  async _runPlanner(S, replan = null) {
    const goal = S.goal; const o = goal.orch; const PR = this._R(goal).plan; const pTier = PR.planner_tier;
    const wt = this._integrationWt(goal);
    const guard = this._configGuard(goal, wt);
    if (guard) return { error: guard };
    const rc = this._rulesView(goal)?.compiled;
    const { prompt } = buildPlannerPrompt({ goal, facts: gatherRepoFacts(wt), replan, constraints: { max_tasks: rc ? rc.plan.max_tasks : o.budgets.max_tasks, tiers: startableTiers(rc?.plan.tiers ?? TIERS, rc?.plan.max_start_tier), max_start_tier: rc?.plan.max_start_tier, scope_deny: (rc?.plan.scope_deny || []).map((d) => d.glob), protected_tests: o.protected_tests?.files || [], check_allowlist: this._checkAllowlist(goal), acceptance_first: rc?.checks.acceptance_first === true && goal.success_criteria.some((c) => c.check), self_check: rc?.worker.self_check === true, self_checks_max: rc?.worker.self_checks_max } });
    const sessionId = crypto.randomUUID();
    const policyFile = path.join(this.P.workers, 'planner.policy.json');
    atomicWrite(policyFile, { ...this._policyHead(goal), ctx: { worktree: realpathDeepest(wt), path_scope: [], allowed_tools: ['Read', 'Glob', 'Grep'], allowed_commands: [], grants: [], home: this.env.HOME, base_branch: o.base_branch } });
    const stdout = this.wpath('planner', 1, 'stream.ndjson'); const stderr = this.wpath('planner', 1, 'stderr');
    for (const f of [stdout, stderr]) { try { fs.unlinkSync(f); } catch { /* none */ } }
    const args = W.buildArgs({ prompt, tier: pTier, sessionId, maxTurns: o.budgets.max_turns, maxBudgetUsd: o.budgets.attempt_usd_cap, tools: W.READ_ONLY_TOOLS, allowedTools: W.READ_ONLY_TOOLS, appendSystemPrompt: 'You are the planner for an AOS-1 goal. You do not edit files. Output ONLY one JSON object.', settingsFile: path.join(this.P.workers, 'settings.json') });
    const env = W.buildEnv({ base: this.env, goalId: goal.id, taskId: 'planner', attempt: 1, worktree: wt, policyFile, approvalsDir: this.P.approvals, tmpDir: this._tmp('planner'), decisionLog: path.join(this.P.workers, 'decisions.ndjson'), bin: this.bin, fakeEnv: this.testFakeEnv });
    let cmd;
    try { cmd = this._workerCommand(goal, args, env, { worktree: wt, tmpDir: env.TMPDIR, policyFile }); } catch (e) { return { error: e.message }; }
    const h = W.startWorker({ bin: cmd.bin, args: cmd.args, env, cwd: wt, stdoutFile: stdout, stderrFile: stderr, spawnFn: this.spawnFn });
    if (h.pid) atomicWrite(this.wpath('planner', 1, 'pid.json'), { pid: h.pid, pgid: h.pgid, started_at: iso(this.now()), session_id: sessionId, tier: pTier, sandboxed: cmd.sandboxed });
    o.plan_session_id = sessionId; o.usage.workers_started++;
    this.ev('orch.worker.started', 'orchestrator', null, { role: 'planner', pid: h.pid, tier: pTier, rule: 'plan.planner_tier', session_id: sessionId, sandboxed: cmd.sandboxed });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; W.signalGroup(h.pgid, 'SIGTERM'); setTimeout(() => W.signalGroup(h.pgid, 'SIGKILL'), this.killGraceMs).unref(); }, this.plannerTimeoutMs ?? PR.planner_timeout_s * 1000);
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
    const b = checkBudgets(goal, { nowMs: this.now(), seq, inflightTokens: inflight, softFrac: this._R(goal).budgets.soft_frac });
    o.soft = b.soft;
    if (b.hard.length && !o.halt_reason) {
      o.halt_reason = `budget: ${b.hard.join('; ')}`; o.halt_at_ms = this.now();
      this.ev('budget.exceeded', 'orchestrator', null, { ticks: seq, new_tokens: o.usage.new_tokens + inflight, notional_usd: o.usage.notional_usd, reasons: b.hard, rule: budgetRule(b.hard[0]) });
    }
  }

  async _dispatch(S) {
    const goal = S.goal; const o = goal.orch; const B = o.budgets;
    if (!this._gate?.dispatch) return;
    if (!o.unsandboxed_checks && !this.testUnsandboxed && !sandboxAvailable({ bin: this.sandboxBin }).ok) {
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
    if (S.tasks.some((t) => t.status === 'ready') && !o.anticheat?.baselines_done && S.tasks.every((t) => t.attempts === 0)) await this._ensureBaselines(S, await this._ensureIntegration(S));
    const running = () => S.tasks.filter((t) => t.status === 'running');
    let slots = B.max_parallel - running().length;
    for (const task of S.tasks) {
      if (slots <= 0) break;
      if (task.status !== 'ready') continue;
      if ((o.soft || []).length && task.orch.model_tier === 'opus' && this._R(goal).parallel.soft_budget_blocks_tier === 'opus') continue; // soft budget: no new opus-tier work
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

  /** `claude --version`, probed once per engine start and cached. */
  _claudeVersion() {
    return this._cv ??= Promise.resolve(typeof this.claudeVersionProbe === 'function' ? this.claudeVersionProbe() : this.claudeVersionProbe ?? probeClaudeVersion(this.bin, this.env));
  }

  async _startAttempt(S, task) {
    const goal = S.goal; const o = goal.orch;
    const claudeVersion = (await this._claudeVersion().catch(() => null)) || null;
    if (claudeVersion && !o.claude_version_start) o.claude_version_start = claudeVersion;
    const seq = (task.orch.worker_seq || 0) + 1;
    const tier = task.orch.model_tier;
    const sessionId = crypto.randomUUID();
    task.orch.worker_seq = seq; task.status = 'running'; task.attempts += 1; task.orch.phase = 'working'; task.updated_at = iso(this.now());
    task.orch.attempt_log.push({ n: seq, tier, session_id: sessionId, started_at: iso(this.now()), ended_at: null, outcome: null, denials: 0, new_tokens: 0, exit_code: null, counted: true, claude_version: claudeVersion });
    const agent = S.agents.find((a) => a.id === task.assignee);
    if (agent) { agent.status = 'running'; agent.current_task = task.id; agent.last_event_at = iso(this.now()); agent.orch = { pid: null, session_id: sessionId, tier }; }
    o.usage.workers_started++;
    this.ev('task.started', task.assignee, task.id, { attempt: task.attempts, tier, seq });
    saveState(this.dir, S); // intent first, spawn second (crash in between = lost, requeued uncounted)

    await this._ensureIntegration(S);
    const wt = path.join(o.worktree_root, task.id);
    // EVERY attempt (retries too) starts on a fresh branch from the CURRENT integration tip: a retry must see what other tasks merged since the
    // previous attempt (a reused branch keeps the old base, so a whole-suite check keeps failing on work that is already merged)
    const baseSha = await this._freshTaskBranch(S, task, wt);
    task.orch.attempt_log.at(-1).base_sha = baseSha;
    const w = await G.worktreeAdd(o.repo, goal.id, wt, task.orch.branch, baseSha);
    if (w.branch_created && !o.created_branches.includes(task.orch.branch)) o.created_branches.push(task.orch.branch);
    task.orch.worktree = wt;
    const real = realpathDeepest(wt);
    const policyFile = this.wpath(task.id, seq, 'policy.json');
    const sc = this._selfCheckSetup(goal, task, real);
    atomicWrite(policyFile, { ...this._policyHead(goal), ctx: { worktree: real, path_scope: task.orch.path_scope, allowed_tools: task.orch.allowed_tools,
      allowed_commands: task.orch.allowed_commands, grants: task.orch.grants, home: this.env.HOME, base_branch: o.base_branch, ...(sc ? { self_check: sc.ctx } : {}) } });
    const deps = task.depends_on.map((d) => S.tasks.find((x) => x.id === d)).filter(Boolean).map((d) => ({ id: d.id, title: d.title, summary: d.orch.result_summary }));
    const prompt = W.buildWorkerPrompt({ goal, task, deps, previous: task.orch.last_failure ? { check_output: task.orch.last_failure.check_output, denials: task.orch.last_failure.denials, note: task.orch.last_failure.note } : null, selfCheck: sc ? { max: sc.ctx.max } : null });
    fs.writeFileSync(this.wpath(task.id, seq, 'prompt.txt'), prompt, { mode: 0o600 });
    const args = W.buildArgs({ prompt, tier, sessionId, maxTurns: o.budgets.max_turns, maxBudgetUsd: o.budgets.attempt_usd_cap, settingsFile: path.join(this.P.workers, 'settings.json') });
    const env = W.buildEnv({ base: this.env, goalId: goal.id, taskId: task.id, attempt: task.attempts, worktree: real, policyFile, approvalsDir: this.P.approvals, tmpDir: this._tmp(task.id), decisionLog: path.join(this.P.workers, 'decisions.ndjson'), bin: this.bin, fakeEnv: this.testFakeEnv });
    const stdout = this.wpath(task.id, seq, 'stream.ndjson'); const stderr = this.wpath(task.id, seq, 'stderr');
    const cmd = this._workerCommand(goal, args, env, { worktree: real, tmpDir: env.TMPDIR, policyFile, selfCheckResDir: sc?.state.resDir });
    const h = W.startWorker({ bin: cmd.bin, args: cmd.args, env, cwd: wt, stdoutFile: stdout, stderrFile: stderr, spawnFn: this.spawnFn });
    const rec = { task: task.id, seq, pid: h.pid, pgid: h.pgid, session_id: sessionId, tail: new W.StreamTail(stdout), handle: h, exited: null,
      startedMs: this.now(), lastProgressMs: this.now(), killReason: null, termAtReal: 0, selfCheck: sc ? sc.state : null };
    this.workers.set(task.id, rec);
    if (h.pid) atomicWrite(this.wpath(task.id, seq, 'pid.json'), { pid: h.pid, pgid: h.pgid, started_at: iso(this.now()), session_id: sessionId, tier, attempt: task.attempts, sandboxed: cmd.sandboxed });
    if (agent?.orch) agent.orch.pid = h.pid;
    h.done.then((info) => { if (this.workers.get(task.id) === rec) { rec.exited = info; this._wake(); } });
    this.ev('agent.spawned', task.assignee, task.id, { pid: h.pid, tier, session_id: sessionId });
    this.ev('orch.worker.started', 'orchestrator', task.id, { pid: h.pid, tier, attempt: task.attempts, seq, sandboxed: cmd.sandboxed });
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
  /** Before an attempt: drop the task's previous worktree and branch (only a branch this engine created), so worktreeAdd branches anew. -> the integration tip sha the attempt starts from. */
  async _freshTaskBranch(S, task, wt) {
    const o = S.goal.orch;
    if (task.orch.worktree || fs.existsSync(wt)) await G.worktreeRemove(o.repo, task.orch.worktree || wt);
    task.orch.worktree = null;
    if (await G.branchExists(o.repo, task.orch.branch)) {
      if (!o.created_branches.includes(task.orch.branch)) throw new Error(`branch ${task.orch.branch} exists but was not created by this engine: refusing to reuse or delete it`);
      if (!(await G.deleteOwnBranch(o.repo, S.goal.id, task.orch.branch))) throw new Error(`cannot delete the previous attempt's branch ${task.orch.branch}`);
    } else if (!o.created_branches.includes(task.orch.branch)) { o.created_branches.push(task.orch.branch); saveState(this.dir, S); } // recorded BEFORE it exists: a crash in between never leaves an unowned branch
    return (await G.git(o.repo, ['rev-parse', '--verify', `refs/heads/${o.integration_branch}^{commit}`])).stdout.trim();
  }
  /** {bin, args, sandboxed}: the worker argv, wrapped in sandbox-exec when the goal sets orch.sandbox_workers (throws if unavailable). */
  _workerCommand(goal, args, env, { worktree, tmpDir, policyFile, selfCheckResDir }) {
    if (!goal.orch.sandbox_workers) return { bin: this.bin, args, sandboxed: false };
    const av = workerSandboxAvailable({ bin: this.sandboxBin });
    if (!av.ok) throw new Error(`worker OS sandbox unavailable (${av.reason}): orch.sandbox_workers is set, refusing to start the worker unsandboxed`);
    const w = wrapWorkerCommand([W.resolveBin(this.bin, env.PATH), ...args], { worktree, tmpDir, policyFile, approvalsDir: this.P.approvals, selfCheckResDir,
      decisionLog: path.join(this.P.workers, 'decisions.ndjson'), settingsFile: path.join(this.P.workers, 'settings.json'), hookDir: path.dirname(this.hookScript),
      gitCommon: path.join(goal.orch.repo, '.git'), claudeBin: W.resolveBin(this.bin, env.PATH), sessionId: args[args.indexOf('--session-id') + 1], sysTmp: this.testFakeEnv && env.AOS_FAKE_STATE ? path.dirname(env.AOS_FAKE_STATE) : undefined /* test mode only: the scripted fake's scenario + state */, home: this.env.HOME, profileDir: path.join(this.dir, 'sandbox'), developerDirs: this._devDirs(),
      bin: this.sandboxBin, ...(this.workerSandbox || {}) });
    return { bin: w.bin, args: w.args, sandboxed: true };
  }
  // ------------------------------------------------------------------ worker self-check (lib/selfcheck.mjs)
  /** For an attempt whose rules allow it: {ctx (goes into the policy file), state (engine memory)}; else null. The inbox is cleared per attempt. */
  _selfCheckSetup(goal, task, realWt) {
    const R = this._R(goal).worker;
    if (R.self_check !== true || !(task.orch.checks || []).length) return null;
    const dir = path.join(this._tmp(task.id), SC.INBOX_NAME);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // responses leave through an ENGINE-owned dir beside (not inside) the worker's writable tmp dir: the worker sandbox may read it (the hook does), never write it
    const resDir = path.join(this._tmp(`selfcheck-res-${task.id}`));
    this._cleanSelfCheckDirs(task.id);
    const checks = task.orch.checks.map((c) => ({ argv: [...c.argv], timeout_s: c.timeout_s }));
    const max = R.self_checks_max ?? SC.SELF_CHECKS_MAX_DEFAULT;
    return { ctx: { dir: realpathDeepest(dir), res_dir: realpathDeepest(resDir), checks, max },
      state: { dir, resDir, checks, max, wt: realWt, attempt: task.attempts, busy: false, bad: 0, flooded: false, aborted: false, running: null, kill: null, stats: { runs: 0, capped: 0, ms: 0, output_bytes: 0 } } };
  }
  /** Between attempts: no stale responses, no leftover selfcheck-<task> check tmp dir. Recreates the (empty) response dir for the next attempt. */
  _cleanSelfCheckDirs(taskId) {
    try { fs.rmSync(path.join(this.P.tmp, `selfcheck-res-${taskId}`), { recursive: true, force: true }); fs.mkdirSync(path.join(this.P.tmp, `selfcheck-res-${taskId}`), { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
    try { fs.rmSync(path.join(this.P.tmp, `selfcheck-${taskId}`), { recursive: true, force: true }); } catch { /* best effort */ }
  }
  /** The attempt is over: stop (SIGKILL the process group) and await any self-check still running for it. */
  async _endSelfChecks(rec) {
    const sc = rec.selfCheck; if (!sc) return;
    sc.aborted = true;
    if (sc.busy) { try { sc.kill?.('SIGKILL'); } catch { /* gone */ } try { await sc.running; } catch { /* already reported */ } }
  }
  /** Answer pending self-check requests: one run at a time per worker, the argv always from the engine's copy of the plan. A flooded inbox is capped, bulk-cleaned and finally ignored. */
  _serviceSelfChecks() {
    for (const rec of this.workers.values()) {
      const sc = rec.selfCheck;
      if (!sc || sc.busy) continue;
      const reqs = SC.readRequests(sc.dir);
      for (const j of reqs.junk || []) { try { fs.unlinkSync(path.join(sc.dir, j)); } catch { /* a directory or gone */ } }
      if (!reqs.length) continue;
      const valid = [];
      for (const r of reqs) {
        if (r.index >= 0 && r.index < sc.checks.length && !sc.flooded) { valid.push(r); continue; }
        try { fs.rmSync(r.file, { force: true }); } catch { /* best effort */ } // invalid / anomalous / flood: deleted, never answered (a real hook never files one)
        if (!sc.flooded) sc.bad++;
      }
      if (!sc.flooded && sc.bad + sc.stats.capped > sc.max + SC.BAD_EXTRA) {
        sc.flooded = true;
        this.ev('orch.check.self_flooded', 'orchestrator', rec.task, { attempt: sc.attempt, bad: sc.bad, capped: sc.stats.capped, max: sc.max });
      }
      if (sc.flooded) { for (const r of valid) { try { fs.rmSync(r.file, { force: true }); } catch { /* best effort */ } } continue; }
      if (!valid.length) continue;
      const q0 = valid[0];
      try { fs.rmSync(q0.file, { force: true }); } catch { /* answered anyway */ }
      if (rec.exited || rec.termAtReal || sc.aborted) { SC.writeResponse(sc.resDir, q0.id, { error: 'the attempt is ending' }); continue; }
      if (sc.stats.runs >= sc.max) {
        sc.stats.capped++; SC.writeResponse(sc.resDir, q0.id, { capped: true, max: sc.max });
        this.ev('orch.check.self_capped', 'orchestrator', rec.task, { attempt: sc.attempt, max: sc.max });
        continue;
      }
      sc.busy = true; sc.stats.runs++;
      rec.lastProgressMs = this.now(); // waiting on the engine's self-check is activity, not a stall
      const run = sc.stats.runs;
      sc.running = this._runSelfCheck(rec, sc, q0.index).then((r) => {
        sc.stats.ms += r.duration_ms || 0; sc.stats.output_bytes += Buffer.byteLength(r.output || '');
        SC.writeResponse(sc.resDir, q0.id, r.refused ? { error: r.refused } : { ok: r.ok, exit_code: r.exit_code, timed_out: r.timed_out, duration_ms: r.duration_ms, run, max: sc.max,
          output: tail(r.output || '', SC.OUTPUT_TAIL), truncated: (r.output || '').length > SC.OUTPUT_TAIL });
        this.ev('orch.check.self_run', 'orchestrator', rec.task, { attempt: sc.attempt, run, max: sc.max, argv: sc.checks[q0.index].argv.join(' ').slice(0, 300), ok: !!r.ok, exit_code: r.exit_code ?? null,
          timed_out: !!r.timed_out, sandboxed: r.sandboxed ?? null, duration_ms: r.duration_ms || 0, output_bytes: Buffer.byteLength(r.output || ''), ...(r.refused ? { refused: r.refused.slice(0, 200) } : {}) });
      }).catch((e) => { SC.writeResponse(sc.resDir, q0.id, { error: `engine error: ${String(e.message).slice(0, 120)}` }); })
        .finally(() => { sc.busy = false; sc.kill = null; rec.lastProgressMs = this.now(); });
    }
  }
  /** One self-check: the same runChecks path, env, allowlist and OS sandbox as the authoritative checks; never unsandboxed. Bounded by the attempt's wall clock. */
  async _runSelfCheck(rec, sc, idx) {
    const goal = readJSON(this.P.goal);
    const name = `selfcheck-${rec.task}`; // its own TMPDIR root: not inside the worker's writable tmp dir
    const opts = this._sandboxOpts(goal, sc.wt, name);
    if (opts.unsandboxed) return { refused: 'checks are not OS-sandboxed for this goal, so self-checks are disabled', duration_ms: 0 };
    const left = Math.floor((goal.orch.budgets.task_wall_clock_s * 1000 - (this.now() - rec.startedMs)) / 1000);
    if (left < 2) return { refused: 'the attempt has no wall-clock time left', duration_ms: 0 };
    const c = sc.checks[idx];
    // never longer than the attempt can wait: the worker's hook is blocked on this run, and the stall timer (stall_after_s) would otherwise kill it
    const stallRoom = Math.floor(goal.orch.budgets.stall_after_s) - 30;
    const check = { argv: c.argv, timeout_s: Math.max(1, Math.min(Number(c.timeout_s) || SC.SELF_CHECK_MAX_S, SC.SELF_CHECK_MAX_S, stallRoom, left)) };
    if (sc.aborted) return { refused: 'the attempt is ending', duration_ms: 0 };
    const r = await runChecks([check], { registerKill: (k) => { sc.kill = k; if (sc.aborted) k('SIGKILL'); }, cwd: sc.wt, env: checkEnv({ base: this.env, tmpDir: this._tmp(name) }), allowlist: this._checkAllowlist(goal), ...opts });
    return r.results[0] || { refused: 'no result', duration_ms: 0 };
  }
  _devDirs() { return (this._devDirsCache ??= developerDirs(this.env)); } // from the engine's env (a test or caller may pass its own), not process.env
  _sandboxOpts(goal, wt, name) {
    const o = goal.orch;
    return { sandbox: { worktree: wt, tmpDir: this._tmp(name), goalDir: this.dir, orchDir: this.orchDir, home: this.env.HOME, ports: o.check_localhost_ports || [], loopback: o.allow_loopback === true, profileDir: path.join(this.dir, 'sandbox'), developerDirs: this._devDirs() },
      sandboxBin: this.sandboxBin, unsandboxed: o.unsandboxed_checks === true || this.testUnsandboxed, harnessMode: o.harness_tamper === 'warn' ? 'warn' : 'fail' };
  }
  async _hashInstructions(ref) {
    const out = {}; const repo = readJSON(this.P.goal).orch.repo;
    for (const rel of INSTRUCTION_FILES) { try { const b = await G.showBlob(repo, ref, rel); out[rel] = b ? sha256Buf(b) : null; } catch { out[rel] = 'unreadable'; } } // fail closed: a git error differs from every recorded hash
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
  /** {compiled, policy} of the goal's snapshot when it is intact, else null. */
  _rulesView(goal) {
    const snap = readJSON(this.P.rules, null);
    return snap && goal.orch.rules && snapshotHash(snap) === goal.orch.rules.sha256 && snap.compiled && snap.policy ? { compiled: snap.compiled, policy: snap.policy } : null;
  }
  _checkAllowlist(goal) {
    const o = goal.orch;
    // rule-set goals: the compiled checks.allowlist (fail closed when the snapshot is not intact); legacy goals keep their goal.json list
    const base = o.rules && !o.rules.legacy ? (this._rulesView(goal)?.compiled.checks.allowlist.map((e) => e.cmd) ?? []) : (o.check_allowlist || []);
    const crit = goal.success_criteria.filter((c) => c.check).map((c) => c.check.argv);
    return [...base, ...crit];
  }
  /** The worker policy of a goal: read ONLY from its rules snapshot (never re-reads policy files). Fails closed (no tool allowed) if the snapshot does not match goal.json. */
  _policy(goal) { return this._policyHead(goal).policy; }
  /** {policy, rules_hash, rules_invalid?} for a worker policy file: the ACTUAL hash of the snapshot on disk (never the expected one), and rules_invalid when it does not match goal.json (the hook then logs floor:rules_snapshot_invalid). */
  _policyHead(goal) {
    const snap = readJSON(this.P.rules, null); const actual = snapshotHash(snap);
    if (snap && goal.orch.rules && actual === goal.orch.rules.sha256 && snap.policy) return { policy: snap.policy, rules_hash: actual };
    return { policy: mergePolicy({ tools: { allow: [] } }), rules_hash: actual, rules_invalid: true };
  }
  _effectivePolicy(goal, file, over) {
    return mergePolicy(file, over, { approval: { ttl_s: goal.orch.budgets.approval_ttl_s, ...(over?.approval || {}) } });
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
      const decisions = (() => { try { return fs.readFileSync(path.join(this.P.workers, 'decisions.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((d) => d.decision === 'deny' && d.rule !== 'self_check'); } catch { return []; } })(); // a self-check is routed to the engine by the hook, not a denial
      const selfChecks = S.tasks.reduce((n, t) => n + (t.orch.attempt_log || []).reduce((m, a) => m + (a.self_checks?.runs || 0), 0), 0);
      const criteria = readJSON(path.join(this.dir, 'criteria.json'), {});
      const md = buildReport({ goal, tasks: S.tasks, state: S, approvals: listApprovals(this.P.approvals), denials: decisions, selfChecks, diffStat, criteriaResults: criteria, events: readEvents(this.dir), governor: this.gov.load() });
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

/** Why a protected / acceptance re-run failed, for blocked_reason: the failing tests by file and name when the TAP output names them, else the last output lines. */
const whyFailed = (res) => (res.failing ? `failing: ${res.failing}` : String(res.output || '').split('\n').filter(Boolean).slice(-3).join(' | ')).slice(0, 400);
/** {last_stderr} from the newest attempt that recorded a stderr tail (only when the task is not done). */
const lastStderr = (t) => { const e = t.status === 'done' ? null : [...(t.orch.attempt_log || [])].reverse().find((a) => a.stderr_tail); return e ? { last_stderr: e.stderr_tail, last_stderr_outcome: e.outcome } : {}; };
export function summarize(S, hb) {
  const counts = {}; for (const t of S.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  return { id: S.goal.id, title: S.goal.title, status: S.goal.status, blocked_reason: S.goal.blocked_reason || null, plan_state: S.goal.orch.plan_state,
    heartbeat: { seq: hb.seq, status: hb.status, ts: hb.ts }, tasks: counts, usage: S.goal.orch.usage, paused_reason: S.goal.orch.paused_reason, resume_at: S.goal.orch.resume_at || null,
    task_list: S.tasks.map((t) => ({ id: t.id, status: t.status, tier: t.orch.model_tier, attempts: t.attempts, ...lastStderr(t) })), anticheat: rollup(S),
    plan_review: reviewView(S.tasks), plan_approval: S.goal.orch.plan_approval || null, trust_repo_config: !!S.goal.orch.trust_repo_config, unsandboxed_checks: !!S.goal.orch.unsandboxed_checks, sandbox_workers: !!S.goal.orch.sandbox_workers };
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
  // CLAUDE.md files are trusted input: not refused, but hashed (committed content a worker will load) and announced
  const instructions = {};
  for (const rel of INSTRUCTION_FILES) { const b = await G.showBlob(info.root, info.base_commit, rel); instructions[rel] = b ? sha256Buf(b) : null; }
  goal.orch.instructions = instructions;
  // rule-set layers (R5/R6). The repo's .aos/rules.json is read from base_commit (never the working tree), once, here; an invalid file refuses the repo like an invalid .claude/settings.json
  if (goal.orch.rules_layer !== undefined) {
    const v = validateRules(goal.orch.rules_layer, { layer: 'goal' });
    if (!v.ok) throw new Error(`goal.orch.rules is invalid:\n  ${v.errors.slice(0, 10).join('\n  ')}`);
  }
  let rb; try { rb = await G.showBlob(info.root, info.base_commit, REPO_RULES_PATH); } catch (e) { throw new Error(`refusing repo ${info.root}: cannot read its ${REPO_RULES_PATH} at ${info.base_commit.slice(0, 12)} (${String(e.message).slice(0, 150)}); a repo's rules can only tighten`); }
  const rr = parseRepoRules(rb);
  if (rr.errors.length) throw new Error(`refusing repo ${info.root}: its ${REPO_RULES_PATH} (at ${info.base_commit.slice(0, 12)}) is invalid:\n  ${rr.errors.slice(0, 10).join('\n  ')}\nFix it on the base branch; a repo's rules can only tighten.`);
  if (rr.rules) goal.orch.repo_rules = { sha256: rr.sha256, path: REPO_RULES_PATH, base_commit: info.base_commit };
  const pre = previewGoal({ orchDir, goal, repo: rr.rules || null });
  if (!pre.ok) throw new Error(`rules refused:\n  ${pre.errors.slice(0, 10).join('\n  ')}`);
  // condition 2: refuse repos whose own Claude Code configuration could steer a worker, unless the human opted in
  const { findings } = scanRepoConfig(G.realpath(start), info.root);
  // the COMPILED repo_config.trust decides (a user rules layer that forbids trust wins over the goal's --trust-repo-config; one that grants it needs no flag)
  const trusted = pre.comp.compiled.repo_config.trust === true;
  goal.orch.trust_repo_config = trusted;
  if (findings.length && !trusted) throw new Error(`refusing repo ${info.root}: it carries Claude Code configuration that could add hooks, permissions, env, MCP servers or commands to workers:\n  ${formatFindings(findings)}\nReview it; if you wrote it and trust it, set orch.trust_repo_config (CLI: --trust-repo-config)${spec.orch?.trust_repo_config ? ' (trust was requested, but the compiled rules forbid it: a rules.json with repo_config.trust false wins)' : ''}.`);
  goal.orch.repo_config_findings = findings.map((f) => ({ path: path.relative(info.root, f.path) || '.', kind: f.kind, detail: f.detail }));
  // checks.protect_existing_tests: the test files of base_commit are listed now; at verify their ORIGINAL contents are re-run against the integration branch
  if (pre.comp.compiled.checks.protect_existing_tests === true) {
    const tf = await listTestFiles(info.root, info.base_commit);
    goal.orch.protected_tests = { base_commit: info.base_commit, files: tf.files, truncated: tf.truncated };
  }
  const dir = createGoalDir(orchDir, goal, spec.plan || null);
  if (rr.rules) atomicWrite(path.join(dir, REPO_RULES_FILE), rr.rules);
  const notices = instructionNotice(info.root, instructions);
  appendEvent(dir, { type: 'goal.created', actor: 'human', goal_id: goal.id, data: { title: goal.title, criteria: goal.success_criteria.length, ...(goal.orch.drafted ? { drafted: true, draft_tier: goal.orch.drafted.tier } : {}) } }, clock);
  if (notices.length) appendEvent(dir, { type: 'orch.repo_instructions', actor: 'orchestrator', goal_id: goal.id, data: { notices, files: Object.fromEntries(Object.entries(instructions).filter(([, h]) => h).map(([k, h]) => [k, h.slice(0, 12)])) } }, clock);
  if (findings.length) {
    notices.push(`WARNING: --trust-repo-config: repo configuration accepted without review by the engine: ${formatFindings(findings)}`);
    appendEvent(dir, { type: 'orch.repo_config.trusted', actor: 'human', goal_id: goal.id, data: { warning: 'repo config accepted via trust_repo_config; workers may be steered by it', findings: goal.orch.repo_config_findings.slice(0, 20) } }, clock);
  }
  if (rr.rules) {
    const nd = pre.comp.dropped.filter((d) => d.layer === 'repo' && d.reason === 'loosening');
    notices.push(`repo ${REPO_RULES_PATH} (${rr.sha256.slice(0, 12)}) was read from ${info.base_commit.slice(0, 12)}: it can only tighten${nd.length ? `; ${nd.length} loosening(s) are NOT applied (accept with approve-plan --accept-repo-loosening <id>): ${nd.slice(0, 5).map((d) => d.rule_id).join(', ')}` : ''}`);
    for (const l of pre.comp.loosenings.filter((x) => x.layer === 'repo')) notices.push(`ACCEPTED repo loosening ${q(l.rule_id)}: ${q(l.path)} ${l.from === null || l.from === undefined ? '+' : `${q(JSON.stringify(l.from))} ->`} ${q(JSON.stringify(l.to))}`);
    appendEvent(dir, { type: 'orch.rules.repo_layer', actor: 'orchestrator', goal_id: goal.id, data: { sha12: rr.sha256.slice(0, 12), base_commit: info.base_commit.slice(0, 12), dropped: nd.map((d) => d.rule_id).slice(0, 20) } }, clock);
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
