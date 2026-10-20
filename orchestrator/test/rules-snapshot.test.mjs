// R4: the rules snapshot (docs/rules-design.md section 3.2): rules are fixed per goal, bound into the plan approval hash,
// re-verified at every dispatch and verify, and a mid-run edit of a policy file has no effect (G2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkSandbox, drive, types, goalOf, tasksOf, fakeCalls, ptask, crit, edit } from './helpers.mjs';
import { until } from './server-helpers.mjs';
import { Supervisor } from '../lib/supervisor.mjs';
import { readJSON, loadState, paths, readEvents } from '../lib/state.mjs';
import { snapshotHash, rulesFingerprint } from '../lib/rules.mjs';
import { planHash, tasksHash, sha256 } from '../lib/plan.mjs';

const onePlan = (...tasks) => ({ tasks, risks: [] });
const required = { approval_policy: { plan: 'required' } };
const editSnapshot = (dir, fn) => { const f = paths(dir).rules; const s = readJSON(f); fn(s); fs.writeFileSync(f, JSON.stringify(s)); };

test('R4: a goal gets a 0600 rules snapshot on its first tick; goal.json records the hash; the plan fingerprint and approval bind it', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), orch: required });
  assert.equal(fs.existsSync(paths(dir).rules), false, 'nothing is snapshotted before the engine loads the goal');
  const eng = sb.engine(dir, { humanApproves: false }); await eng.start(); await eng.tick();
  const f = paths(dir).rules;
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const snap = readJSON(f); const o = goalOf(dir).orch;
  assert.equal(snap.rules_version, 1); assert.equal(snap.legacy, false);
  assert.equal(snap.policy.bash.allow[0], 'ls'); assert.equal(snap.policy.approval.ttl_s, 86400); assert.equal(snap.compiled.profile, 'strict');
  assert.equal(snapshotHash(snap), snap.rules_hash);
  assert.deepEqual([o.rules.sha256, o.rules.hash, o.rules.legacy, o.rules.profile], [snap.rules_hash, snap.rules_hash.slice(0, 12), false, 'strict']);
  assert.ok(o.rules.layers.some((l) => l.layer === 'default'));
  assert.deepEqual(types(dir).filter((x) => x.startsWith('orch.rules')), ['orch.rules.snapshotted']);
  assert.equal(o.plan_fingerprint.rules_hash, snap.rules_hash);
  assert.equal(goalOf(dir).orch.plan_state, 'awaiting_approval');
  await eng.command({ cmd: 'approve-plan', by: 'test', reviewed: eng._fingerprint(loadState(dir)) });
  assert.equal(goalOf(dir).orch.plan_approval.rules_hash, snap.rules_hash);
  await drive(eng);
  assert.equal(goalOf(dir).status, 'achieved');
  assert.equal(readEvents(dir).filter((e) => e.type === 'orch.rules.snapshotted').length, 1, 'snapshotted once');
});

test('R4 (G2): editing policy.default.json mid-run has no effect; workers get the snapshot policy and its hash', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const pf = path.join(sb.orch, 'policy.default.json');
  fs.writeFileSync(pf, JSON.stringify({ approval: { wait_in_hook_s: 7 } }));
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), orch: required });
  const eng = sb.engine(dir, { humanApproves: false }); await eng.start(); await eng.tick();
  fs.writeFileSync(pf, JSON.stringify({ tools: { allow: [] }, approval: { wait_in_hook_s: 1 }, bash: { allow: ['rm'] } })); // a human (or another process) edits the file mid-run
  await eng.command({ cmd: 'approve-plan', by: 'test', reviewed: eng._fingerprint(loadState(dir)) });
  await drive(eng);
  assert.equal(goalOf(dir).status, 'achieved');
  const wp = readJSON(path.join(dir, 'workers', 't1.1.policy.json'));
  assert.equal(wp.policy.approval.wait_in_hook_s, 7); assert.ok(wp.policy.tools.allow.includes('Write')); assert.ok(!wp.policy.bash.allow.includes('rm'));
  assert.equal(wp.rules_hash, goalOf(dir).orch.rules.sha256);
});

for (const [name, tamper] of [
  ['edited policy', (dir) => editSnapshot(dir, (s) => { s.policy.bash.allow.push('rm'); })],
  ['edited compiled rules', (dir) => editSnapshot(dir, (s) => { s.compiled.checks.sandbox = 'off'; })],
  ['deleted', (dir) => fs.rmSync(paths(dir).rules)],
  ['garbage', (dir) => fs.writeFileSync(paths(dir).rules, '{not json')],
]) {
  test(`R4 tamper: rules snapshot ${name} after approval halts the goal; nothing more is dispatched or merged`, async (t) => {
    const sb = mkSandbox(); t.after(() => sb.cleanup());
    sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')], t2: [edit('b.txt', 'beta')] } });
    const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta')), orch: { budgets: { max_parallel: 1 } } });
    const eng = sb.engine(dir); await eng.start();
    await eng.tick();
    assert.equal(goalOf(dir).orch.plan_approval.by, 'human'); assert.equal(tasksOf(dir)[0].status, 'running');
    tamper(dir);
    await drive(eng);
    assert.match(goalOf(dir).blocked_reason, /rules modified after approval/);
    assert.ok(types(dir).includes('orch.rules.tampered'));
    assert.equal(fakeCalls(sb, 't2').length, 0, 't2 must never start');
    assert.notEqual(tasksOf(dir)[0].status, 'done', 'the in-flight task is not merged either');
  });
}

