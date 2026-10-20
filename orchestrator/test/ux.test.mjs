// Demo UX fixes: multi-line draft rendering, task-sized draft budgets and tightening flags, read-only `plan`, `run --wait-approval`, the rules summary's profile block,
// the "beyond the prompt" flag, the planner prompt and `rules check <goal file>`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkSandbox, ptask, crit, HERE, sleep } from './helpers.mjs';
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
  const spec = { id: 'g-ux', title: 'Create a.txt with alpha', success_criteria: [crit('a.txt', 'alpha')], budget: { max_ticks: 1000, max_usd: 5, max_wall_clock_s: 600 }, orch: { repo: sb.repo, base_branch: 'main', check_allowlist: ['node'] } };
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
  r = await cli(['approve-plan', 'g-ux'], env); assert.match(r.out, /queued; the attached run \(pid \d+\) will apply it within one tick/);
  assert.equal(await closed, 0, err); assert.equal(JSON.parse(out).status, 'achieved');
});

test('cli: run stops at "awaiting human confirmation" with the exact confirm command', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: { behavior: 'success', plan: { tasks: [ptask('t1', 'a.txt', 'alpha')] } }, tasks: { t1: [{ behavior: 'success', edits: [{ path: 'a.txt', content: 'alpha\n' }] }] } });
  const spec = { id: 'g-hc', title: 'Create a.txt', success_criteria: [crit('a.txt', 'alpha'), { id: 'c2', text: 'reads well', verify: 'human' }], orch: { repo: sb.repo, base_branch: 'main', check_allowlist: ['node'] } };
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
