// R5: user and goal layers (docs/rules-design.md section 6): rules.json, the legacy policy file and goal fields mapped onto layers, loosenings listed,
// compiled values written back, and the approval screens' rules summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkSandbox, drive, types, goalOf, tasksOf, fakeCalls, ptask, crit, edit, HERE } from './helpers.mjs';
import { paths, readJSON, loadState, readEvents } from '../lib/state.mjs';
import { policyToRules, goalLegacyRules, compileRules, summarizeRules, renderRulesSummary, toPolicy, DEFAULT_RULES, bindHash, validateRules } from '../lib/rules.mjs';
import { readRulesSummary, renderRulesFor } from '../lib/rules-store.mjs';
import { mergePolicy, DEFAULT_POLICY } from '../lib/policy.mjs';
import { reviewView, renderReview } from '../lib/plan.mjs';

const onePlan = (...tasks) => ({ tasks, risks: [] });
const required = { approval_policy: { plan: 'required' } };
const snapOf = (dir) => readJSON(paths(dir).rules);
async function parked(sb, spec = {}, userRules = null) {
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  if (userRules) fs.writeFileSync(path.join(sb.orch, 'rules.json'), JSON.stringify(userRules));
  const g = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), ...spec, orch: { ...required, ...(spec.orch || {}) } });
  const eng = sb.engine(g.dir, { humanApproves: false }); await eng.start(); await eng.tick();
  return { ...g, eng };
}

test('R5 unit: policyToRules maps the legacy policy; code-running entries and non-rules are dropped with a note', () => {
  const m = policyToRules({ version: 1, default: 'deny', tools: { allow: ['Read'] }, paths: { write: 'worktree+scope', deny: ['**/secret/**'], read_extra: ['~/docs'], on_outside_scope: 'deny' },
    bash: { allow: ['ls', 'node --test', 'sort'], deny: ['mkfs'], deny_patterns: ['x{2}'], ask_on: ['unparsed'] }, approval: { wait_in_hook_s: 0.3, ttl_s: 77, on_timeout: 'deny' }, extra: 1 });
  assert.equal(validateRules(m.rules).ok, true, JSON.stringify(validateRules(m.rules).errors));
  assert.deepEqual(m.rules.worker.tools, { allow: ['Read'] }); assert.deepEqual(m.rules.worker.bash.allow.map((e) => e.cmd), ['ls', 'sort']);
  assert.deepEqual(m.rules.worker.approval, { wait_in_hook_s: 0.3, ttl_s: 77 });
  assert.ok(m.notes.some((n) => /node --test.*dropped/.test(n))); assert.ok(m.notes.some((n) => /policy\.extra/.test(n)));
  assert.equal(m.notes.some((n) => /paths\.write/.test(n)), false, 'the default paths.write is not noise');
  // the engine writes DEFAULT_POLICY to policy.default.json: mapping it changes nothing
  const d = policyToRules(DEFAULT_POLICY); const c = compileRules([{ layer: 'user', rules: d.rules }]);
  assert.equal(c.ok, true); assert.equal(c.loosenings.length + c.dropped.length, 0); assert.deepEqual(toPolicy(c.compiled), DEFAULT_POLICY); assert.deepEqual(d.notes, []);
});

test('R5 unit: goalLegacyRules maps only non-default goal fields', () => {
  const goal = { budget: { max_ticks: 500, max_usd: 9, max_wall_clock_s: 7200 }, orch: { budgets: { max_new_tokens: 2000000, max_parallel: 2, max_tasks: 20, approval_ttl_s: 86400 }, check_allowlist: ['grep', 'sh -c', ['node', '--test']],
    check_localhost_ports: [8080], unsandboxed_checks: true, sandbox_workers: true, trust_repo_config: true, approval_policy: { plan: 'auto' }, governor: { reserve_5h: 0.1 } } };
  const m = goalLegacyRules(goal); const r = m.rules;
  assert.deepEqual([r.budgets, r.parallel, r.plan], [{ max_usd: 9 }, { max_parallel: 2 }, { max_tasks: 20, approval: 'auto' }]);
  assert.deepEqual(r.checks.allowlist.map((e) => e.cmd), ['grep', 'node --test']); assert.deepEqual([r.checks.sandbox, r.checks.localhost_ports], ['off', [8080]]);
  assert.deepEqual([r.worker.sandbox, r.repo_config], ['required', { trust: true }]);
  assert.ok(m.notes.some((n) => /sh -c/.test(n)) && m.notes.some((n) => /governor/.test(n)));
  assert.equal(validateRules(r, { layer: 'goal' }).ok, true);
  assert.deepEqual(goalLegacyRules({ budget: {}, orch: { budgets: { ...DEFAULT_RULES.budgets } } }).rules, { rules_version: 1 });
});

