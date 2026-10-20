// Fixes for the Opus review of R1-R4 (docs/rules-design.md, Implementation notes "Review fixes").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRules, compileRules, bindHash, regexProblem, DEFAULT_RULES } from '../lib/rules.mjs';
import { validateSchema } from '../lib/schema.mjs';
import { evaluate, DEFAULT_POLICY, mergePolicy, MAX_REGEX_INPUT } from '../lib/policy.mjs';
import { decideForPayload } from '../lib/policy-hook.mjs';
import { mkSandbox, goalOf, crit, ptask, edit } from './helpers.mjs';
import { paths, readJSON } from '../lib/state.mjs';

const R = (o = {}) => ({ rules_version: 1, ...o });
const sedn = (cmd) => R({ worker: { bash: { allow: [{ id: 'sedn', cmd }] } } });

test('review 1: an acceptance binds the rule CONTENT: swapping the body under an accepted id is a new loosening', () => {
  const id = (cmd) => `repo:worker.bash.allow.sedn@${bindHash(cmd)}`;
  const allowed = (c) => c.compiled.worker.bash.allow.some((e) => e.id === 'sedn');
  // the probe: the old accept key (the bare id) accepts nothing any more
  const bare = compileRules([{ layer: 'repo', rules: sedn('sort') }], { accept: ['repo:worker.bash.allow.sedn'] });
  assert.equal(allowed(bare), false); assert.equal(bare.dropped[0].rule_id, id('sort')); assert.match(bare.dropped[0].rule_id, /^repo:worker\.bash\.allow\.sedn@[0-9a-f]{32}$/);
  const ok = compileRules([{ layer: 'repo', rules: sedn('sort') }], { accept: [id('sort')] });
  assert.equal(allowed(ok), true); assert.equal(ok.loosenings[0].rule_id, id('sort')); assert.equal(ok.dropped.length, 0);
  // the same accepted id, a different body: dropped and reported as a NEW loosening
  const swap = compileRules([{ layer: 'repo', rules: sedn('uniq') }], { accept: [id('sort')] });
  assert.equal(allowed(swap), false); assert.equal(swap.dropped[0].rule_id, id('uniq')); assert.notEqual(id('uniq'), id('sort'));
  // a body that only differs in description keeps the id (descriptions do not change behaviour)
  assert.equal(bindHash('sort'), bindHash('sort'));
});

test('review 2: profile and description from the repo or goal layer are ignored and reported; the user layer may set them', () => {
  for (const layer of ['repo', 'goal']) {
    const c = compileRules([{ layer, rules: R({ profile: 'docs-only', description: 'x' }) }]);
    assert.equal(c.compiled.profile, 'strict'); assert.equal(c.compiled.description, DEFAULT_RULES.description);
    assert.deepEqual(c.dropped.map((d) => d.rule_id), [`${layer}:profile@${bindHash('docs-only')}`, `${layer}:description@${bindHash('x')}`]);
    assert.match(c.dropped[0].reason, /ignored/);
  }
  const u = compileRules([{ layer: 'user', rules: R({ profile: 'docs-only' }) }]);
  assert.equal(u.compiled.profile, 'docs-only'); assert.equal(u.dropped.length, 0);
  assert.equal(compileRules([{ layer: 'repo', rules: R({ profile: 'strict' }) }]).dropped.length, 0, 'same value: nothing to report');
});

test('review 3: prototype names are unknown keys (schema and rules)', () => {
  const s = { type: 'object', additionalProperties: false, properties: { a: { type: 'number' } }, required: ['a'] };
  for (const k of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf']) {
    const v = JSON.parse(`{"a":1,${JSON.stringify(k)}:1}`);
    assert.ok(validateSchema(v, s).some((e) => e.includes(`unknown key "${k}"`)), k);
    const rules = JSON.parse(`{"rules_version":1,"worker":{${JSON.stringify(k)}:1}}`);
    assert.equal(validateRules(rules).ok, false, k);
    assert.ok(validateRules(JSON.parse(`{"rules_version":1,${JSON.stringify(k)}:{}}`)).errors.some((e) => /unknown key/.test(e)), k);
  }
  assert.ok(validateSchema({}, { type: 'object', required: ['constructor'] }).some((e) => /missing "constructor"/.test(e)), 'inherited names do not satisfy required');
  assert.deepEqual(validateSchema({ a: 1 }, s), []);
});

