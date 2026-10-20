// R7: plan validation against the compiled rules (docs/rules-design.md 6; fixes G4): allowed_commands judged by the goal's own policy, scope_deny,
// max_start_tier, tiers, max_timeout_s, max_tasks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validatePlan } from '../lib/plan.mjs';
import { compileRules, toPolicy } from '../lib/rules.mjs';
import { scopeHitsDeny } from '../lib/glob.mjs';
import { mkSandbox, goalOf, ptask, crit, edit } from './helpers.mjs';
import { readEvents } from '../lib/state.mjs';

const R = (o = {}) => ({ rules_version: 1, ...o });
const rulesFor = (layers) => { const c = compileRules(layers); assert.equal(c.ok, true, JSON.stringify(c.errors)); return { rules: c.compiled, policy: toPolicy(c.compiled) }; };
const task = (over = {}) => ({ ...ptask('t1', 'a.txt', 'alpha'), ...over });
const check = (plan, opts) => validatePlan({ tasks: plan }, { max_tasks: 12, check_allowlist: ['node'], ...opts });
const errs = (t, opts) => check([t], opts).errors.join(' | ');

test('R7: with no rules the validation is exactly as before (engine defaults)', () => {
  assert.equal(check([task()]).ok, true);
  assert.equal(check([task({ allowed_commands: ['sort'] })]).ok, true);
  assert.match(errs(task({ allowed_commands: ['node -e 1'] })), /executes code/);
  assert.match(errs(task({ checks: [{ argv: ['node', '-e', '1'], timeout_s: 3601 }] })), /timeout_s must be in \(0, 3600\]/);
});

test('R7 (G4): allowed_commands are judged by the goal\'s compiled policy, not DEFAULT_POLICY', () => {
  const none = rulesFor([]);
  assert.equal(check([task({ allowed_commands: ['sort -u'] })], none).ok, true);
  const strict = rulesFor([{ layer: 'user', rules: R({ worker: { bash: { deny: [{ id: 'sort', cmd: 'sort' }], deny_patterns: [{ id: 'dash-u', regex: '\\s-u\\b' }] } } }) }]);
  assert.match(errs(task({ allowed_commands: ['sort'] }), strict), /allowed_commands entry "sort" is dangerous \(dangerous\)/);
  assert.match(errs(task({ allowed_commands: ['uniq -u'] }), strict), /allowed_commands entry "uniq -u" is dangerous \(dangerous_pattern\)/);
  assert.equal(check([task({ allowed_commands: ['uniq'] })], strict).ok, true);
  // the same deny coming from the repo layer counts too (denies always apply)
  assert.match(errs(task({ allowed_commands: ['sort'] }), rulesFor([{ layer: 'repo', rules: R({ worker: { bash: { deny: [{ id: 'sort', cmd: 'sort' }] } } }) }])), /sort/);
});

test('R7: plan.scope_deny: a path_scope that can reach a denied glob is rejected', () => {
  const sd = (...globs) => rulesFor([{ layer: 'repo', rules: R({ plan: { scope_deny: globs.map((g, i) => ({ id: `d${i}`, glob: g })) } }) }]);
  const rej = (scope, ...deny) => /can reach/.test(errs(task({ path_scope: scope }), sd(...deny)));
  assert.equal(rej(['secrets/a.txt'], 'secrets/**'), true);
  assert.equal(rej(['secrets/**'], 'secrets/**'), true);
  assert.equal(rej(['secrets'], 'secrets/**'), true, 'a directory scope covers it');
  assert.equal(rej(['src/**'], 'src/vendor/**'), true, 'the deny is inside the scope');
  assert.equal(rej(['src/**'], '**/.env'), true, 'src/** can hold src/.env');
  assert.equal(rej(['src/a.js'], '**/.env'), false);
  assert.equal(rej(['src/**'], 'docs/**'), false);
  assert.equal(rej(['src/*.js'], 'src/vendor/**'), false, 'a single-level glob cannot reach a subdirectory');
  assert.equal(rej(['src/a.txt', 'lib/**'], 'lib/gen/**'), true, 'any entry');
  assert.equal(rej(['docs/**'], 'src/**', '*.lock'), false);
  assert.equal(rej(['package-lock.json'], 'package-lock.json'), true);
  const e = errs(task({ path_scope: ['secrets/**'] }), sd('secrets/**')); assert.match(e, /plan\.scope_deny d0, layer repo/);
  for (const [a, b, want] of [['a/**', 'a/b/**', true], ['a/*', 'a/b/**', false], ['a/b', 'a/b/c.txt', true], ['x', 'y', false], ['**/*.md', 'docs/**', true], ['src/**/*.js', 'src/gen/**', true], ['**/*.txt', 'a.txt', true], ['a.txt', '**/.env', false], ['Makefile', 'Makefile', true]]) assert.equal(scopeHitsDeny(a, b), want, `${a} vs ${b}`);
});