test('R5: no rules.json and a plain goal: compiled = defaults, policy = DEFAULT_POLICY, not legacy; the legacy goal fields show up as listed loosenings', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const { dir } = await parked(sb, { orch: { check_allowlist: ['grep', 'node'], budgets: { max_parallel: 3 } } });
  const snap = snapOf(dir); const o = goalOf(dir).orch;
  assert.equal(snap.legacy, false); assert.deepEqual(snap.policy, DEFAULT_POLICY);
  assert.deepEqual(snap.compiled.checks.allowlist.map((e) => `${e.layer}:${e.cmd}`), ['goal:grep', 'goal:node']);
  assert.deepEqual(snap.loosenings.map((l) => l.rule_id).slice(0, 2), [`goal:checks.allowlist.grep@${bindHash('grep')}`, `goal:checks.allowlist.node@${bindHash('node')}`]);
  assert.deepEqual(snap.loosenings.slice(2).map((l) => l.path), ['budgets.max_ticks', 'budgets.max_usd'], 'the test helper asks for 100000 ticks and $50: both are listed');
  assert.ok(o.rules.loosenings.every((l) => l.layer === 'goal')); assert.equal(o.rules.legacy, false);
  assert.deepEqual(o.rules.layers.map((l) => l.layer), ['default', 'user', 'goal'], 'the auto-written policy.default.json is the user layer');
  assert.equal(readEvents(dir).find((e) => e.type === 'orch.rules.snapshotted').data.loosenings, 4);
  assert.equal(o.plan_fingerprint.rules_hash, snap.rules_hash);
});

test('R5: a user rules.json tightens: compiled values reach the policy file and goal.json; it supersedes policy.default.json', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  fs.writeFileSync(path.join(sb.orch, 'policy.default.json'), JSON.stringify({ approval: { wait_in_hook_s: 1 } })); // ignored: rules.json wins
  const { dir, eng } = await parked(sb, { budget: { max_ticks: 500, max_usd: 5, max_wall_clock_s: 7200 }, orch: { budgets: { max_parallel: 3 } } }, { rules_version: 1, profile: 'docs-only', budgets: { max_usd: 2, max_new_tokens: 500000 }, parallel: { max_parallel: 1 },
    worker: { bash: { allow: [{ id: 'ls', cmd: 'ls' }, { id: 'cat', cmd: 'cat' }] }, approval: { wait_in_hook_s: 3 } }, plan: { max_tasks: 4 } });
  const snap = snapOf(dir); const g = goalOf(dir);
  assert.equal(snap.compiled.profile, 'docs-only'); assert.deepEqual(snap.policy.bash.allow, ['ls', 'cat']); assert.equal(snap.policy.approval.wait_in_hook_s, 3);
  assert.deepEqual(snap.loosenings.filter((l) => l.layer === 'user'), []);
  assert.deepEqual([g.budget.max_usd, g.orch.budgets.max_new_tokens, g.orch.budgets.max_parallel, g.orch.budgets.max_tasks], [2, 500000, 1, 4], 'compiled values are written back');
  assert.equal(snap.layers.find((l) => l.layer === 'user').source, 'rules.json');
  await eng.command({ cmd: 'approve-plan', by: 'test', reviewed: eng._fingerprint(loadState(dir)) });
  await drive(eng);
  assert.equal(goalOf(dir).status, 'achieved');
  const wp = readJSON(path.join(dir, 'workers', 't1.1.policy.json'));
  assert.deepEqual(wp.policy.bash.allow, ['ls', 'cat']); assert.equal(wp.rules_hash, snap.rules_hash);
});

