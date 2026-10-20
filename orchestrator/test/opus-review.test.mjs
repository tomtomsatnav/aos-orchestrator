// Opus review findings: zero is never "unlimited"; the API never auto-approves plans; the profile NAME is recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkSandbox, edit, ptask, crit } from './helpers.mjs';
import { startStack, until, goalBody } from './server-helpers.mjs';
import { validateRules, compileRules, DEFAULT_RULES } from '../lib/rules.mjs';
import { checkBudgets } from '../lib/governor.mjs';
import { validateBudgetPatch, readJSON, goalDirOf, paths } from '../lib/state.mjs';
import { createGoal } from '../lib/engine.mjs';
import { buildArgs } from '../lib/worker.mjs';
import { readRulesSummary } from '../lib/rules-store.mjs';

const POSITIVE = [['budgets', 'max_usd'], ['budgets', 'attempt_usd_cap'], ['budgets', 'draft_usd_cap'], ['budgets', 'max_new_tokens'], ['budgets', 'max_ticks'], ['budgets', 'max_wall_clock_s'],
  ['budgets', 'task_wall_clock_s'], ['budgets', 'stall_after_s'], ['budgets', 'max_turns'], ['parallel', 'max_parallel'], ['retry', 'max_attempts'], ['plan', 'max_tasks']];

test('1: every cap in the rules schema must be > 0 (0 is refused, never "unlimited"); the default rules and a repo layer alike', () => {
  for (const [sec, k] of POSITIVE) {
    assert.ok(DEFAULT_RULES[sec][k] > 0, `${sec}.${k} default`);
    for (const layer of ['repo', 'user', 'goal']) {
      const r = compileRules([{ layer, rules: { rules_version: 1, [sec]: { [k]: 0 } } }]);
      assert.equal(r.ok, false, `${layer} ${sec}.${k}=0 must be refused`);
    }
  }
  assert.equal(validateRules({ rules_version: 1, budgets: { max_usd: 0.01 } }).ok, true);
});

test('1: the governor treats a zero or negative cap as "nothing allowed", never "unlimited" (defence in depth)', () => {
  const g = (b, usd = 0) => ({ orch: { usage: { new_tokens: 0, notional_usd: usd }, budgets: { max_new_tokens: b.max_new_tokens ?? 1e9 }, started_ms: null }, budget: { max_usd: 5, max_ticks: 500, max_wall_clock_s: 7200, ...b } });
  for (const b of [{ max_usd: 0 }, { max_new_tokens: 0 }, { max_wall_clock_s: 0 }, { max_ticks: 0 }]) assert.ok(checkBudgets(g(b), { nowMs: 1, seq: 0 }).hard.length > 0, JSON.stringify(b));
  assert.equal(checkBudgets(g({}), { nowMs: 1, seq: 0 }).hard.length, 0);
});

test('1: budget patches, goal specs and the worker argv refuse a zero USD cap', async () => {
  assert.equal(validateBudgetPatch({ max_usd: 0 }).ok, false);
  const sb = mkSandbox(); try {
    await assert.rejects(createGoal(sb.orch, { id: 'g-zero', title: 't', success_criteria: [crit('a.txt', 'a')], budget: { max_usd: 0 }, orch: { repo: sb.repo } }), /budget is invalid/);
  } finally { sb.cleanup(); }
  assert.throws(() => buildArgs({ prompt: 'p', tier: 'haiku', sessionId: 's', maxBudgetUsd: 0, settingsFile: '/x' }), /max-budget-usd/);
  assert.throws(() => buildArgs({ prompt: 'p', tier: 'haiku', sessionId: 's', maxBudgetUsd: 'x', settingsFile: '/x' }), /max-budget-usd/);
});

test('2 + 3: POST /api/goals with profile docs-only never enables plan auto-approval (noted), and the profile NAME is recorded and shown', async (t) => {
  const sb = mkSandbox('aos-srv'); sb.scenario({ planner: { behavior: 'success', plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] } }, tasks: { t1: edit('a.txt', 'alpha') } });
  const s = await startStack(sb, {}); t.after(async () => { for (const st of sb.stacks) await st.stop().catch(() => {}); sb.cleanup(); });
  const r = await s.api('POST', '/api/goals', goalBody(sb.repo, { profile: 'docs-only', success_criteria: [{ text: 'read it', verify: 'human' }] }));
  assert.equal(r.status, 201, r.text); const id = r.json.goal.id; const dir = goalDirOf(sb.orch, id);
  assert.ok(r.json.notices.some((n) => /plan\.approval "auto".*always require a human/.test(n)), JSON.stringify(r.json.notices));
  const o = readJSON(paths(dir).goal).orch;
  assert.equal(o.approval_policy.plan, 'required'); assert.equal(o.rules_layer.plan.approval, undefined); assert.equal(o.profile_name, 'docs-only');
  await until(() => readJSON(paths(dir).goal).orch.rules, { what: 'rules snapshot' });
  const g = readJSON(paths(dir).goal); const snap = readJSON(paths(dir).rules);
  assert.equal(snap.compiled.plan.approval, 'required'); assert.equal(snap.compiled.profile, 'strict', 'compiled.profile ignores non-user layers');
  assert.equal(g.orch.rules.profile_name, 'docs-only');
  const sm = readRulesSummary(dir, g); assert.equal(sm.profile, 'docs-only'); assert.equal(sm.plan.approval, 'required');
  assert.equal(g.orch.plan_approval, undefined, 'nothing approved the plan');
});
