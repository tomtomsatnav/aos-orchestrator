// Reliability fixes found by a real plain-vs-orchestrator comparison: planner re-plan (tier limits in the prompt, one automatic re-plan with the errors,
// `run --replan`), unique generated goal ids, draft repair/normalisation/partial files, protection of existing tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkSandbox, drive, goalOf, tasksOf, ptask, crit, edit, fakeCalls, HERE } from './helpers.mjs';
import { readEvents, readJSON, paths, normalizeGoalSpec } from '../lib/state.mjs';
import { createGoal } from '../lib/engine.mjs';

const CLI = path.join(HERE, '..', 'bin', 'aos-orch.mjs');
export const cli = (args, env) => new Promise((resolve) => { const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; }); c.on('close', (code) => resolve({ code, out, err })); });
const onePlan = (...tasks) => ({ tasks, risks: [] });
const plannerCalls = (sb) => fakeCalls(sb, '');
const planners = (sb) => { try { return fs.readFileSync(path.join(sb.fakeState, 'invocations.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((i) => i.planner); } catch { return []; } };
const HAIKU_ONLY = { orch: { rules: { rules_version: 1, plan: { max_start_tier: 'haiku' } } } };
const sonnetPlan = () => onePlan(ptask('t1', 'a.txt', 'alpha', { tier: 'sonnet' }));
const haikuPlan = () => onePlan(ptask('t1', 'a.txt', 'alpha', { tier: 'haiku' }));
const planStep = (plan) => ({ behavior: 'success', plan });

test('planner prompt states the tier limits, task limit and check prefixes as hard limits', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: planStep(haikuPlan()), tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], ...HAIKU_ONLY });
  await drive(sb.engine(dir));
  const p = planners(sb)[0].prompt;
  assert.match(p, /HARD LIMITS/); assert.match(p, /one of \[haiku\] and never above "haiku" \(plan\.max_start_tier\)/); assert.match(p, /at most 12 tasks/);
  assert.match(p, /every check argv must START with one of/);
});

test('a planner plan that breaks plan.max_start_tier gets ONE automatic re-plan with the validation errors, recorded as an event, and then works', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: [planStep(sonnetPlan()), planStep(haikuPlan())], tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], ...HAIKU_ONLY });
  await drive(sb.engine(dir));
  assert.equal(goalOf(dir).status, 'achieved');
  const calls = planners(sb); assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[0].prompt, /PREVIOUS PLAN WAS REJECTED/);
  assert.match(calls[1].prompt, /PREVIOUS PLAN WAS REJECTED.*model_tier sonnet is above plan\.max_start_tier haiku/);
  const ev = readEvents(dir).find((e) => e.type === 'orch.plan.replan');
  assert.ok(ev); assert.equal(ev.data.attempt, 1); assert.match(ev.data.errors.join(), /above plan\.max_start_tier/); assert.equal(ev.data.counted_in_budget, true);
  assert.equal(readEvents(dir).filter((e) => e.type === 'orch.plan.rejected').length, 0);
});

test('a plan that is still invalid after the automatic re-plan blocks the goal with the errors listed; no third planner call', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: planStep(sonnetPlan()) });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], ...HAIKU_ONLY });
  await drive(sb.engine(dir));
  const g = goalOf(dir); assert.equal(g.status, 'blocked'); assert.equal(g.orch.plan_state, 'rejected');
  assert.match(g.blocked_reason, /still invalid after 1 automatic re-plan.*above plan\.max_start_tier/);
  assert.equal(planners(sb).length, 2); assert.equal(tasksOf(dir).length, 0);
});

