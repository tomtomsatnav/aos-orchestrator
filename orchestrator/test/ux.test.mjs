// Demo UX fixes: multi-line draft rendering, task-sized draft budgets and tightening flags, read-only `plan`, `run --wait-approval`, the rules summary's profile block,
// the "beyond the prompt" flag, the planner prompt and `rules check <goal file>`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkSandbox, ptask, crit, HERE, sleep, NO_OS_SANDBOX } from './helpers.mjs';
import { draftGoal, renderDraft } from '../lib/draft.mjs';
import { reviewView, renderReview, beyondPrompt, goalPromptText, buildPlannerPrompt } from '../lib/plan.mjs';
import { paths, readJSON } from '../lib/state.mjs';

const CLI = path.join(HERE, '..', 'bin', 'aos-orch.mjs');
const cli = (args, env) => new Promise((resolve) => { const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; }); c.on('close', (code) => resolve({ code, out, err })); });
const SC = (n) => JSON.parse(fs.readFileSync(path.join(HERE, 'scenarios', n), 'utf8'));
const userRules = (sb, r) => fs.writeFileSync(path.join(sb.orch, 'rules.json'), JSON.stringify(r ?? { rules_version: 1, checks: { allowlist: [{ id: 'grep', cmd: 'grep' }] } }));
const noBudgets = () => { const sc = SC('draft-ok.json'); delete sc.draft.draft.budgets; return sc; };

test('renderDraft: a criterion with a newline is shown as separate lines (never a literal \\u000a), each line escaped on its own', () => {
  const r = { tier: 'haiku', profile: 'strict', rules_hash: 'abc', usage: { new_tokens: 1, notional_usd: 0 }, errors: [], questions: [],
    draft: { title: 't', description: '', risks: [], budgets: {}, success_criteria: [{ id: 'c1', text: 'line one\x1b[2J', check: { argv: ['grep', 'x'], timeout_s: 5 }, matched_rule: 'user:checks.allow.grep' }, { id: 'c2', text: 'h', verify: 'human' }] } };
  const t = renderDraft(r);
  assert.equal(t.includes('\\u000a'), false); assert.match(t, /\n {6}check \(sandboxed, 5s\): grep x/); assert.match(t, /line one\\u001b\[2J/); assert.equal(/\x1b/.test(t), false);
});

test('draft budgets: sized to a small goal (not the rules maximums), described truthfully, summary line matches; flags only tighten', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); userRules(sb); sb.scenario(noBudgets());
  let r = await draftGoal({ orchDir: sb.orch, repo: sb.repo, prompt: 'x', env: sb.env() });
  assert.equal(r.ok, true, r.errors.join(';')); assert.deepEqual(r.draft.budgets, { max_new_tokens: 150000, max_wall_s: 1200, max_attempts: 2 });
  assert.equal(r.spec.budget.max_wall_clock_s, 1200); assert.equal(r.spec.orch.budgets.max_new_tokens, 150000); assert.equal(r.spec.orch.budgets.max_attempts, 2);
  assert.match(r.rules_text, /limits: \$5, 150000 tokens, 1200s, 2 attempts\/task/, 'the summary shows what the draft compiled to, not the rules maximum 3');
  const txt = renderDraft(r); assert.match(txt, /budget attempts: 2 \(draft default for a small goal; rules limit 3\)/); assert.equal(/lowered by draft/.test(txt), false);
  r = await draftGoal({ orchDir: sb.orch, repo: sb.repo, prompt: 'x', env: sb.env(), overrides: { max_new_tokens: 90000, max_wall_s: 300, tier: 'haiku' } });
  assert.equal(r.ok, true); assert.equal(r.spec.orch.budgets.max_new_tokens, 90000); assert.equal(r.spec.budget.max_wall_clock_s, 300); assert.equal(r.spec.orch.rules.plan.max_start_tier, 'haiku');
  assert.match(r.rules_text, /90000 tokens, 300s/); assert.match(renderDraft(r), /budget tokens: 90000 \(set by your flag; rules limit 2000000\)/);
  // above the rules, a bad tier, or a tier above the rules: refused before any model call
  const n = fs.existsSync(sb.fakeState) ? fs.readdirSync(sb.fakeState).length : 0;
  for (const o of [{ max_new_tokens: 5000000 }, { max_wall_s: 99999 }, { max_new_tokens: 1.5 }, { tier: 'gpt' }]) { r = await draftGoal({ orchDir: sb.orch, repo: sb.repo, prompt: 'x', env: sb.env(), overrides: o }); assert.equal(r.ok, false, JSON.stringify(o)); }
  userRules(sb, { rules_version: 1, checks: { allowlist: [{ id: 'grep', cmd: 'grep' }] }, plan: { max_start_tier: 'sonnet' } });
  r = await draftGoal({ orchDir: sb.orch, repo: sb.repo, prompt: 'x', env: sb.env(), overrides: { tier: 'opus' } }); assert.equal(r.ok, false); assert.match(r.errors.join(), /above what the rules allow/);
  assert.equal(fs.existsSync(sb.fakeState) ? fs.readdirSync(sb.fakeState).length : 0, n, 'no model call for refused flags');
  const c = await cli(['draft', 'x', '--repo', sb.repo, '--max-tokens', 'lots'], sb.env()); assert.equal(c.code, 64);
});

