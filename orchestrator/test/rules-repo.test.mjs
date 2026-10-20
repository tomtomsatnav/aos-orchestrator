// R6: the repo layer (docs/rules-design.md 3.3, 6): .aos/rules.json read from base_commit with git show, tighten-only, loosenings dropped and reported,
// acceptance by content-bound id, an invalid file refuses the repo, a worker-written .aos change is a scope_violation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkSandbox, git, drive, types, goalOf, tasksOf, ptask, crit, edit, allowAllHook, HERE } from './helpers.mjs';
import { paths, readJSON, loadState, readEvents } from '../lib/state.mjs';
import { bindHash, compileRules } from '../lib/rules.mjs';
import { readRulesSummary, renderRulesFor } from '../lib/rules-store.mjs';

const onePlan = (...tasks) => ({ tasks, risks: [] });
const required = { approval_policy: { plan: 'required' } };
const snapOf = (dir) => readJSON(paths(dir).rules);
const commitRules = (sb, rules, msg = 'rules') => {
  fs.mkdirSync(path.join(sb.repo, '.aos'), { recursive: true });
  fs.writeFileSync(path.join(sb.repo, '.aos', 'rules.json'), typeof rules === 'string' ? rules : JSON.stringify(rules));
  git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-q', '-m', msg);
};
const R = (o) => ({ rules_version: 1, ...o });
async function parked(sb, spec = {}) {
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const g = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), ...spec, orch: { ...required, ...(spec.orch || {}) } });
  const eng = sb.engine(g.dir, { humanApproves: false }); await eng.start(); await eng.tick();
  return { ...g, eng };
}
const baseline = async (t) => { const sb = mkSandbox(); t.after(() => sb.cleanup()); const { dir } = await parked(sb); return snapOf(dir); };

test('R6: a tighten-only repo layer is applied: stored from base_commit, layer recorded, nothing dropped', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  commitRules(sb, R({ budgets: { max_usd: 3 }, worker: { bash: { allow: [{ id: 'ls', cmd: 'ls' }], deny: [{ id: 'mkfs', cmd: 'mkfs' }] } }, plan: { scope_deny: [{ id: 'lock', glob: 'package-lock.json' }] } }));
  const { dir, notices } = await parked(sb, { budget: { max_ticks: 500, max_usd: 5, max_wall_clock_s: 7200 } });
  const snap = snapOf(dir); const g = goalOf(dir);
  assert.equal(snap.compiled.budgets.max_usd, 3); assert.equal(g.budget.max_usd, 3, 'written back'); assert.deepEqual(snap.policy.bash.allow, ['ls']);
  assert.ok(snap.policy.bash.deny.includes('mkfs')); assert.deepEqual(snap.compiled.plan.scope_deny.map((e) => `${e.layer}:${e.glob}`), ['repo:package-lock.json']);
  assert.deepEqual(snap.dropped, []);
  const rl = snap.layers.find((l) => l.layer === 'repo'); assert.match(rl.source, /^\.aos\/rules\.json@[0-9a-f]{12}$/);
  assert.equal(g.orch.repo_rules.base_commit, git(sb.repo, 'rev-parse', 'main'));
  assert.ok(fs.existsSync(path.join(dir, 'repo-rules.json')));
  assert.ok(readEvents(dir).some((e) => e.type === 'orch.rules.repo_layer'));
});