test('`run <goal> --replan` on a goal blocked at planning re-plans (without the flag it only offers); the replan command resets the goal', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: [planStep(sonnetPlan()), planStep(sonnetPlan()), planStep(haikuPlan())], tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], ...HAIKU_ONLY, orch: { ...HAIKU_ONLY.orch, approval_policy: { plan: 'required' } } });
  const eng = sb.engine(dir, { humanApproves: false }); await drive(eng); await eng.stop();
  assert.equal(goalOf(dir).status, 'blocked'); assert.equal(planners(sb).length, 2);
  const id = goalOf(dir).id;
  let r = await cli(['run', id], sb.env());
  assert.match(r.err, /blocked at planning.*aos-orch run .* --replan/s); assert.equal(planners(sb).length, 2, 'no re-plan without the flag'); assert.equal(r.code, 2);
  r = await cli(['run', id, '--replan'], sb.env());
  assert.equal(planners(sb).length, 3, r.err); assert.equal(r.code, 4, r.err + r.out); // awaiting plan approval
  assert.equal(goalOf(dir).orch.plan_state, 'awaiting_approval'); assert.equal(tasksOf(dir).length, 1);
  assert.ok(readEvents(dir).some((e) => e.type === 'orch.plan.replan_requested'));
});

test('generated goal ids are unique (two goals from the same title and day); an explicit id stays strict', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const spec = (extra = {}) => ({ title: 'Same title', success_criteria: [crit('a.txt', 'alpha')], budget: { max_ticks: 10, max_usd: 1, max_wall_clock_s: 60 }, orch: { repo: sb.repo, base_branch: 'main', check_allowlist: ['node'] }, ...extra });
  const clock = { now: () => Date.UTC(2026, 9, 20) };
  const a = await createGoal(sb.orch, spec(), { clock }); const b = await createGoal(sb.orch, spec(), { clock });
  assert.notEqual(a.goal.id, b.goal.id); assert.match(a.goal.id, /^g-20261020-same-title-[0-9a-f]{4}$/);
  await createGoal(sb.orch, spec({ id: 'my-goal' }), { clock });
  await assert.rejects(() => createGoal(sb.orch, spec({ id: 'my-goal' }), { clock }), /already exists/);
});

// ---------------------------------------------------------------- draft
import { draftGoal, normalizeCheck } from '../lib/draft.mjs';
import { compileRules } from '../lib/rules.mjs';
const ALLOW = { rules_version: 1, checks: { allowlist: [{ id: 'grep', cmd: 'grep' }, { id: 'node-test', cmd: 'node --test' }, { id: 'npm-test', cmd: 'npm test' }] } };
const compiled = () => compileRules([{ layer: 'user', rules: ALLOW }]).compiled;
const draftOut = (checks, extra = {}) => ({ behavior: 'success', usage: { input_tokens: 100, output_tokens: 200 }, draft: { title: 'Pricing fix', description: 'd',
  success_criteria: [...checks.map((check, i) => ({ id: `c${i + 1}`, text: `criterion ${i + 1}`, check })), { id: 'h', text: 'reads well', verify: 'human' }], risks: [], ...extra } });
const dsb = (t, steps) => { const sb = mkSandbox(); t.after(() => sb.cleanup()); fs.writeFileSync(path.join(sb.orch, 'rules.json'), JSON.stringify(ALLOW)); sb.scenario({ draft: steps }); return sb; };
const dcalls = (sb) => fakeCalls(sb, 'draft');

test('draft: near-miss checks are normalised deterministically (npm run test, node x.test.mjs, timeout above the max), never beyond the allowlist', () => {
  const c = compiled();
  assert.deepEqual(normalizeCheck({ argv: ['npm', 'run', 'test'], timeout_s: 30 }, c).check.argv, ['npm', 'test']);
  assert.deepEqual(normalizeCheck({ argv: ['node', 'pricing.test.mjs'], timeout_s: 30 }, c).check.argv, ['node', '--test', 'pricing.test.mjs']);
  assert.equal(normalizeCheck({ argv: ['grep', '-q', 'x', 'f'], timeout_s: 99999 }, c).check.timeout_s, 3600);
  assert.deepEqual(normalizeCheck({ argv: ['pytest'], timeout_s: 30 }, c).check.argv, ['pytest'], 'not on the list and no near-miss: untouched (then rejected)');
  assert.deepEqual(normalizeCheck({ argv: ['make', 'test'], timeout_s: 30 }, c).notes, []);
});