test('a profile\'s own allowlist additions are shown in their own block, not as alarming loosenings; real loosenings still are', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); userRules(sb);
  const sc = SC('draft-ok.json'); sc.draft.draft.success_criteria[0].check.argv = ['node', '--test', 'x.test.mjs']; sc.draft.draft.success_criteria[0].check.timeout_s = 300; sb.scenario(sc);
  const r = await draftGoal({ orchDir: sb.orch, repo: sb.repo, prompt: 'x', profile: 'node-library', env: sb.env() });
  assert.equal(r.ok, true, r.errors.join(';')); assert.match(r.rules_text, /LOOSENINGS YOU ARE APPROVING \(1\):\n {2}user:checks\.allowlist {2}\+ grep/, 'the user rules file\'s own addition is a real loosening and stays in the main list'); assert.match(r.rules_text, /ADDS TO THE CHECK ALLOWLIST \(3; expected/); assert.match(r.rules_text, /goal:checks\.allowlist {2}\+ npm test/);
});

test('beyond the prompt: scope globs none of whose literal parts the goal text mentions are flagged (heuristic, informational) in renderReview', () => {
  const goal = { title: 'Add alpha', description: 'Create a.txt and update docs', success_criteria: [{ text: 'a.txt holds alpha', check: { argv: ['grep', '-qx', 'alpha', 'a.txt'] } }] };
  const text = goalPromptText(goal);
  assert.deepEqual(beyondPrompt(['a.txt'], text), { beyond_prompt: false, beyond_paths: [] }); assert.equal(beyondPrompt(['docs/**'], text).beyond_prompt, false);
  assert.deepEqual(beyondPrompt(['src/**/*.mjs', 'a.txt'], text), { beyond_prompt: true, beyond_paths: ['src/**/*.mjs'] });
  const tasks = [{ id: 't1', title: 'x', acceptance: ['a'], depends_on: [], orch: { model_tier: 'haiku', path_scope: ['a.txt', 'package-lock.json'], allowed_commands: [], checks: [{ argv: ['grep', 'x'], timeout_s: 5 }] } }];
  assert.match(renderReview(reviewView(tasks, goal)), /BEYOND THE PROMPT \(heuristic, informational\): scope package-lock\.json /);
  assert.equal(renderReview(reviewView(tasks)).includes('BEYOND THE PROMPT'), false, 'no goal text: no flag, unchanged output');
  assert.equal('beyond_prompt' in reviewView(tasks)[0], false);
});

