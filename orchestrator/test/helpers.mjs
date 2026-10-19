// Shared test harness: throwaway git repo + orch dir + scenario file in $TMPDIR, engine factory, small utilities.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Engine, createGoal } from '../lib/engine.mjs';
import { readJSON, loadState, readEvents, paths } from '../lib/state.mjs';
import { validateEvent, validateGoal, validateTask, validateAgent, validateHeartbeat } from '../lib/schema.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE = path.join(HERE, 'fake-claude.mjs');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export { git };

export function mkSandbox(name = 'aos-orch') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'tester'); git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  const orch = path.join(root, 'orch'); const fakeState = path.join(root, 'fake-state');
  fs.mkdirSync(orch); fs.mkdirSync(fakeState);
  const sb = { root, repo, orch, fakeState, scenarioFile: path.join(root, 'scenario.json'), engines: [],
    scenario(obj) { fs.writeFileSync(sb.scenarioFile, JSON.stringify(obj)); return sb; },
    env(extra = {}) { return { ...process.env, AOS_ORCH_DIR: orch, AOS_CLAUDE_BIN: FAKE, AOS_FAKE_SCENARIO: sb.scenarioFile, AOS_FAKE_STATE: fakeState, AOS_APPROVAL_POLL_MS: '40', ...extra }; },
    async goal(spec = {}) {
      const base = { id: 'g-test', title: 'Test goal', success_criteria: [{ id: 'c1', text: 'all files present', check: { argv: ['grep', '-qx', 'gamma', 'c.txt'], timeout_s: 30 } }],
        budget: { max_ticks: 100000, max_usd: 50, max_wall_clock_s: 3600 },
        ...spec, orch: { repo, base_branch: 'main', check_allowlist: ['grep', 'node', 'test'], approval_policy: { plan: 'auto' }, ...(spec.orch || {}),
          budgets: { max_parallel: 3, task_wall_clock_s: 60, stall_after_s: 60, ...(spec.orch?.budgets || {}) } } };
      const g = await createGoal(orch, base);
      return g;
    },
    engine(goalDir, opts = {}) {
      const e = new Engine({ goalDir, orchDir: orch, env: opts.env || sb.env(), intervalMs: 200, killGraceMs: 300, budgetGraceMs: 400, plannerTimeoutMs: 30000, ...opts });
      if (opts.humanApproves !== false) humanApproves(e);
      sb.engines.push(e); return e;
    },
    cleanup() {
      for (const e of sb.engines) { try { e.crash(); } catch { /* ok */ } }
      // kill any stray worker groups before removing the tree
      try { for (const g of fs.readdirSync(path.join(orch, 'goals'))) for (const f of fs.readdirSync(path.join(orch, 'goals', g, 'workers'))) if (f.endsWith('.pid.json')) { const p = readJSON(path.join(orch, 'goals', g, 'workers', f)); try { process.kill(-p.pgid, 'SIGKILL'); } catch { /* gone */ } } } catch { /* none */ }
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
  return sb;
}

/**
 * Plans with commands can no longer auto-approve (security review condition 3). The pre-existing engine tests were written
 * for `plan: auto`; to keep them meaningful this stands in for the HUMAN: when a goal whose spec says plan "auto" parks at
 * awaiting_approval, it queues exactly what `aos-orch approve-plan` queues (a command carrying the reviewed hashes).
 * Tests of the approval gate itself pass { humanApproves: false }.
 */
export function humanApproves(engine) {
  const orig = engine.tick.bind(engine);
  engine.tick = async () => {
    const r = await orig();
    const g = readJSON(engine.P.goal);
    if (g && g.status === 'draft' && g.orch.plan_state === 'awaiting_approval' && g.orch.approval_policy.plan === 'auto') {
      engine.dir && (await engine.command({ cmd: 'approve-plan', by: 'test-human', reviewed: engine._fingerprint(loadState(engine.dir)) }));
    }
    return r;
  };
  return engine;
}

/** Tick until `pred(summary)` or timeout. Returns the last tick result. */
export async function drive(engine, { until, timeoutMs = 60000, pollMs = 60 } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await engine.tick();
    if (until ? until(engine) : engine.isDone()) return last;
    await Promise.race([sleep(pollMs), new Promise((r) => { engine._wakeFn = r; })]);
  }
  throw new Error(`drive timed out after ${timeoutMs}ms: ${JSON.stringify(engine.summary())}`);
}

export const types = (dir) => readEvents(dir).map((e) => e.type);
export const goalOf = (dir) => loadState(dir).goal;
export const tasksOf = (dir) => loadState(dir).tasks;

/** Every state file and event validates against the AOS-1 schemas (+ the design's namespaced event types). */
export function assertValidState(assert, dir) {
  const S = loadState(dir); const P = paths(dir);
  assert.deepEqual(validateGoal(S.goal), []);
  for (const t of S.tasks) assert.deepEqual(validateTask(t), [], t.id);
  for (const a of S.agents) assert.deepEqual(validateAgent(a), [], a.id);
  assert.deepEqual(validateHeartbeat(readJSON(P.hb)), []);
  const evs = readEvents(dir); let prev = 0;
  for (const e of evs) { assert.deepEqual(validateEvent(e), [], `${e.type}`); assert.ok(e.seq === prev + 1, `seq ${e.seq} after ${prev}`); prev = e.seq; }
  return evs;
}

export function procsAlive(dir) {
  const out = [];
  const wd = path.join(dir, 'workers');
  for (const f of fs.existsSync(wd) ? fs.readdirSync(wd) : []) if (f.endsWith('.pid.json')) {
    const p = readJSON(path.join(wd, f));
    try { process.kill(-p.pgid, 0); out.push(f); } catch { /* gone */ }
  }
  return out;
}

// ---- plan / scenario builders
export const chk = (file, word) => ({ argv: ['node', '-e', `const s=require('fs').readFileSync(${JSON.stringify(file)},'utf8').trim();if(s!==${JSON.stringify(word)}){console.error('CHECKFAIL '+${JSON.stringify(file)}+' has '+JSON.stringify(s));process.exit(1)}`], timeout_s: 30 });
export const ptask = (id, file, word, { deps = [], tier = 'haiku', scope, cmds = [] } = {}) => ({ id, title: `Write ${file}`, description: `Create ${file}`, depends_on: deps, model_tier: tier,
  path_scope: scope || [file], allowed_commands: cmds, checks: [chk(file, word)], output_contract: `${file} holds ${word}`, acceptance: [`${file} holds ${word}`] });
export const crit = (file, word) => ({ id: 'c1', text: `${file} holds ${word}`, check: chk(file, word) });
export const edit = (file, word) => ({ behavior: 'success', edits: [{ path: file, content: `${word}\n` }] });
export const fakeCalls = (sb, task) => { try { return fs.readFileSync(path.join(sb.fakeState, 'invocations.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((i) => i.task_id === task); } catch { return []; } };
export const worktreesOf = (repo) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
export const fakeClock = (start = Date.now()) => ({ t: start, now() { return this.t; }, advance(ms) { this.t += ms; } });
export function allowAllHook(root) {
  const f = path.join(root, 'allow-hook.mjs');
  fs.writeFileSync(f, "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));\n");
  return f;
}