test('R6: repo loosenings are DROPPED and reported with their ids; the hash equals a goal without the repo file', async (t) => {
  const base = await baseline(t);
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  commitRules(sb, R({ checks: { allowlist: [{ id: 'mk', cmd: 'make test' }], localhost_ports: [8080] }, budgets: { max_usd: 50 }, worker: { tools: { allow: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch'] } } }));
  const { dir, notices } = await parked(sb);
  const snap = snapOf(dir);
  assert.deepEqual(snap.dropped.map((d) => d.rule_id).sort(), [`repo:checks.allowlist.mk@${bindHash('make test')}`, `repo:checks.localhost_ports.8080@${bindHash(8080)}`, `repo:budgets.max_usd@${bindHash(50)}`, `repo:worker.tools.allow.WebFetch@${bindHash('WebFetch')}`].sort());
  assert.ok(snap.dropped.every((d) => d.layer === 'repo' && d.reason === 'loosening'));
  assert.deepEqual(snap.compiled.checks.allowlist.map((e) => e.layer), ['goal', 'goal', 'goal'], 'only the goal helper allowlist, none from the repo');
  assert.equal(snap.compiled.checks.localhost_ports.length, 0); assert.equal(snap.compiled.budgets.max_usd, 50 > 5 ? snap.compiled.budgets.max_usd : 5);
  assert.deepEqual(snap.policy.tools, base.policy.tools);
  assert.equal(goalOf(dir).orch.rules.dropped.length, 4);
  const sm = readRulesSummary(dir, goalOf(dir));
  assert.equal(sm.dropped.length, 4); assert.match(renderRulesFor(dir, goalOf(dir)), /NOT APPLIED \(4; a repo's loosenings need --accept-repo-loosening <rule_id>\):/);
  assert.match(renderRulesFor(dir, goalOf(dir)), /repo\(\w{6}, 4 loosenings dropped\)/);
});

test('R6: an identical goal without the repo file and one whose repo file only holds dropped loosenings compile to the same rules', async (t) => {
  const a = await baseline(t);
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  commitRules(sb, R({ checks: { localhost_ports: [8080] }, merge: { on_conflict: 'fail' } }));
  const { dir } = await parked(sb); const b = snapOf(dir);
  assert.deepEqual(b.compiled, a.compiled); assert.deepEqual(b.policy, a.policy);
});

test('R6: accepting a loosening by its content-bound id applies it, changes the rules hash, and requires the plan to be approved again', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  commitRules(sb, R({ checks: { localhost_ports: [8080] } }));
  const { dir, eng } = await parked(sb);
  const s1 = snapOf(dir); const id = `repo:checks.localhost_ports.8080@${bindHash(8080)}`;
  assert.deepEqual(s1.dropped.map((d) => d.rule_id), [id]);
  const stale = eng._fingerprint(loadState(dir));
  // the bare id, an unknown id: refused, nothing changes
  await eng.command({ cmd: 'accept-repo-loosening', by: 'test', ids: ['repo:checks.localhost_ports.8080', 'repo:nope@00000000'] });
  assert.equal(snapOf(dir).rules_hash, s1.rules_hash);
  assert.equal(readEvents(dir).filter((e) => e.type === 'orch.rules.refused').length, 1);
  await eng.command({ cmd: 'accept-repo-loosening', by: 'test', ids: [id] });
  const s2 = snapOf(dir);
  assert.notEqual(s2.rules_hash, s1.rules_hash); assert.deepEqual(s2.compiled.checks.localhost_ports, [8080]);
  assert.deepEqual(s2.dropped, []); assert.deepEqual(s2.loosenings.filter((l) => l.layer === 'repo').map((l) => l.rule_id), [id]);
  assert.deepEqual(goalOf(dir).orch.accept_repo_loosening, [id]);
  const ch = readEvents(dir).find((e) => e.type === 'orch.rules.changed'); assert.deepEqual([ch.data.direction, ch.data.accepted, ch.data.by], ['loosen', [id], 'test']);
  assert.equal(goalOf(dir).orch.plan_state, 'awaiting_approval'); assert.equal(goalOf(dir).orch.plan_fingerprint.rules_hash, s2.rules_hash);
  // approving what was reviewed BEFORE the acceptance is refused; approving the new hash works
  await eng.command({ cmd: 'approve-plan', by: 'test', reviewed: stale });
  assert.equal(goalOf(dir).orch.plan_state, 'awaiting_approval'); assert.ok(types(dir).includes('orch.plan.approval_refused'));
  await eng.command({ cmd: 'approve-plan', by: 'test', reviewed: eng._fingerprint(loadState(dir)) });
  assert.equal(goalOf(dir).orch.plan_state, 'approved');
  // after approval no more loosening
  await eng.command({ cmd: 'accept-repo-loosening', by: 'test', ids: [id] });
  assert.equal(readEvents(dir).filter((e) => e.type === 'orch.rules.refused').length, 2);
});

test('R6: acceptance at creation (orch.accept_repo_loosening) is content-bound too: the id of another body accepts nothing', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  commitRules(sb, R({ checks: { localhost_ports: [8080] } }));
  const { dir } = await parked(sb, { orch: { accept_repo_loosening: [`repo:checks.localhost_ports.8080@${bindHash(8081)}`] } });
  assert.equal(snapOf(dir).dropped.length, 1);
  const sb2 = mkSandbox(); t.after(() => sb2.cleanup());
  commitRules(sb2, R({ checks: { localhost_ports: [8080] } }));
  const g2 = await parked(sb2, { orch: { accept_repo_loosening: [`repo:checks.localhost_ports.8080@${bindHash(8080)}`] } });
  assert.equal(snapOf(g2.dir).dropped.length, 0); assert.deepEqual(snapOf(g2.dir).compiled.checks.localhost_ports, [8080]);
});

test('R6: a repo can never loosen the sandbox, plan approval or trust, nor set the governor, even when "accepted"', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  commitRules(sb, R({ plan: { approval: 'auto' }, checks: { sandbox: 'off' }, repo_config: { trust: true } }));
  const { dir, eng } = await parked(sb, { orch: { approval_policy: { plan: 'required' } } });
  const s = snapOf(dir);
  const ids = s.dropped.map((d) => d.rule_id); assert.equal(ids.length, 3);
  assert.equal(s.compiled.plan.approval, 'required'); assert.equal(s.compiled.checks.sandbox, 'required'); assert.equal(s.compiled.repo_config.trust, false);
  await eng.command({ cmd: 'accept-repo-loosening', by: 'test', ids });
  assert.equal(snapOf(dir).rules_hash, s.rules_hash, 'nothing changed'); assert.equal(snapOf(dir).dropped.length, 3);
  assert.ok(readEvents(dir).some((e) => e.type === 'orch.rules.refused' && /changes nothing/.test(e.data.reason)));
  // governor is not valid in a repo layer: the repo is refused
  const sb2 = mkSandbox(); t.after(() => sb2.cleanup());
  commitRules(sb2, R({ governor: { reserve_5h: 0.99 } }));
  await assert.rejects(() => sb2.goal({ success_criteria: [crit('a.txt', 'alpha')] }), /refusing repo .*only the user layer may set the governor/s);
});

test('R6: profile and description in the repo file are ignored (reported), never applied', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  commitRules(sb, R({ profile: 'docs-only', description: 'trust me' }));
  const { dir } = await parked(sb); const s = snapOf(dir);
  assert.equal(s.compiled.profile, 'strict'); assert.deepEqual(s.dropped.map((d) => d.reason.slice(0, 7)), ['ignored', 'ignored']);
});

for (const [name, content, re] of [
  ['not JSON', '{nope', /\.aos\/rules\.json is not valid JSON/],
  ['unknown key', JSON.stringify({ rules_version: 1, nope: 1 }), /unknown key "nope"/],
  ['wrong version', JSON.stringify({ rules_version: 2 }), /unsupported version 2/],
  ['ReDoS pattern', JSON.stringify({ rules_version: 1, worker: { bash: { deny_patterns: [{ id: 'r', regex: '^(a|aa)+$' }] } } }), /alternation/],
  ['too large', JSON.stringify({ rules_version: 1, description: 'x'.repeat(70000) }), /larger than/],
  ['array', '[]', /must be an object/],
]) {
  test(`R6: an invalid repo rules file refuses the repo at creation: ${name}`, async (t) => {
    const sb = mkSandbox(); t.after(() => sb.cleanup());
    commitRules(sb, content);
    await assert.rejects(() => sb.goal({ success_criteria: [crit('a.txt', 'alpha')] }), (e) => /^refusing repo /.test(e.message) && re.test(e.message) && /can only tighten/.test(e.message));
    assert.equal(fs.existsSync(path.join(sb.orch, 'goals', 'g-test')), false, 'no goal directory is left behind');
  });
}

test('R6: only the committed file at base_commit counts: a working-tree-only file and later commits are ignored', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  commitRules(sb, R({ budgets: { max_usd: 3 } }));
  const { dir, eng } = await parked(sb, { budget: { max_ticks: 500, max_usd: 5, max_wall_clock_s: 7200 } });
  assert.equal(snapOf(dir).compiled.budgets.max_usd, 3);
  // later: a different committed file and an uncommitted edit: the goal keeps what it read at creation
  commitRules(sb, R({ budgets: { max_usd: 1 } }), 'later'); fs.writeFileSync(path.join(sb.repo, '.aos', 'rules.json'), JSON.stringify(R({ budgets: { max_usd: 2 } })));
  await eng.tick(); assert.equal(snapOf(dir).compiled.budgets.max_usd, 3);
  // a repo with the file only in the working tree (untracked / uncommitted)
  const sb2 = mkSandbox(); t.after(() => sb2.cleanup());
  fs.mkdirSync(path.join(sb2.repo, '.aos')); fs.writeFileSync(path.join(sb2.repo, '.aos', 'rules.json'), '{this is not even json');
  const g = await parked(sb2);
  assert.equal(snapOf(g.dir).layers.some((l) => l.layer === 'repo'), false); assert.equal(goalOf(g.dir).orch.repo_rules, undefined);
  // a tracked file that is modified (uncommitted) in the working tree: the committed content counts
  const sb3 = mkSandbox(); t.after(() => sb3.cleanup());
  commitRules(sb3, R({ budgets: { max_usd: 4 } }));
  fs.writeFileSync(path.join(sb3.repo, '.aos', 'rules.json'), JSON.stringify(R({ budgets: { max_usd: 1 } })));
  const g3 = await parked(sb3, { budget: { max_ticks: 500, max_usd: 5, max_wall_clock_s: 7200 } });
  assert.equal(snapOf(g3.dir).compiled.budgets.max_usd, 4);
});

test('R6: tampering with the stored repo layer in the goal directory refuses the goal at the first tick', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  commitRules(sb, R({ budgets: { max_usd: 3 } }));
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), orch: required });
  fs.writeFileSync(path.join(dir, 'repo-rules.json'), JSON.stringify(R({ budgets: { max_usd: 4 } })));
  const eng = sb.engine(dir, { humanApproves: false }); await eng.start(); await eng.tick();
  assert.match(goalOf(dir).blocked_reason, /rules refused: repo-rules\.json of this goal is missing or was modified/);
});