test('planner prompt discourages verification-only tasks', () => {
  const g = { title: 't', description: '', success_criteria: [{ id: 'c1', text: 'x' }], orch: { budgets: { max_tasks: 3 }, check_allowlist: [] } };
  assert.match(buildPlannerPrompt({ goal: g }).prompt, /Do NOT add verification-only tasks/);
});

test('cli rules check accepts a whole goal file for --layer goal (extracts orch.rules) with a clear message', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); userRules(sb); const env = sb.env();
  const sc = SC('draft-ok.json'); sc.draft.draft.success_criteria[0].check.argv = ['node', '--test', 'x.test.mjs']; sc.draft.draft.success_criteria[0].check.timeout_s = 300; sb.scenario(sc);
  const out = path.join(sb.root, 'goal.json');
  assert.equal((await cli(['draft', 'x', '--repo', sb.repo, '--profile', 'node-library', '--out', out], env)).code, 0);
  let r = await cli(['rules', 'check', out, '--layer', 'goal'], env); assert.equal(r.code, 0, r.err); assert.match(r.out, /checking orch\.rules of the goal file as the goal layer/); assert.match(r.out, /OK as a goal layer/);
  r = await cli(['rules', 'check', out], env); assert.equal(r.code, 2); assert.match(r.err, /goal file, not a rules file: check it with --layer goal/);
  sb.scenario(SC('draft-ok.json')); const plain = path.join(sb.root, 'plain.json'); await cli(['draft', 'x', '--repo', sb.repo, '--out', plain], env);
  r = await cli(['rules', 'check', plain, '--layer', 'goal'], env); assert.equal(r.code, 2); assert.match(r.err, /no orch\.rules/);
});

