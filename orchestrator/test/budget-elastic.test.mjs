// Elastic token budget: a drafted goal's provisional budget is sized from the plan, then grows only while the goal makes progress, never above the hard caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkSandbox, drive, types, goalOf, edit, ptask, crit } from './helpers.mjs';
import { readEvents } from '../lib/state.mjs';
import { planTokenBudget, grownTokenBudget } from '../lib/governor.mjs';

const T = (n, tier = 'sonnet', scope = 1) => Array.from({ length: n }, () => ({ model_tier: tier, path_scope: Array(scope).fill('x') }));
test('planTokenBudget: small plan -> small (floor 150k), large plan -> larger, planner usage added, capped at the hard limit', () => {
  const small = planTokenBudget(T(1, 'haiku')); const large = planTokenBudget(T(8, 'opus', 5));
  assert.equal(small, 150000); assert.ok(large > 2000000, String(large)); assert.ok(planTokenBudget(T(6)) > planTokenBudget(T(2)));
  assert.equal(planTokenBudget(T(8, 'opus', 5), { hard: 500000 }), 500000); assert.ok(planTokenBudget(T(4), { used: 50000 }) > planTokenBudget(T(4)));
});
test('grownTokenBudget: grows 25% at 80% usage only with progress since the last extension; bounded by the hard cap; no growth at the cap', () => {
  const g = (o) => grownTokenBudget({ used: 330000, cap: 400000, progress: 3, mark: 0, hard: 2000000, ...o });
  assert.equal(g({}), 500000); assert.equal(g({ used: 300000 }), null, 'below 80%'); assert.equal(g({ progress: 0 }), null, 'no progress');
  assert.equal(g({ mark: 3 }), null, 'no progress since the last extension'); assert.equal(g({ hard: 450000 }), 450000); assert.equal(g({ cap: 450000, hard: 450000, used: 449000 }), null);
});

const big = (n) => ({ behavior: 'success', usage: { output_tokens: n }, edits: [{ path: 'f.txt', content: 'x\n' }] });
const elasticGoal = (sb, tasks, scen) => sb.scenario({ tasks: scen }) && sb.goal({ success_criteria: [crit('d.txt', 'delta')], orch: { drafted: { tier: 'haiku', elastic_tokens: 2000000 }, budgets: { max_new_tokens: 1000 }, ...{} }, plan: { tasks, risks: [] } });
const four = () => [ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta', { deps: ['t1'] }), ptask('t3', 'c.txt', 'gamma', { deps: ['t2'] }), ptask('t4', 'd.txt', 'delta', { deps: ['t3'] })];
const w = (f, word, n) => ({ behavior: 'success', usage: { output_tokens: n }, edits: [{ path: f, content: `${word}\n` }] });

test('engine: the plan sizes the budget (shown in the plan note), then merges let it grow; the extension is an event and persisted', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const { dir } = await elasticGoal(sb, four(), { t1: [w('a.txt', 'alpha', 110000)], t2: [w('b.txt', 'beta', 110000)], t3: [w('c.txt', 'gamma', 110000)], t4: [w('d.txt', 'delta', 110000)] });
  await drive(sb.engine(dir, { budgetGraceMs: 20000 }));
  const g = goalOf(dir); assert.equal(g.status, 'achieved', g.blocked_reason);
  const sized = readEvents(dir).find((e) => e.type === 'orch.budget.sized'); assert.equal(sized.data.from, 1000); assert.equal(sized.data.to, 400000); assert.match(g.orch.token_budget_note, /sized from this plan \(4 tasks/);
  const ext = readEvents(dir).filter((e) => e.type === 'orch.budget.extended'); assert.equal(ext.length, 1); assert.equal(ext[0].data.from, 400000); assert.equal(ext[0].data.to, 500000); assert.match(ext[0].data.reason, /done/);
  assert.equal(g.orch.budgets.max_new_tokens, 500000); assert.equal(g.orch.budget_extensions.length, 1);
});
test('engine: no progress, no extension: a worker that burns past the working budget before anything merges stops the goal as before', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const { dir } = await elasticGoal(sb, four(), { t1: [w('a.txt', 'alpha', 450000)] });
  await drive(sb.engine(dir, { budgetGraceMs: 400 }));
  const g = goalOf(dir); assert.equal(g.status, 'blocked'); assert.match(g.blocked_reason, /^budget: new-token cap reached/);
  assert.equal(types(dir).includes('orch.budget.extended'), false); assert.equal(g.orch.budgets.max_new_tokens, 400000);
});
test('engine: a goal that is not drafted-elastic (hand-written or --max-tokens) keeps its fixed budget', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [w('a.txt', 'alpha', 1000)] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], orch: { drafted: { tier: 'haiku' }, budgets: { max_new_tokens: 900000 } }, plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] } });
  await drive(sb.engine(dir)); assert.equal(goalOf(dir).orch.budgets.max_new_tokens, 900000); assert.equal(types(dir).includes('orch.budget.sized'), false);
});