test('R5: an invalid user rules.json refuses the goal at creation, and (when it breaks later) at the first tick: blocked, orch.rules.refused, no snapshot, no worker, no planner', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: { behavior: 'success', plan: onePlan(ptask('t1', 'a.txt', 'alpha')) }, tasks: { t1: [edit('a.txt', 'alpha')] } });
  const rf = path.join(sb.orch, 'rules.json');
  fs.writeFileSync(rf, JSON.stringify({ rules_version: 1, worker: { sandbox: 'maybe' }, nope: 1 }));
  await assert.rejects(() => sb.goal({ success_criteria: [crit('a.txt', 'alpha')], orch: required }), (e) => /rules refused/.test(e.message) && /rules\.json: \$: unknown key "nope"/.test(e.message));
  fs.writeFileSync(rf, '{nope');
  await assert.rejects(() => sb.goal({ success_criteria: [crit('a.txt', 'alpha')], orch: required }), /rules\.json is not valid JSON/);
  // valid at creation, broken before the engine's first tick
  fs.rmSync(rf);
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], orch: required });
  fs.writeFileSync(rf, JSON.stringify({ rules_version: 1, worker: { sandbox: 'maybe' } }));
  const eng = sb.engine(dir, { humanApproves: false }); await eng.start(); await eng.tick(); await eng.tick();
  const g = goalOf(dir);
  assert.equal(g.status, 'blocked'); assert.match(g.blocked_reason, /^rules refused: .*rules\.json/); assert.equal(g.orch.rules, undefined);
  assert.equal(fs.existsSync(paths(dir).rules), false);
  const ev = readEvents(dir).filter((e) => e.type === 'orch.rules.refused'); assert.equal(ev.length, 1, 'once, not every tick');
  assert.equal(fakeCalls(sb, 'planner').length, 0); assert.equal(g.orch.usage.workers_started, 0);
});

test('R5: legacy goal.orch.policy override and policy.default.json behave as before (compare with mergePolicy of the same inputs)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  fs.writeFileSync(path.join(sb.orch, 'policy.default.json'), JSON.stringify({ approval: { wait_in_hook_s: 7 }, paths: { read_extra: ['~/shared'] } }));
  const { dir } = await parked(sb, { orch: { policy: { approval: { wait_in_hook_s: 0.3 } }, budgets: { max_parallel: 3 } } });
  const snap = snapOf(dir);
  // wait_in_hook_s: the tighter of the two (the old shallow merge took the goal's; here both are <= the default, so the same value 0.3 results)
  assert.equal(snap.policy.approval.wait_in_hook_s, 0.3); assert.deepEqual(snap.policy.paths.read_extra, ['~/shared']);
  const old = mergePolicy({ approval: { wait_in_hook_s: 7 }, paths: { read_extra: ['~/shared'] } }, { approval: { wait_in_hook_s: 0.3 } });
  assert.deepEqual(snap.policy.approval, { ...old.approval, ttl_s: 86400 });
  assert.deepEqual({ ...snap.policy, approval: old.approval, paths: { ...snap.policy.paths, read_extra: old.paths.read_extra } }, old);
  assert.deepEqual(snap.loosenings.filter((l) => l.path.startsWith('worker')).map((l) => l.path), ['worker.paths.read_extra'], 'read_extra beyond the default is a listed loosening');
});