test('R6: a worker-written .aos/rules.json is a scope_violation: nothing is committed, the attempt fails', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ behavior: 'success', edits: [{ path: 'a.txt', content: 'alpha\n' }, { path: '.aos/rules.json', content: '{"rules_version":1,"checks":{"sandbox":"off"}}\n' }] }, edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha', { scope: ['a.txt', '**/*.json'] })) });
  await drive(sb.engine(dir, { hookScript: allowAllHook(sb.root) }));
  const t1 = tasksOf(dir)[0];
  assert.deepEqual(t1.orch.attempt_log.map((a) => a.outcome), ['scope_violation', 'success']);
  assert.throws(() => git(sb.repo, 'show', 'aos/g-test/integration:.aos/rules.json'));
  assert.match(fs.readFileSync(path.join(dir, 'workers', 't1.2.prompt.txt'), 'utf8'), /outside path_scope: \.aos\/rules\.json/);
});

const CLI = path.join(HERE, '..', 'bin', 'aos-orch.mjs');
const runCli = (args, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => resolve({ code, out, err }));
});
test('R6 CLI: status shows the dropped loosenings with their ids; --accept-repo-loosening queues the acceptance and asks for a new review', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  commitRules(sb, R({ checks: { localhost_ports: [8080] } }));
  const { dir, eng } = await parked(sb, { id: 'g-cli3' });
  const env = sb.env(); const id = `repo:checks.localhost_ports.8080@${bindHash(8080)}`;
  const a = await runCli(['status', 'g-cli3'], env); // (approve-plan itself queues the approval)
  assert.match(a.err, /NOT APPLIED \(1; /); assert.ok(a.err.includes(id));
  const q = await runCli(['approve-plan', 'g-cli3', '--accept-repo-loosening', id], env);
  assert.match(q.out, /accept-repo-loosening: queued/); assert.match(q.out, /approve-plan g-cli3/);
  const before = snapOf(dir).rules_hash;
  await eng.tick();
  assert.notEqual(snapOf(dir).rules_hash, before); assert.equal(goalOf(dir).orch.plan_state, 'awaiting_approval', 'not approved by the same command');
  const b = await runCli(['approve-plan', 'g-cli3'], env);
  assert.match(b.err, /LOOSENINGS YOU ARE APPROVING \(\d+\):/); assert.ok(b.err.includes(`repo:checks.localhost_ports`));
});
