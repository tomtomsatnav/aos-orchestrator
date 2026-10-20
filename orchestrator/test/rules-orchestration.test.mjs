// R8: the orchestration rules (retry ladder, same_tier_retries, no_escalate, planner tier, soft_frac, hard_grace_s, governor) come from the compiled rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkSandbox, drive, goalOf, tasksOf, fakeCalls, ptask, crit, edit } from './helpers.mjs';
import { checkBudgets } from '../lib/governor.mjs';
import { readEvents } from '../lib/state.mjs';

const onePlan = (...tasks) => ({ tasks, risks: [] });
const userRules = (sb, r) => fs.writeFileSync(path.join(sb.orch, 'rules.json'), JSON.stringify({ rules_version: 1, ...r }));
const wrong = (n) => ({ behavior: 'fail_checks', edits: [{ path: 'a.txt', content: `wrong ${n}\n` }] });
const tiers = (dir) => tasksOf(dir)[0].orch.attempt_log.map((a) => a.tier);

test('R8: a custom ladder (haiku, sonnet) makes sonnet the top: the second failure is final', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  userRules(sb, { retry: { ladder: ['haiku', 'sonnet'] } });
  sb.scenario({ tasks: { t1: [wrong(1), wrong(2), wrong(3)] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  await drive(sb.engine(dir));
  assert.deepEqual(tiers(dir), ['haiku', 'sonnet']);
  assert.equal(tasksOf(dir)[0].status, 'failed');
  const fin = readEvents(dir).find((e) => e.type === 'task.failed' && e.data.final);
  assert.equal(fin.data.rule, 'retry.ladder');
  assert.deepEqual(tasksOf(dir)[0].orch.tier_ladder, ['haiku', 'sonnet']);
});

test('R8: a ladder that lacks the start tier escalates to the next higher rung', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  userRules(sb, { retry: { ladder: ['opus'] } });
  sb.scenario({ tasks: { t1: [wrong(1), edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  await drive(sb.engine(dir));
  assert.deepEqual(tiers(dir), ['haiku', 'opus']); assert.equal(goalOf(dir).status, 'achieved');
});

test('R8: retry.same_tier_retries retries a cause on the same tier before escalating', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  userRules(sb, { retry: { same_tier_retries: { denied: 1, check_failed: 2 } } });
  sb.scenario({ tasks: { t1: [wrong(1), wrong(2), wrong(3), edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), orch: { budgets: { max_attempts: 4 } } });
  const eng = sb.engine(dir); await drive(eng);
  assert.deepEqual(tiers(dir), ['haiku', 'haiku', 'haiku', 'sonnet']);
  assert.ok(readEvents(dir).some((e) => e.type === 'task.retried' && e.data.rule === 'retry.same_tier_retries'));
});

test('R8: retry.no_escalate keeps a cause on its tier (union with the built-in causes)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  userRules(sb, { retry: { no_escalate: ['check_failed'] } });
  sb.scenario({ tasks: { t1: [wrong(1), edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  await drive(sb.engine(dir));
  assert.deepEqual(tiers(dir), ['haiku', 'haiku']); assert.equal(goalOf(dir).status, 'achieved');
});

test('R8: plan.planner_tier and planner_timeout_s replace the opus / 300 s constants; defaults are unchanged', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  userRules(sb, { plan: { planner_tier: 'sonnet' } }); // user layer: applied and listed as a loosening (lower than opus)
  sb.scenario({ planner: { behavior: 'success', plan: onePlan(ptask('t1', 'a.txt', 'alpha')) }, tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')] });
  const eng = sb.engine(dir, { plannerTimeoutMs: undefined }); await drive(eng);
  assert.equal(goalOf(dir).status, 'achieved');
  assert.deepEqual(fakeCalls(sb, 'planner').map((c) => c.model), ['sonnet']);
  assert.equal(eng.plannerTimeoutMs ?? null, null);
});

test('R8: the default planner tier is still opus', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: { behavior: 'success', plan: onePlan(ptask('t1', 'a.txt', 'alpha')) }, tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')] });
  await drive(sb.engine(dir));
  assert.deepEqual(fakeCalls(sb, 'planner').map((c) => c.model), ['opus']);
});

test('R8: soft_frac moves the soft limit; hard_grace_s feeds the budget kill grace', async (t) => {
  const goal = { orch: { budgets: { max_new_tokens: 1000 }, usage: { new_tokens: 500, notional_usd: 0 } }, budget: { max_wall_clock_s: 100, max_ticks: 10, max_usd: 5 } };
  assert.equal(checkBudgets(goal, { nowMs: 0, seq: 1 }).soft.length, 0);
  assert.match(checkBudgets(goal, { nowMs: 0, seq: 1, softFrac: 0.5 }).soft[0], /new tokens at 50% of the cap/);
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  userRules(sb, { budgets: { hard_grace_s: 7, soft_frac: 0.5 } });
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  const eng = sb.engine(dir, { budgetGraceMs: undefined }); await eng.start(); await eng.tick();
  assert.equal(eng._graceMs(goalOf(dir)), 7000); assert.equal(eng._R(goalOf(dir)).budgets.soft_frac, 0.5);
});

test('R8 / G5: governor thresholds come from the user layer only; goal.orch.governor is ignored', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  userRules(sb, { governor: { reserve_5h: 0.5, backoff_min: [1, 2] } });
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), orch: { governor: { reserve_5h: 0.99, hold_7d: 0.99 } } });
  const eng = sb.engine(dir); await eng.start(); await eng.tick();
  assert.equal(eng.gov.cfg.reserve_5h, 0.5); assert.deepEqual(eng.gov.cfg.backoff_min, [1, 2]); assert.equal(eng.gov.cfg.hold_7d, 0.9);
  const sb2 = mkSandbox(); t.after(() => sb2.cleanup());
  sb2.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const g2 = await sb2.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), orch: { governor: { reserve_5h: 0.99 } } });
  const e2 = sb2.engine(g2.dir); await e2.start(); await e2.tick();
  assert.equal(e2.gov.cfg.reserve_5h, 0.8, 'no user governor: the default, not the goal value');
});