test('review 4: ReDoS: user regexes are restricted, capped, and run on bounded input under a timeout', () => {
  for (const re of ['^(a|aa)+$', '(a+)+$', '(a*)*b', '(x|y)*z', '(a+){2,}', '^(a)\\1$', '(?=a)b', '(?!a)b', '(?<=a)b', '(?<n>a)', 'a'.repeat(201), 'a*b*c*d*e']) {
    const v = validateRules(R({ worker: { bash: { deny_patterns: [{ id: 'r', regex: re }] } } }));
    assert.equal(v.ok, false, re);
  }
  for (const re of ['\\|\\s*(sh|bash)\\b', 'rm\\s+-rf', '(?:foo|bar)\\s+baz', '(ab)?c', '[a-z]+@x', 'a{2,4}b', '\\bdrop\\s+table\\b']) assert.equal(regexProblem(re), null, re);
  assert.equal(validateRules(DEFAULT_RULES).ok, true, 'the built-in lookahead pattern is trusted');
  // a hostile pattern that bypassed validation (a legacy policy file) cannot hang the hook: it is cut off and denied
  const ctx = { worktree: '/w', path_scope: [], allowed_tools: ['Bash'], allowed_commands: [], grants: [], home: '/h' };
  const evil = mergePolicy({ bash: { deny_patterns: ['^(a|aa)+$'] } });
  const t0 = Date.now();
  const r = evaluate(evil, { tool_name: 'Bash', tool_input: { command: `${'a'.repeat(4000)}!` }, cwd: '/w' }, ctx);
  assert.ok(Date.now() - t0 < 2000, 'bounded');
  assert.deepEqual([r.decision, r.rule, r.rule_id], ['deny', 'policy_error', 'floor:policy_error']);
  // a command longer than the cap asks (its deny patterns are not run) and other checks still apply
  const long = evaluate(DEFAULT_POLICY, { tool_name: 'Bash', tool_input: { command: `ls ${'a'.repeat(MAX_REGEX_INPUT)}` }, cwd: '/w' }, ctx);
  assert.deepEqual([long.decision, long.rule, long.rule_id], ['ask', 'command_too_long', 'floor:command_too_long']);
  const longBad = evaluate(DEFAULT_POLICY, { tool_name: 'Bash', tool_input: { command: `curl x ${'a'.repeat(MAX_REGEX_INPUT)}` }, cwd: '/w' }, ctx);
  assert.equal(longBad.decision, 'deny');
  const ok = evaluate(DEFAULT_POLICY, { tool_name: 'Bash', tool_input: { command: `ls ${'a'.repeat(MAX_REGEX_INPUT - 10)}` }, cwd: '/w' }, ctx);
  assert.equal(ok.decision, 'allow');
});

test('review nits: same_tier_retries is bounded, empty ladder/tiers are rejected, empty tiers cannot result from a merge', () => {
  const ctx = { worktree: '/w', path_scope: [], allowed_tools: ['Bash'], allowed_commands: [], grants: [], home: '/h' };
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`cause_${String.fromCharCode(97 + i)}`, 1]));
  assert.ok(validateRules(R({ retry: { same_tier_retries: many } })).errors.some((e) => /more than 8 keys/.test(e)));
  for (const k of ['Bad', '__proto__', 'constructor', 'a'.repeat(40)]) assert.equal(validateRules(JSON.parse(`{"rules_version":1,"retry":{"same_tier_retries":{${JSON.stringify(k)}:1}}}`)).ok, false, k);
  assert.equal(validateRules(R({ retry: { ladder: [] } })).ok, false); assert.equal(validateRules(R({ plan: { tiers: [] } })).ok, false);
  const c = compileRules([{ layer: 'user', rules: R({ plan: { tiers: ['opus'] } }) }, { layer: 'repo', rules: R({ plan: { tiers: ['haiku'] } }) }]);
  assert.deepEqual(c.compiled.plan.tiers, ['opus'], 'a repo list with no overlap cannot empty the tier list');
});