test('draft: the prompt carries the closed list of allowed commands with examples; a near-miss output is accepted without a second call', async (t) => {
  const sb = dsb(t, [draftOut([{ argv: ['npm', 'run', 'test'], timeout_s: 30 }])]);
  const r = await draftGoal({ orchDir: sb.orch, repo: sb.repo, prompt: 'fix pricing', env: sb.env() });
  assert.equal(r.ok, true, r.errors.join('; ')); assert.equal(dcalls(sb).length, 1);
  assert.match(dcalls(sb)[0].prompt, /CLOSED LIST of allowed check commands/); assert.match(dcalls(sb)[0].prompt, /Valid check examples/);
  assert.deepEqual(r.draft.success_criteria[0].check.argv, ['npm', 'test']); assert.match(r.notes.join(), /npm run test -> npm test/);
});

test('draft: invalid twice -> ONE repair round with the errors and the allowlist, then a partial draft (valid parts + errors), never a goal', async (t) => {
  const bad = draftOut([{ argv: ['make', 'test'], timeout_s: 30 }, { argv: ['grep', '-qx', 'alpha', 'a.txt'], timeout_s: 30 }]);
  const sb = dsb(t, [bad, bad]);
  const r = await draftGoal({ orchDir: sb.orch, repo: sb.repo, prompt: 'fix pricing', env: sb.env() });
  assert.equal(r.ok, false); assert.equal(dcalls(sb).length, 2); assert.equal(r.spec, null);
  assert.match(dcalls(sb)[1].prompt, /only repair round.*make test.*ONLY allowed check commands are: \["grep","node --test","npm test"\]/s);
  const p = r.partial_spec; assert.equal(p._partial, true); assert.match(p._errors.join(), /not on the rules' check allowlist/);
  assert.deepEqual(p.success_criteria.map((c) => c.id), ['c2', 'h']); assert.equal(p._rejected_criteria[0].id, 'c1'); assert.deepEqual(p._allowed_checks, ['grep', 'node --test', 'npm test']);
  assert.equal(fs.existsSync(path.join(sb.orch, 'goals')), false);
  // the CLI writes goal.partial.json, exits 2, and `run` refuses the file
  const out = path.join(sb.root, 'goal.json');
  const c = await cli(['draft', 'fix pricing', '--repo', sb.repo, '--out', out], sb.env());
  assert.equal(c.code, 2); assert.equal(fs.existsSync(out), false); const pf = path.join(sb.root, 'goal.partial.json');
  assert.equal(JSON.parse(fs.readFileSync(pf, 'utf8'))._partial, true); assert.match(c.err, /PARTIAL draft/);
  const run = await cli(['run', pf], sb.env()); assert.equal(run.code, 64); assert.match(run.err, /INCOMPLETE draft/);
});

test('draft: budgets proposed by the model are ignored (defaults, flags and rules only); no budget figure is in the prompt', async (t) => {
  const sb = dsb(t, [draftOut([{ argv: ['grep', '-qx', 'alpha', 'a.txt'], timeout_s: 30 }], { budgets: { max_usd: 0.1, max_new_tokens: 1000 } })]);
  const r = await draftGoal({ orchDir: sb.orch, repo: sb.repo, prompt: 'fix pricing', env: sb.env() });
  assert.equal(r.ok, true, r.errors.join('; ')); assert.equal(r.spec.budget.max_usd, 5); assert.equal(r.draft.budgets.max_new_tokens, 150000);
  assert.ok(Object.values(r.budget_notes).every((n) => n.source !== 'model')); assert.match(r.notes.join(), /ignored model-proposed budgets \(max_usd, max_new_tokens\)/);
  assert.doesNotMatch(dcalls(sb)[0].prompt, /Budget limits|"max_usd"/);
});