test('cli: plan is read-only; run stops with the exact next command; run --wait-approval continues only after the human\'s approve-plan', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: { behavior: 'success', plan: { tasks: [ptask('t1', 'a.txt', 'alpha')] } }, tasks: { t1: [{ behavior: 'success', edits: [{ path: 'a.txt', content: 'alpha\n' }] }] } });
  const spec = { id: 'g-ux', title: 'Create a.txt with alpha', success_criteria: [crit('a.txt', 'alpha')], budget: { max_ticks: 1000, max_usd: 5, max_wall_clock_s: 600 }, orch: { ...(NO_OS_SANDBOX ? { unsandboxed_checks: true } : {}), repo: sb.repo, base_branch: 'main', check_allowlist: ['node'] } };
  const gf = path.join(sb.root, 'goal.json'); fs.writeFileSync(gf, JSON.stringify(spec)); const env = sb.env(); const dir = path.join(sb.orch, 'goals', 'g-ux');
  let r = await cli(['run', gf, '--no-wait', '--poll-ms', '50', '--interval-s', '0.2'], env);
  assert.equal(r.code, 4, r.err); assert.match(r.err, /aos-orch plan g-ux/); assert.match(r.err, /aos-orch approve-plan g-ux/); assert.match(r.err, /aos-orch run g-ux/);
  const cmdsBefore = fs.existsSync(paths(dir).commands) ? fs.readdirSync(paths(dir).commands).length : 0;
  r = await cli(['plan', 'g-ux'], env); assert.equal(r.code, 0, r.err); assert.match(r.out, /PLAN FOR REVIEW \(read-only/); assert.match(r.out, /task t1 /); assert.match(r.out, /rules [0-9a-f]{12}/); assert.match(r.out, /aos-orch approve-plan g-ux/);
  assert.equal(fs.existsSync(paths(dir).commands) ? fs.readdirSync(paths(dir).commands).length : 0, cmdsBefore, 'plan queues nothing');
  assert.equal(readJSON(paths(dir).goal).orch.plan_state, 'awaiting_approval');
  r = await cli(['plan', 'nope'], env); assert.equal(r.code, 1);
  // default: stays attached; nothing proceeds until the human's command
  const c = spawn(process.execPath, [CLI, 'run', 'g-ux', '--poll-ms', '50', '--interval-s', '0.2'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; let out = ''; c.stderr.on('data', (d) => { err += d; }); c.stdout.on('data', (d) => { out += d; }); const closed = new Promise((res) => c.on('close', res));
  const end = Date.now() + 20000; while (!/waiting for your command/.test(err) && Date.now() < end) await sleep(50);
  assert.match(err, /waiting for your command/); assert.match(err, /PLAN FOR REVIEW/);
  await sleep(1200); assert.equal(readJSON(paths(dir).goal).orch.plan_state, 'awaiting_approval', 'still waiting: the engine proceeds only on the human command'); assert.equal(c.exitCode, null);
  r = await cli(['status', 'g-ux'], env); assert.match(JSON.parse(r.out).heartbeat.status, /^waiting \(attached run pid \d+\)$/, 'parked at plan approval: not shown as stopped');
  r = await cli(['approve-plan', 'g-ux'], env); assert.match(r.out, /queued; the attached run \(pid \d+\) will apply it within one tick/);
  assert.equal(await closed, 0, err); assert.equal(JSON.parse(out).status, 'achieved');
});

test('cli: run stops at "awaiting human confirmation" with the exact confirm command', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: { behavior: 'success', plan: { tasks: [ptask('t1', 'a.txt', 'alpha')] } }, tasks: { t1: [{ behavior: 'success', edits: [{ path: 'a.txt', content: 'alpha\n' }] }] } });
  const spec = { id: 'g-hc', title: 'Create a.txt', success_criteria: [crit('a.txt', 'alpha'), { id: 'c2', text: 'reads well', verify: 'human' }], orch: { ...(NO_OS_SANDBOX ? { unsandboxed_checks: true } : {}), repo: sb.repo, base_branch: 'main', check_allowlist: ['node'] } };
  const gf = path.join(sb.root, 'goal.json'); fs.writeFileSync(gf, JSON.stringify(spec)); const env = sb.env();
  assert.equal((await cli(['run', gf, '--no-wait', '--poll-ms', '50', '--interval-s', '0.2'], env)).code, 4);
  await cli(['approve-plan', 'g-hc'], env);
  const r = await cli(['run', 'g-hc', '--no-wait', '--poll-ms', '50', '--interval-s', '0.2'], env);
  assert.equal(r.code, 2, r.err); assert.match(r.err, /aos-orch confirm g-hc c2/);
});

test('cli: an attached run stays attached through human-criterion confirmation and exits only when achieved', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: { behavior: 'success', plan: { tasks: [ptask('t1', 'a.txt', 'alpha')] } }, tasks: { t1: [{ behavior: 'success', edits: [{ path: 'a.txt', content: 'alpha\n' }] }] } });
  const spec = { id: 'g-hw', title: 'Create a.txt', success_criteria: [crit('a.txt', 'alpha'), { id: 'c2', text: 'reads well', verify: 'human' }], orch: { repo: sb.repo, base_branch: 'main', check_allowlist: ['node'] } };
  const gf = path.join(sb.root, 'goal.json'); fs.writeFileSync(gf, JSON.stringify(spec)); const env = sb.env();
  const c = spawn(process.execPath, [CLI, 'run', gf, '--poll-ms', '50', '--interval-s', '0.2'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; let out = ''; c.stderr.on('data', (d) => { err += d; }); c.stdout.on('data', (d) => { out += d; }); const closed = new Promise((res) => c.on('close', res));
  const waitFor = async (re) => { const end = Date.now() + 30000; while (!re.test(err) && Date.now() < end) await sleep(50); assert.match(err, re); };
  await waitFor(/aos-orch approve-plan g-hw/);
  assert.match((await cli(['approve-plan', 'g-hw'], env)).out, /attached run/);
  await waitFor(/aos-orch confirm g-hw c2/);
  await sleep(500); assert.equal(c.exitCode, null, 'still attached while the criterion awaits confirmation');
  assert.match((await cli(['confirm', 'g-hw', 'c2'], env)).out, /attached run \(pid \d+\)/);
  assert.equal(await closed, 0, err); assert.equal(JSON.parse(out).status, 'achieved');
});