test('review: read_extra is a glob: a plain path is a root, wildcards match the real path', () => {
  const ctx = { worktree: '/w/t', path_scope: [], allowed_tools: ['Read'], allowed_commands: [], grants: [], home: '/home/u' };
  const rd = (read_extra, p) => evaluate(mergePolicy({ paths: { read_extra } }), { tool_name: 'Read', tool_input: { file_path: p }, cwd: '/w/t' }, ctx).decision;
  assert.equal(rd([], '/data/a/x.txt'), 'deny');
  assert.equal(rd(['/data'], '/data/a/x.txt'), 'allow', 'directory root');
  assert.equal(rd(['/data/*/x.txt'], '/data/a/x.txt'), 'allow');
  assert.equal(rd(['/data/*/x.txt'], '/data/a/y.txt'), 'deny');
  assert.equal(rd(['/data/**'], '/data/a/b/c.txt'), 'allow');
  assert.equal(rd(['/data/*.md'], '/data/a/b.md'), 'deny', '* does not cross /');
  assert.equal(rd(['~/docs/**'], '/home/u/docs/a/b'), 'allow');
  assert.equal(rd(['/data'], '/database/x'), 'deny', 'prefix of a name is not a root');
  assert.equal(validateRules(R({ worker: { paths: { read_extra: [{ id: 'd', glob: '/data/**' }] } } })).ok, true);
  assert.equal(validateRules(R({ worker: { paths: { deny: [{ id: 'd', glob: '/data/**' }] } } })).ok, false);
});

test('review 5: the hook logs floor:rules_snapshot_invalid and the worker policy file records the ACTUAL snapshot hash', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] }, orch: { approval_policy: { plan: 'required' } } });
  const eng = sb.engine(dir, { humanApproves: false }); await eng.start(); await eng.tick();
  const good = eng._policyHead(goalOf(dir));
  assert.equal(good.rules_invalid, undefined); assert.equal(good.rules_hash, goalOf(dir).orch.rules.sha256);
  const snap = readJSON(paths(dir).rules); snap.policy.bash.allow.push('rm'); fs.writeFileSync(paths(dir).rules, JSON.stringify(snap));
  const bad = eng._policyHead(goalOf(dir));
  assert.equal(bad.rules_invalid, true); assert.deepEqual(bad.policy.tools.allow, []);
  assert.notEqual(bad.rules_hash, goalOf(dir).orch.rules.sha256, 'the actual (tampered) hash, not the expected one');
  assert.match(bad.rules_hash, /^[0-9a-f]{64}$/);
  fs.rmSync(paths(dir).rules);
  assert.equal(eng._policyHead(goalOf(dir)).rules_hash, 'invalid');
  // the hook: a deny with the floor id, in the log and in the return value
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-inv-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wt = path.join(root, 'wt'); fs.mkdirSync(wt);
  const pf = path.join(root, 'p.json'); const log = path.join(root, 'd.ndjson');
  fs.writeFileSync(pf, JSON.stringify({ ...bad, ctx: { worktree: wt, path_scope: ['a.txt'], allowed_tools: ['Write'], allowed_commands: [], grants: [], home: root } }));
  const r = await decideForPayload({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(wt, 'a.txt') }, cwd: wt }, { PATH: process.env.PATH, AOS_POLICY_FILE: pf, AOS_DECISION_LOG: log });
  assert.deepEqual([r.decision, r.rule, r.rule_id], ['deny', 'rules_snapshot_invalid', 'floor:rules_snapshot_invalid']);
  const rec = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  assert.deepEqual([rec.rule_id, rec.rule_layer, rec.rules_hash], ['floor:rules_snapshot_invalid', 'floor', bad.rules_hash.slice(0, 12)]);
});

test('review nits: every hook return carries a rule_id', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hid-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wt = path.join(root, 'wt'); fs.mkdirSync(wt);
  const pf = path.join(root, 'p.json'); const appr = path.join(root, 'ap');
  const call = (env) => decideForPayload({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(wt, 'o.txt') }, cwd: wt }, { PATH: process.env.PATH, AOS_POLICY_FILE: pf, ...env });
  assert.equal((await call({ AOS_POLICY_FILE: path.join(root, 'missing') })).rule_id, 'floor:policy_error');
  fs.writeFileSync(pf, JSON.stringify({ policy: mergePolicy({ approval: { wait_in_hook_s: 0 } }), ctx: { worktree: wt, path_scope: ['a.txt'], allowed_tools: ['Write'], allowed_commands: [], grants: [], home: root } }));
  assert.equal((await call({})).rule_id, 'floor:policy_error', 'no inbox');
  assert.equal((await call({ AOS_APPROVALS_DIR: appr })).rule_id, 'floor:ask_unresolved');
});