test('R4: a stale combined hash is rejected by the server path after the snapshot changed', async (t) => {
  const sb = mkSandbox('aos-sup'); sb.scenario({ tasks: { t1: edit('a.txt', 'alpha') } });
  const s = new Supervisor({ orchDir: sb.orch, env: sb.env(), pollMs: 40, intervalMs: 200, scanMs: 60000, engineOpts: { killGraceMs: 300, budgetGraceMs: 400 } });
  t.after(async () => { await s.stop({ workers: 'kill' }).catch(() => {}); sb.cleanup(); });
  const { dir } = await sb.goal({ id: 'g-a', success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), orch: required });
  await s.start();
  await until(() => s.state('g-a').S.goal.orch.plan_state === 'awaiting_approval', { what: 'plan' });
  const h1 = s.reviewHash('g-a');
  assert.match(h1.rules_hash, /^[0-9a-f]{64}$/);
  assert.equal(h1.combined, sha256(`${h1.plan_hash}:${h1.tasks_hash}:${h1.rules_hash}`));
  editSnapshot(dir, (x) => { x.policy.approval.wait_in_hook_s = 1; });
  const h2 = s.reviewHash('g-a');
  assert.notEqual(h2.combined, h1.combined);
  await assert.rejects(() => s.approvePlan('g-a', h1.combined, 'test'), (e) => e.status === 409 && e.code === 'plan_changed');
  assert.equal(s.state('g-a').S.goal.orch.plan_state, 'awaiting_approval');
});

// ---- a goal that already has a plan but no snapshot (created before R4)
async function legacyGoal(sb, orchExtra = {}) {
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const g = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), orch: { ...required, ...orchExtra } });
  const eng = sb.engine(g.dir, { humanApproves: false }); await eng.start(); await eng.tick();
  // turn it back into a pre-R4 goal: no snapshot file, no orch.rules, no rules hash in the fingerprint
  fs.rmSync(paths(g.dir).rules);
  // and pre-v2: the tasks hash then omits the description text
  const gj = readJSON(paths(g.dir).goal); delete gj.orch.rules; delete gj.orch.plan_fingerprint.rules_hash; delete gj.orch.plan_fingerprint.tasks_hash_v; delete gj.orch.tasks_hash_v; gj.orch.plan_fingerprint.tasks_hash = tasksHash(loadState(g.dir).tasks); fs.writeFileSync(paths(g.dir).goal, JSON.stringify(gj));
  return { ...g, eng };
}

test('R4 legacy: a goal with a plan but no snapshot gets a legacy snapshot on first load; its plan hash and approval are unchanged', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const { dir, eng } = await legacyGoal(sb);
  const S0 = loadState(dir);
  const before = { plan_hash: planHash(readJSON(paths(dir).plan).plan), tasks_hash: tasksHash(S0.tasks) };
  assert.equal(eng._fingerprint(S0).rules_hash, undefined, 'no rules in the fingerprint of a goal without rules');
  const reviewed = eng._fingerprint(S0); // what a human saw before the upgrade
  assert.deepEqual(reviewed, before);
  await eng.command({ cmd: 'approve-plan', by: 'test', reviewed });
  const o = goalOf(dir).orch;
  assert.equal(o.rules.legacy, true); assert.equal(readJSON(paths(dir).rules).legacy, true);
  assert.equal(o.plan_state, 'approved'); assert.deepEqual({ plan_hash: o.plan_approval.plan_hash, tasks_hash: o.plan_approval.tasks_hash }, before); assert.equal(o.plan_approval.rules_hash, undefined);
  const ev = readEvents(dir).filter((e) => e.type === 'orch.rules.snapshotted'); assert.equal(ev.at(-1).data.legacy, true);
  assert.equal(rulesFingerprint(goalOf(dir), readJSON(paths(dir).rules)), undefined);
  await drive(eng);
  assert.equal(goalOf(dir).status, 'achieved');
});

test('R4 legacy: a legacy snapshot is tamper-checked too (hash recorded in goal.json)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const { dir, eng } = await legacyGoal(sb);
  await eng.command({ cmd: 'approve-plan', by: 'test', reviewed: eng._fingerprint(loadState(dir)) });
  assert.equal(goalOf(dir).orch.plan_state, 'approved');
  editSnapshot(dir, (s) => { s.policy.bash.allow.push('rm'); });
  await drive(eng);
  assert.notEqual(tasksOf(dir)[0].status, 'done', 'the in-flight task is not merged');
  assert.match(goalOf(dir).blocked_reason, /rules modified after approval/); assert.ok(types(dir).includes('orch.rules.tampered'));
});

test('R4 legacy: the legacy snapshot carries the old effective policy (policy file + goal override + approval ttl)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  fs.writeFileSync(path.join(sb.orch, 'policy.default.json'), JSON.stringify({ approval: { wait_in_hook_s: 9 }, paths: { read_extra: ['/tmp/x'] } }));
  const { dir, eng } = await legacyGoal(sb, { policy: { approval: { ttl_s: 77 } }, budgets: { approval_ttl_s: 123 } });
  await eng.tick();
  const p = readJSON(paths(dir).rules).policy;
  assert.equal(p.approval.wait_in_hook_s, 20, 'a goal-level policy object replaces the file (as before): the file is not consulted');
  assert.equal(p.approval.ttl_s, 77);
});

test('R4: approving a plan whose rules snapshot changed since it was reviewed is refused', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), orch: required });
  const eng = sb.engine(dir, { humanApproves: false }); await eng.start(); await eng.tick();
  const reviewed = eng._fingerprint(loadState(dir));
  editSnapshot(dir, (s) => { s.policy.approval.wait_in_hook_s = 1; });
  await eng.command({ cmd: 'approve-plan', by: 'test', reviewed });
  assert.equal(goalOf(dir).orch.plan_state, 'awaiting_approval'); assert.ok(types(dir).includes('orch.plan.approval_refused'));
  assert.equal(fakeCalls(sb, 't1').length, 0);
});