test('the plan approval summary shows the compiled attempts/tokens/wall of a drafted goal (not the rules maximum)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); userRules(sb); sb.scenario({ ...noBudgets(), planner: { behavior: 'success', plan: { tasks: [{ ...ptask('t1', 'a.txt', 'alpha'), checks: [{ argv: ['grep', '-qx', 'alpha', 'a.txt'], timeout_s: 30 }] }] } } });
  const d = await draftGoal({ orchDir: sb.orch, repo: sb.repo, prompt: 'x', env: sb.env() }); assert.equal(d.ok, true);
  const gf = path.join(sb.root, 'goal.json'); fs.writeFileSync(gf, JSON.stringify({ ...d.spec, id: 'g-sum' }));
  const env = sb.env(); assert.equal((await cli(['run', gf, '--no-wait', '--poll-ms', '50', '--interval-s', '0.2'], env)).code, 4);
  const r = await cli(['plan', 'g-sum'], env); assert.match(r.out, /limits: \$5, 150000 tokens, 1200s, 2 attempts\/task/);
});

// ------------------------------------------------------------------ run report 2026-10-21 (UX items 2-9)
import { checkInputPaths, failingTests, failingTestsLine } from '../lib/anticheat.mjs';
import { buildReport } from '../lib/report.mjs';
import { draftAdditions } from '../lib/draft.mjs';
import { drive, goalOf } from './helpers.mjs';
import { readEvents, loadState, atomicWrite, loadHeartbeat } from '../lib/state.mjs';

test('UX2: `node --check <file>` makes that file the SUBJECT of the check, not a configuration input; loaders and script arguments still are', () => {
  assert.deepEqual(checkInputPaths([['node', '--check', 'src/arrays.js']]), []);
  assert.deepEqual(checkInputPaths([['node', '-c', 'src/arrays.js']]), []);
  assert.deepEqual(checkInputPaths([['node', '--check', '--import', './hook.mjs', 'src/a.js']]), ['hook.mjs']);
  assert.deepEqual(checkInputPaths([['node', 'scripts/check.mjs']]), ['scripts/check.mjs']);
});

const TAP_B = "TAP version 13\n# Subtest: returns first success\nok 1 - returns first success\n  ---\n  duration_ms: 0.5\n  ...\n# Subtest: performance: a fully failing 3-attempt retry completes in under 50ms\nnot ok 4 - performance: a fully failing 3-attempt retry completes in under 50ms\n  ---\n  duration_ms: 204.7\n  location: '/tmp/x/repo-aos-worktrees/g/integration/test/retry.test.js:15:1'\n  failureType: 'testCodeFailure'\n  error: 'too slow'\n  ...\n# Subtest: suite\n    # Subtest: inner\n    not ok 1 - inner\n      ---\n      location: '/tmp/x/repo-aos-worktrees/g/integration/test/util.test.js:3:5'\n      ...\n    1..1\nnot ok 5 - suite\n  ---\n  location: '/tmp/x/repo-aos-worktrees/g/integration/test/util.test.js:2:1'\n  ...\n# Subtest: /tmp/x/repo-aos-worktrees/g/integration/test/broken.test.js\nnot ok 6 - /tmp/x/repo-aos-worktrees/g/integration/test/broken.test.js\n  ---\n  failureType: 'testCodeFailure'\n  ...\n1..6\n# tests 6\n# pass 3\n# fail 3\n# duration_ms 686.6\n";
test('UX3: failing tests are named by file and test (a parent suite that fails only through its child is not repeated); the TAP tail is not the reason', () => {
  const root = '/tmp/x/repo-aos-worktrees/g/integration';
  assert.deepEqual(failingTests(TAP_B, root), [{ name: 'performance: a fully failing 3-attempt retry completes in under 50ms', file: 'test/retry.test.js' }, { name: 'inner', file: 'test/util.test.js' }, { name: '/tmp/x/repo-aos-worktrees/g/integration/test/broken.test.js', file: 'test/broken.test.js' }]);
  assert.equal(failingTestsLine(TAP_B, root, 2), 'test/retry.test.js: "performance: a fully failing 3-attempt retry completes in under 50ms" | test/util.test.js: "inner" (+1 more)');
  assert.equal(failingTestsLine('# tests 1\n# pass 1\n', root), null);
});

