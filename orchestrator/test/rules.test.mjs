// R1: the pure rule-set module (docs/rules-design.md sections 2-4): defaults, validation errors, merge directions, hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, validateRules, compileRules, toPolicy, rulesHash } from '../lib/rules.mjs';
import { DEFAULT_POLICY } from '../lib/policy.mjs';
import { DEFAULT_BUDGETS } from '../lib/state.mjs';
import { validateSchema } from '../lib/schema.mjs';

const R = (o = {}) => ({ rules_version: 1, ...o });
const compile = (layer, rules, opts) => compileRules([{ layer, rules: R(rules) }], opts);

test('rules: DEFAULT_RULES validates and toPolicy reproduces DEFAULT_POLICY exactly', () => {
  assert.deepEqual(validateRules(DEFAULT_RULES), { ok: true, errors: [] });
  assert.deepEqual(toPolicy(DEFAULT_RULES), DEFAULT_POLICY);
  const c = compileRules([]);
  assert.equal(c.ok, true); assert.deepEqual(c.loosenings, []);
  assert.deepEqual(toPolicy(c.compiled), DEFAULT_POLICY);
  assert.match(c.hash, /^[0-9a-f]{64}$/); assert.equal(c.hash, compileRules([]).hash, 'deterministic');
  for (const k of ['max_new_tokens', 'task_wall_clock_s', 'stall_after_s', 'max_turns', 'attempt_usd_cap']) assert.equal(DEFAULT_RULES.budgets[k], DEFAULT_BUDGETS[k], k);
  assert.equal(DEFAULT_RULES.retry.max_attempts, DEFAULT_BUDGETS.max_attempts); assert.equal(DEFAULT_RULES.plan.max_tasks, DEFAULT_BUDGETS.max_tasks);
  assert.equal(DEFAULT_RULES.parallel.max_parallel, DEFAULT_BUDGETS.max_parallel); assert.equal(DEFAULT_RULES.worker.approval.ttl_s, DEFAULT_BUDGETS.approval_ttl_s);
  assert.throws(() => { DEFAULT_RULES.profile = 'x'; }, TypeError, 'frozen (top level)');
});

test('rules: a layer with no differences leaves the hash unchanged except for the layer list', () => {
  const base = compileRules([]).hash;
  assert.equal(compile('user', {}).hash, base);
  assert.equal(compile('goal', { budgets: { max_usd: 5 } }).hash, base, 'same value is not a change');
});