test('R7: plan.max_start_tier and plan.tiers bound each task\'s model_tier', () => {
  const mst = rulesFor([{ layer: 'user', rules: R({ plan: { max_start_tier: 'sonnet' } }) }]);
  assert.equal(check([task({ model_tier: 'haiku' })], mst).ok, true); assert.equal(check([task({ model_tier: 'sonnet' })], mst).ok, true);
  assert.match(errs(task({ model_tier: 'opus' }), mst), /model_tier opus is above plan\.max_start_tier sonnet/);
  const tiers = rulesFor([{ layer: 'user', rules: R({ plan: { tiers: ['sonnet', 'opus'] } }) }]);
  assert.match(errs(task({ model_tier: 'haiku' }), tiers), /model_tier haiku is not allowed by the rules \(plan\.tiers: sonnet, opus\)/);
  assert.equal(check([task({ model_tier: 'opus' })], tiers).ok, true);
  assert.match(errs(task({ model_tier: 'gpt' }), tiers), /model_tier must be one of/);
});

test('R7: checks.max_timeout_s and plan.max_tasks come from the compiled rules', () => {
  const r = rulesFor([{ layer: 'goal', rules: R({ checks: { max_timeout_s: 60 }, plan: { max_tasks: 1 } }) }]);
  const withT = (n) => task({ checks: [{ argv: ['node', '-e', '1'], timeout_s: n }] });
  assert.equal(check([withT(60)], r).ok, true);
  assert.match(errs(withT(61), r), /timeout_s must be in \(0, 60\]/);
  assert.match(check([task(), task({ id: 't2' })], { ...r, max_tasks: r.rules.plan.max_tasks }).errors.join(' '), /max_tasks is 1/);
});

for (const [name, userRules, plan, re] of [
  ['max_start_tier', { plan: { max_start_tier: 'haiku' } }, [ptask('t1', 'a.txt', 'alpha', { tier: 'opus' })], /model_tier opus is above plan\.max_start_tier haiku/],
  ['scope_deny', { plan: { scope_deny: [{ id: 'a', glob: 'a.txt' }] } }, [ptask('t1', 'a.txt', 'alpha')], /path_scope "a\.txt" can reach "a\.txt"/],
  ['bash deny (G4)', { worker: { bash: { deny: [{ id: 'sort', cmd: 'sort' }] } } }, [ptask('t1', 'a.txt', 'alpha', { cmds: ['sort'] })], /allowed_commands entry "sort" is dangerous/],
]) {
  test(`R7 engine: a supplied plan that breaks the user rules is rejected: ${name}`, async (t) => {
    const sb = mkSandbox(); t.after(() => sb.cleanup());
    sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
    fs.writeFileSync(path.join(sb.orch, 'rules.json'), JSON.stringify(R(userRules)));
    const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: { tasks: plan, risks: [] } });
    const eng = sb.engine(dir, { humanApproves: false }); await eng.start(); await eng.tick();
    const g = goalOf(dir);
    assert.equal(g.status, 'blocked'); assert.equal(g.orch.plan_state, 'rejected'); assert.match(g.blocked_reason, re);
    assert.ok(readEvents(dir).some((e) => e.type === 'orch.plan.rejected'));
  });
}

test('R7 engine: the same plan passes when the rules allow it (the rules, not the plan, decide)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  fs.writeFileSync(path.join(sb.orch, 'rules.json'), JSON.stringify(R({ plan: { max_start_tier: 'opus' } })));
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: { tasks: [ptask('t1', 'a.txt', 'alpha', { tier: 'opus', cmds: ['sort'] })], risks: [] }, orch: { approval_policy: { plan: 'required' } } });
  const eng = sb.engine(dir, { humanApproves: false }); await eng.start(); await eng.tick();
  assert.equal(goalOf(dir).orch.plan_state, 'awaiting_approval');
});