test('R5: the goal spec orch.rules layer: loosenings are applied and listed; tightenings are not; the plan approval binds the hash', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const { dir, eng } = await parked(sb, { orch: { rules: { rules_version: 1, budgets: { max_new_tokens: 4000000 }, worker: { bash: { allow: [{ id: 'ls', cmd: 'ls' }] } }, plan: { max_tasks: 5 } } } });
  const snap = snapOf(dir); const g = goalOf(dir);
  assert.equal(g.orch.budgets.max_new_tokens, 4000000); assert.equal(g.orch.budgets.max_tasks, 5);
  assert.deepEqual(snap.policy.bash.allow, ['ls']);
  const lo = snap.loosenings.find((l) => l.path === 'budgets.max_new_tokens');
  assert.deepEqual([lo.layer, lo.from, lo.to, lo.rule_id], ['goal', 2000000, 4000000, `goal:budgets.max_new_tokens@${bindHash(4000000)}`]);
  assert.equal(g.orch.rules_layer.budgets.max_new_tokens, 4000000);
  const hash = snap.rules_hash;
  await eng.command({ cmd: 'approve-plan', by: 'test', reviewed: eng._fingerprint(loadState(dir)) });
  assert.equal(goalOf(dir).orch.plan_approval.rules_hash, hash);
  // an invalid goal rules layer is refused at creation
  await assert.rejects(() => sb.goal({ id: 'g-bad', success_criteria: [crit('a.txt', 'alpha')], orch: { rules: { rules_version: 1, governor: { reserve_5h: 0.1 } } } }), /goal\.orch\.rules is invalid/);
  await assert.rejects(() => sb.goal({ id: 'g-bad2', success_criteria: [crit('a.txt', 'alpha')], orch: { rules: [] } }), /must be an object/);
});

test('R5: a user layer that requires plan approval / sandboxes overrides a goal that asks for less (write-back)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const { dir } = await parked(sb, { orch: { approval_policy: { plan: 'auto' }, unsandboxed_checks: false } }, { rules_version: 1, plan: { approval: 'required' }, worker: { sandbox: 'required' } });
  const g = goalOf(dir);
  // order is default -> user -> goal: the goal asks for auto (a loosening of the user's required) and the human's goal layer may do that, listed
  assert.equal(g.orch.approval_policy.plan, 'auto'); assert.ok(snapOf(dir).loosenings.some((l) => l.path === 'plan.approval' && l.layer === 'goal'));
  assert.equal(g.orch.sandbox_workers, true, 'the user layer turned the worker sandbox on');
});

test('R5: the rules summary: profile, key allows and denies, every loosening with its layer, next to the hash', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const { dir } = await parked(sb, { orch: { check_allowlist: ['node'], rules: { rules_version: 1, budgets: { max_usd: 8 } } } }, { rules_version: 1, profile: 'node-library', worker: { paths: { read_extra: [{ id: 'sh', glob: '~/shared/**' }] } } });
  const sm = readRulesSummary(dir, goalOf(dir)); const snap = snapOf(dir);
  assert.equal(sm.rules_hash, snap.rules_hash.slice(0, 12)); assert.equal(sm.profile, 'node-library');
  assert.deepEqual(sm.loosenings.map((l) => `${l.layer}:${l.path}`), ['user:worker.paths.read_extra', 'goal:checks.allowlist', 'goal:budgets.max_ticks', 'goal:budgets.max_usd']);
  assert.ok(sm.worker.bash_allow.includes('ls') && sm.denies.bash.includes('git push') && sm.denies.floor.includes('.aos'));
  const text = renderRulesFor(dir, goalOf(dir));
  assert.match(text, new RegExp(`^rules ${sm.rules_hash}  profile=node-library  layers: default\\(\\w{6}\\) user\\(\\w{6}\\) goal\\(\\w{6}\\)`));
  assert.match(text, /LOOSENINGS YOU ARE APPROVING \(4\):/); assert.match(text, /goal:budgets\.max_usd {2}5 -> 8 {3}\[goal:budgets\.max_usd@[0-9a-f]{8}\]/);
  assert.match(text, /user:worker\.paths\.read_extra {2}\+ ~\/shared\/\*\*/); assert.match(text, /goal:checks\.allowlist {2}\+ node/);
  assert.match(text, /worker bash allow \(13\): ls, cat/); assert.match(text, /floor \(never removable\): \.git/);
  // the CLI screens render it: renderReview appends it after the tasks
  const S = loadState(dir); const rv = renderReview(reviewView(S.tasks), text);
  assert.ok(rv.indexOf('task t1') < rv.indexOf('rules ') && rv.includes('LOOSENINGS YOU ARE APPROVING'));
  assert.equal(renderReview(reviewView(S.tasks)).includes('rules '), false, 'unchanged without a summary');
  // tampered snapshot: the summary says so instead of showing edited content
  const f = paths(dir).rules; const x = readJSON(f); x.compiled.budgets.max_usd = 1; fs.writeFileSync(f, JSON.stringify(x));
  assert.deepEqual(Object.keys(readRulesSummary(dir, goalOf(dir))), ['tampered', 'rules_hash']); assert.match(renderRulesFor(dir, goalOf(dir)), /^RULES TAMPERED/);
  assert.equal(summarizeRules(null), null); assert.match(renderRulesSummary(null), /no snapshot/);
});