const BAD = [
  ['not an object', [], /must be an object/],
  ['missing version', {}, /unsupported version undefined/],
  ['unknown version', { rules_version: 2 }, /unsupported version 2/],
  ['unknown top key', R({ nope: 1 }), /\$: unknown key "nope"/],
  ['unknown nested key', R({ worker: { paths: { zzz: [] } } }), /\$\.worker\.paths: unknown key "zzz"/],
  ['bad enum', R({ worker: { sandbox: 'maybe' } }), /\$\.worker\.sandbox: "maybe" not in enum/],
  ['wrong type', R({ budgets: { max_usd: 'x' } }), /\$\.budgets\.max_usd: expected number/],
  ['above maximum', R({ checks: { max_timeout_s: 3601 } }), /\$\.checks\.max_timeout_s: 3601 > 3600/],
  ['below minimum', R({ worker: { approval: { ttl_s: 10 } } }), /\$\.worker\.approval\.ttl_s: 10 < 60/],
  ['wait above 25', R({ worker: { approval: { wait_in_hook_s: 26 } } }), /wait_in_hook_s: 26 > 25/],
  ['too many items', R({ checks: { localhost_ports: Array.from({ length: 17 }, (_, i) => i + 1) } }), /more than 16 item/],
  ['bad id', R({ checks: { allowlist: [{ id: 'Bad Id', cmd: 'grep' }] } }), /allowlist\[0\]\.id: "Bad Id" !~/],
  ['missing cmd', R({ checks: { allowlist: [{ id: 'x' }] } }), /missing "cmd"/],
  ['cmd too long', R({ checks: { allowlist: [{ id: 'x', cmd: 'a'.repeat(201) }] } }), /longer than 200/],
  ['duplicate id', R({ checks: { allowlist: [{ id: 'x', cmd: 'grep' }, { id: 'x', cmd: 'diff' }] } }), /duplicate id "x"/],
  ['worker allow executes code', R({ worker: { bash: { allow: [{ id: 'n', cmd: 'node --test' }] } } }), /bash\.allow\[0\]\.cmd: node executes code/],
  ['worker allow not simple', R({ worker: { bash: { allow: [{ id: 'n', cmd: 'ls; ls' }] } } }), /exactly one simple command/],
  ['unsafe check command', R({ checks: { allowlist: [{ id: 'x', cmd: 'curl http://x' }] } }), /curl is not allowed as a check/],
  ['regex does not compile', R({ worker: { bash: { deny_patterns: [{ id: 'r', regex: '(' }] } } }), /does not compile/],
  ['regex nested quantifier', R({ worker: { bash: { deny_patterns: [{ id: 'r', regex: '(a+)+$' }] } } }), /nested quantifier/],
  ['regex too long', R({ worker: { bash: { deny_patterns: [{ id: 'r', regex: 'a'.repeat(201) }] } } }), /longer than 200/],
  ['absolute glob', R({ worker: { paths: { deny: [{ id: 'g', glob: '/etc/**' }] } } }), /must be relative or start with ~\//],
  ['tilde-user glob', R({ worker: { paths: { deny: [{ id: 'g', glob: '~root/**' }] } } }), /must be relative or start with ~\//],
  ['NUL in glob', R({ worker: { paths: { deny: [{ id: 'g', glob: 'a\0b' }] } } }), /control characters/],
  ['same_tier_retries value', R({ retry: { same_tier_retries: { denied: 9 } } }), /same_tier_retries\.denied: must be an integer 0-5/],
];
for (const [name, rules, re] of BAD) {
  test(`rules: validation error: ${name}`, () => {
    const v = validateRules(rules);
    assert.equal(v.ok, false); assert.ok(v.errors.some((e) => re.test(e)), `${re} not in ${JSON.stringify(v.errors)}`);
    const c = compileRules([{ layer: 'user', rules }]);
    assert.equal(c.ok, false); assert.ok(c.errors.every((e) => e.startsWith('user: ')));
  });
}

test('rules: governor is accepted in the user layer only (G5)', () => {
  assert.equal(compile('user', { governor: { reserve_5h: 0.5 } }).compiled.governor.reserve_5h, 0.5);
  for (const l of ['repo', 'goal']) { const c = compile(l, { governor: { reserve_5h: 0.5 } }); assert.equal(c.ok, false); assert.match(c.errors[0], /only the user layer may set the governor/); }
});

test('rules: deny lists only grow (union); entries are tagged with their layer', () => {
  const c = compile('repo', { worker: { paths: { deny: [{ id: 'lock', glob: '**/package-lock.json' }] }, bash: { deny: [{ id: 'x', cmd: 'mkfs' }] } }, plan: { scope_deny: [{ id: 'nm', glob: 'node_modules/**' }] } });
  assert.equal(c.loosenings.length + c.dropped.length, 0);
  assert.equal(c.compiled.worker.paths.deny.length, DEFAULT_RULES.worker.paths.deny.length + 1);
  assert.deepEqual(c.compiled.worker.paths.deny.at(-1), { id: 'lock', glob: '**/package-lock.json', layer: 'repo' });
  assert.ok(toPolicy(c.compiled).paths.deny.includes('**/package-lock.json'));
  assert.deepEqual(c.compiled.plan.scope_deny.map((e) => e.glob), ['node_modules/**']);
  // an empty deny list cannot remove anything
  const e = compile('user', { worker: { paths: { deny: [] }, bash: { deny: [], deny_patterns: [] } } });
  assert.deepEqual(toPolicy(e.compiled), DEFAULT_POLICY);
});

test('rules: allow lists intersect; an added entry is a loosening (applied for user/goal, dropped for repo)', () => {
  const t = compile('goal', { worker: { tools: { allow: ['Read', 'Grep'] }, bash: { allow: [{ id: 'ls', cmd: 'ls' }] } } });
  assert.deepEqual(t.compiled.worker.tools.allow, ['Read', 'Grep']); assert.deepEqual(t.compiled.worker.bash.allow.map((e) => e.cmd), ['ls']); assert.equal(t.loosenings.length, 0);
  const add = { checks: { allowlist: [{ id: 'node-test', cmd: 'node --test' }] } };
  const u = compile('user', add);
  assert.deepEqual(u.compiled.checks.allowlist.map((e) => e.cmd), ['node --test']);
  assert.deepEqual(u.loosenings, [{ layer: 'user', path: 'checks.allowlist', from: null, to: 'node --test', rule_id: 'user:checks.allowlist.node-test' }]);
  const gl = compile('goal', add); assert.equal(gl.loosenings[0].rule_id, 'goal:checks.allowlist.node-test');
  const r = compile('repo', add);
  assert.deepEqual(r.compiled.checks.allowlist, []); assert.equal(r.loosenings.length, 0); assert.equal(r.dropped[0].rule_id, 'repo:checks.allowlist.node-test');
  assert.equal(r.hash, compileRules([]).hash, 'a dropped loosening changes nothing');
  const acc = compile('repo', add, { accept: ['repo:checks.allowlist.node-test'] });
  assert.deepEqual(acc.compiled.checks.allowlist.map((e) => e.cmd), ['node --test']); assert.equal(acc.loosenings.length, 1); assert.equal(acc.dropped.length, 0);
  assert.notEqual(acc.hash, r.hash);
  const ports = compile('goal', { checks: { localhost_ports: [8080] } }); assert.deepEqual(ports.compiled.checks.localhost_ports, [8080]); assert.equal(ports.loosenings[0].rule_id, 'goal:checks.localhost_ports.8080');
  const ask = compile('repo', { worker: { bash: { ask_on: ['unparsed'] } } }); assert.deepEqual(ask.compiled.worker.bash.ask_on, ['unparsed']); assert.equal(ask.dropped.length, 0, 'fewer ask_on entries is a tightening');
});

test('rules: numeric caps take the min; a higher value is a loosening', () => {
  const lo = compile('repo', { budgets: { max_usd: 1, max_new_tokens: 300000 }, plan: { max_tasks: 8 }, retry: { max_attempts: 2 }, checks: { max_timeout_s: 600 } });
  assert.deepEqual([lo.compiled.budgets.max_usd, lo.compiled.budgets.max_new_tokens, lo.compiled.plan.max_tasks, lo.compiled.retry.max_attempts, lo.compiled.checks.max_timeout_s], [1, 300000, 8, 2, 600]);
  assert.equal(lo.loosenings.length + lo.dropped.length, 0);
  const hi = compile('repo', { budgets: { max_usd: 50 } }); assert.equal(hi.compiled.budgets.max_usd, 5); assert.equal(hi.dropped[0].rule_id, 'repo:budgets.max_usd');
  const g = compile('goal', { budgets: { max_new_tokens: 4000000 } }); assert.equal(g.compiled.budgets.max_new_tokens, 4000000);
  assert.deepEqual(g.loosenings, [{ layer: 'goal', path: 'budgets.max_new_tokens', from: 2000000, to: 4000000, rule_id: 'goal:budgets.max_new_tokens' }]);
  const st = compile('goal', { retry: { same_tier_retries: { denied: 0, other: 1 } } });
  assert.deepEqual(st.compiled.retry.same_tier_retries, { denied: 0, other: 1 }); assert.equal(st.loosenings[0].rule_id, 'goal:retry.same_tier_retries.other');
});

test('rules: ordered enums, safety booleans, ladder and pinned values', () => {
  assert.equal(compile('user', { worker: { paths: { on_outside_scope: 'deny' } } }).compiled.worker.paths.on_outside_scope, 'deny');
  assert.equal(compile('user', { worker: { paths: { on_outside_scope: 'deny' } } }).loosenings.length, 0);
  assert.equal(compile('goal', { plan: { approval: 'auto' } }).loosenings[0].rule_id, 'goal:plan.approval');
  assert.equal(compile('goal', { worker: { sandbox: 'required' } }).loosenings.length, 0);
  assert.equal(compile('goal', { repo_config: { trust: true } }).loosenings[0].rule_id, 'goal:repo_config.trust');
  assert.equal(compile('goal', { merge: { on_conflict: 'fail' } }).loosenings[0].rule_id, 'goal:merge.on_conflict');
  assert.deepEqual(compile('repo', { retry: { ladder: ['haiku', 'sonnet'] } }).compiled.retry.ladder, ['haiku', 'sonnet']);
  assert.deepEqual(compile('repo', { retry: { ladder: ['opus', 'haiku'] } }).compiled.retry.ladder, ['haiku', 'sonnet', 'opus'], 'reordering is not a subsequence: dropped');
  assert.equal(compile('goal', { plan: { max_start_tier: 'haiku' } }).loosenings.length, 0);
  // never from a repo, even with acceptance
  for (const [rules, id] of [[{ worker: { sandbox: 'off' } }, 'repo:worker.sandbox'], [{ checks: { sandbox: 'off' } }, 'repo:checks.sandbox'], [{ plan: { approval: 'auto' } }, 'repo:plan.approval'], [{ repo_config: { trust: true } }, 'repo:repo_config.trust']]) {
    // defaults: sandbox 'off' for workers equals the default so only the others differ; use accept for all
    const c = compile('repo', rules, { accept: [id] });
    if (id === 'repo:worker.sandbox') { assert.equal(c.dropped.length + c.loosenings.length, 0, 'same as default: no change'); continue; }
    assert.equal(c.loosenings.length, 0, id); assert.equal(c.dropped[0].rule_id, id);
  }
});

test('rules: layers apply in order and the loosening report lists every layer', () => {
  const c = compileRules([
    { layer: 'user', rules: R({ checks: { allowlist: [{ id: 'npm-test', cmd: 'npm test' }] } }), source: '/o/rules.json' },
    { layer: 'repo', rules: R({ checks: { allowlist: [{ id: 'npm-test', cmd: 'npm test' }, { id: 'extra', cmd: 'node --check' }] }, budgets: { max_usd: 2 } }) },
    { layer: 'goal', rules: R({ profile: 'node-library', budgets: { max_usd: 3 } }) },
  ]);
  assert.deepEqual(c.compiled.checks.allowlist.map((e) => `${e.layer}:${e.id}`), ['user:npm-test']);
  assert.deepEqual(c.dropped.map((d) => d.rule_id), ['repo:checks.allowlist.extra']);
  assert.equal(c.compiled.budgets.max_usd, 3, 'goal loosened the repo cap to 3 (<= default 5): applied, and 3 > 2 is listed');
  assert.deepEqual(c.loosenings.map((d) => d.rule_id), ['user:checks.allowlist.npm-test', 'goal:budgets.max_usd']);
  assert.equal(c.compiled.profile, 'node-library');
  assert.deepEqual(c.layers.map((l) => l.layer), ['default', 'user', 'repo', 'goal']); assert.equal(c.layers[1].source, '/o/rules.json');
  assert.equal(rulesHash(c.compiled), c.hash);
});

test('schema.mjs: additionalProperties:false, maxItems, maxLength and maximum are enforced', () => {
  const s = { type: 'object', additionalProperties: false, properties: { a: { type: 'array', maxItems: 1 }, b: { type: 'string', maxLength: 2 }, c: { type: 'number', maximum: 3 } } };
  assert.deepEqual(validateSchema({ a: [1], b: 'ab', c: 3 }, s), []);
  const e = validateSchema({ a: [1, 2], b: 'abc', c: 4, d: 1 }, s);
  assert.equal(e.length, 4); assert.ok(e.some((x) => /unknown key "d"/.test(x)));
});