test('UX3 engine: a goal blocked by a protected (existing) test names the failing test and its file', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  fs.mkdirSync(path.join(sb.repo, 'test'));
  fs.writeFileSync(path.join(sb.repo, 'test', 'pricing.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';\ntest('a.txt is alpha', () => assert.equal(fs.readFileSync('a.txt', 'utf8').trim(), 'alpha'));\n");
  fs.writeFileSync(path.join(sb.repo, 'a.txt'), 'alpha\n');
  const { execFileSync } = await import('node:child_process'); execFileSync('git', ['add', '-A'], { cwd: sb.repo }); execFileSync('git', ['commit', '-q', '-m', 'tests'], { cwd: sb.repo });
  sb.scenario({ tasks: { t1: [{ behavior: 'success', edits: [{ path: 'b.txt', content: 'beta\n' }, { path: 'a.txt', content: 'WRONG\n' }] }] } });
  const { dir } = await sb.goal({ success_criteria: [crit('b.txt', 'beta')], plan: { tasks: [ptask('t1', 'b.txt', 'beta', { scope: ['b.txt', 'a.txt'] })], risks: [] } });
  await drive(sb.engine(dir));
  const g = goalOf(dir); assert.equal(g.status, 'blocked');
  assert.match(g.blocked_reason, /ORIGINAL existing tests fail .*: failing: test\/pricing\.test\.mjs: "a\.txt is alpha"$/);
});

test('UX4: the report lists self-check runs on their own line, not under policy denials', () => {
  const goal = { id: 'g', title: 't', status: 'achieved', success_criteria: [], orch: { repo: '/r', base_branch: 'main', base_commit: 'abc', integration_branch: 'aos/g/integration', usage: { new_tokens: 1, cache_read_tokens: 0, workers_started: 1, notional_usd: 0 } } };
  const md = buildReport({ goal, tasks: [], denials: [], selfChecks: 7 });
  assert.match(md, /## Policy denials\n\nnone\n\nSelf-checks: 7 run\(s\)/);
  assert.doesNotMatch(buildReport({ goal, tasks: [] }), /Self-checks/);
});

test('UX5: no heartbeat.dead / heartbeat.late after a wait at plan approval; a running goal still reports a dead heartbeat', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ behavior: 'success', edits: [{ path: 'a.txt', content: 'alpha\n' }] }] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] }, orch: { approval_policy: { plan: 'required' } } });
  const eng = sb.engine(dir, { humanApproves: false, intervalMs: 1000 }); await eng.start(); // (heartbeat gaps are judged only for intervals >= 1 s)
  await eng.tick(); await eng.tick();
  assert.equal(loadState(dir).goal.orch.plan_state, 'awaiting_approval');
  const age = (ms) => { const hb = loadHeartbeat(dir); atomicWrite(paths(dir).hb, { ...hb, ts: new Date(Date.now() - ms).toISOString() }); };
  age(120000); await eng.tick();
  assert.equal(readEvents(dir).some((e) => /^heartbeat\.(dead|late)$/.test(e.type)), false, 'a parked goal is not dead');
  await eng.command({ cmd: 'approve-plan', by: 'test' }); await eng.tick();
  age(120000); await eng.tick();
  assert.ok(readEvents(dir).some((e) => e.type === 'heartbeat.dead'), 'an active goal with an old heartbeat still is');
});