const CLI = path.join(HERE, '..', 'bin', 'aos-orch.mjs');
const runCli = (args, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => resolve({ code, out, err }));
});
test('R5: `aos-orch approve-plan` and `status` print the rules summary and the hash; `approvals` too', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const { dir } = await parked(sb, { id: 'g-cli2', orch: { rules: { rules_version: 1, budgets: { max_usd: 8 } } } });
  const env = sb.env();
  const a = await runCli(['approve-plan', 'g-cli2'], env);
  assert.match(a.err, /PLAN YOU ARE APPROVING/); assert.match(a.err, /rules [0-9a-f]{12}  profile=strict/); assert.match(a.err, /LOOSENINGS YOU ARE APPROVING \(5\)/); assert.match(a.err, /goal:budgets\.max_usd/);
  assert.match(a.err, /plan hash [0-9a-f]{12}  rules hash [0-9a-f]{12}/);
  const s = await runCli(['status', 'g-cli2'], env); assert.match(s.err, /LOOSENINGS YOU ARE APPROVING/);
  const p = await runCli(['approvals', 'g-cli2'], env); assert.match(p.err, /rules [0-9a-f]{12}/);
  assert.ok(readJSON(paths(dir).goal).orch.rules.sha256);
});

import { Supervisor } from '../lib/supervisor.mjs';
import { planView } from '../server/views.mjs';
import { until } from './server-helpers.mjs';
test('R5: the server plan view keeps its shape and ADDS rules + rules_text (no absolute paths); null until the first snapshot', async (t) => {
  const sb = mkSandbox('aos-sup'); sb.scenario({ tasks: { t1: edit('a.txt', 'alpha') } });
  const s = new Supervisor({ orchDir: sb.orch, env: sb.env(), pollMs: 40, intervalMs: 200, scanMs: 60000, engineOpts: { killGraceMs: 300, budgetGraceMs: 400 } });
  t.after(async () => { await s.stop({ workers: 'kill' }).catch(() => {}); sb.cleanup(); });
  fs.writeFileSync(path.join(sb.orch, 'rules.json'), JSON.stringify({ rules_version: 1, worker: { paths: { read_extra: [{ id: 'sh', glob: '/Users/someone/shared/**' }] } } }));
  await sb.goal({ id: 'g-v', success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), orch: { ...required, rules: { rules_version: 1, budgets: { max_usd: 8 } } } });
  assert.equal(planView(s, 'g-v').rules, null); assert.equal(planView(s, 'g-v').rules_text, null);
  await s.start();
  await until(() => s.state('g-v').S.goal.orch.plan_state === 'awaiting_approval', { what: 'plan' });
  const v = planView(s, 'g-v');
  assert.deepEqual(Object.keys(v).sort(), ['plan_hash', 'plan_state', 'rules', 'rules_text', 'tasks']);
  assert.deepEqual(Object.keys(v.tasks[0]).sort(), ['allowed_commands', 'allowed_tools', 'checks', 'depends_on', 'id', 'path_scope', 'tier', 'title']);
  assert.equal(v.rules.rules_hash, s.reviewHash('g-v').rules_hash.slice(0, 12)); assert.equal(v.rules.profile, 'strict');
  assert.ok(v.rules.loosenings.some((l) => l.layer === 'goal' && l.path === 'budgets.max_usd'));
  assert.ok(v.rules.loosenings.some((l) => l.layer === 'user' && l.path === 'worker.paths.read_extra'));
  assert.match(v.rules_text, /LOOSENINGS YOU ARE APPROVING/); assert.equal(/\/Users\/someone/.test(JSON.stringify(v)), false);
});