test('UX6/UX9/state notice: no "draft tasks={}" line, approve-plan prints a short confirmation, the legacy-dir notice prints at most once a day', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: { behavior: 'success', plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] } }, tasks: { t1: [{ behavior: 'success', edits: [{ path: 'a.txt', content: 'alpha\n' }] }] } });
  const gf = path.join(sb.root, 'goal.json'); fs.writeFileSync(gf, JSON.stringify({ id: 'g-ux', title: 'ux', success_criteria: [crit('a.txt', 'alpha')], orch: { repo: sb.repo, base_branch: 'main', check_allowlist: ['node'], sandbox_workers: false } }));
  const env = sb.env();
  const r = await cli(['run', gf, '--no-wait', '--poll-ms', '50', '--interval-s', '0.2'], env);
  assert.equal(r.code, 4, r.err); assert.doesNotMatch(r.err, /tasks=\{\}/);
  const a = await cli(['approve-plan', 'g-ux'], env);
  assert.match(a.err, /^approved: plan [0-9a-f]{12}, 1 task\(s\)/m); assert.doesNotMatch(a.err, /task t1 |check \(sandboxed/);
  // legacy state dir: HOME without ~/.aos/orch but with the old dashboard-plugin folder
  const home = path.join(sb.root, 'home'); const legacy = path.join(home, '.claude', 'plugins', 'data', 'aos-dashboard-aos-local', 'orch'); fs.mkdirSync(legacy, { recursive: true });
  const lenv = { ...env, HOME: home }; delete lenv.AOS_ORCH_DIR; delete lenv.XDG_STATE_HOME;
  const n1 = await cli(['goals'], lenv); const n2 = await cli(['goals'], lenv); const n3 = await cli(['goals', '--verbose'], lenv);
  assert.match(n1.err, /using the existing state in/); assert.doesNotMatch(n2.err, /using the existing state in/); assert.match(n3.err, /using the existing state in/);
});

test('UX7: the drafter is told to state only given facts and add no instructions; an instruction it adds anyway is flagged as an addition', async () => {
  const { buildDraftPrompt } = await import('../lib/draft.mjs');
  const p = buildDraftPrompt({ request: 'x', facts: { files: [], make_targets: [] }, compiled: { checks: { allowlist: [{ cmd: 'node --test' }], max_timeout_s: 60 } } });
  assert.match(p, /State ONLY facts given in the REQUEST/); assert.match(p, /Do NOT add instructions or constraints the REQUEST does not state/);
  assert.deepEqual(draftAdditions('make the test suite in test/ pass', 'Make the test suite in test/ pass. Do not weaken or delete tests.'), ['Do not weaken or delete tests.']);
  assert.deepEqual(draftAdditions('fix the failing tests and add words(s) to src/strings.js', 'Fix the failing tests. Add words(s) to src/strings.js.'), []);
  const t = renderDraft({ tier: 'haiku', profile: 'strict', rules_hash: 'abc', usage: { new_tokens: 1, notional_usd: 0 }, errors: [], questions: [], additions: ['Do not weaken or delete tests.'],
    draft: { title: 't', description: 'Make it pass. Do not weaken or delete tests.', risks: [], budgets: {}, success_criteria: [] } });
  assert.match(t, /!! ADDED BY THE DRAFTER \(not in your request; keep it or delete it from goal\.json\): Do not weaken or delete tests\./);
});

test('UX8: with worker.self_check on, the worker-commands line says the worker may run its approved checks via the engine', () => {
  const view = reviewView([{ id: 't1', title: 'x', depends_on: [], orch: { model_tier: 'haiku', path_scope: ['a.txt'], allowed_commands: [], checks: [{ argv: ['node', '--test', 'a.test.mjs'], timeout_s: 30 }] } }]);
  assert.match(renderReview(view, '', { selfCheck: true }), /worker commands: \(none; read-only inspection; self-check: may run its approved checks via the engine\)/);
  assert.match(renderReview(view, ''), /worker commands: \(none; read-only inspection only\)/);
});
