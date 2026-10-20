// R8 verification findings: linear glob matching (N1), terminal-safe plan strings (N2), glob validation / never-throw (S3a, S3b), sampler (S4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, DEFAULT_POLICY, isProtectedRel } from '../lib/policy.mjs';
import { matchGlob, matchAny, scopeHitsDeny, compileGlob, MAX_MATCH_LEN } from '../lib/glob.mjs';
import { validatePlan, validateScope, renderReview, reviewView } from '../lib/plan.mjs';
import { validateRules, CTRL_RE, escCtrl } from '../lib/rules.mjs';
import { ptask } from './helpers.mjs';

const timed = (f) => { const t = performance.now(); const r = f(); return [r, performance.now() - t]; };
const polWith = (deny) => ({ ...DEFAULT_POLICY, paths: { ...DEFAULT_POLICY.paths, deny: [...DEFAULT_POLICY.paths.deny, ...deny] } });
const ctx = { worktree: '/w', path_scope: ['**'], allowed_tools: ['Write'], grants: [] };
const W = (pol, f) => evaluate(pol, { tool_name: 'Write', tool_input: { file_path: f }, cwd: '/w' }, ctx);

test('N1: ReDoS probes finish in milliseconds', () => {
  let [r, ms] = timed(() => W(polWith(['**a**a**a**a**a**a**a**b']), `/w/${'a'.repeat(60)}`));
  assert.equal(r.decision, 'allow'); assert.ok(ms < 50, `deny glob 1: ${ms} ms`);
  [r, ms] = timed(() => W(polWith(['*a*a*a*a*a*b']), `/w/${'a'.repeat(120)}`));
  assert.equal(r.decision, 'allow'); assert.ok(ms < 50, `deny glob 2: ${ms} ms`);
  [r, ms] = timed(() => matchGlob('*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(40)));
  assert.equal(r, false); assert.ok(ms < 50, `scope: ${ms} ms`);
  [r, ms] = timed(() => W(polWith(['*a*a*a*a*a*b']), `/w/${'a'.repeat(120)}b`));
  assert.equal(r.decision, 'deny'); assert.ok(ms < 50);
  [r, ms] = timed(() => isProtectedRel(polWith(['**a**a**a**a**a**a**a**b']), 'a'.repeat(4000)));
  assert.equal(r, false); assert.ok(ms < 200, `isProtectedRel ${ms} ms`);
});

test('N1: semantics of the linear matcher (anchoring, ** crossing slashes, classes, braces, case)', () => {
  const m = (g, s) => matchGlob(g, s);
  assert.ok(m('src/**', 'src/a/b.js')); assert.ok(m('**/*.md', 'c.md')); assert.ok(m('**/*.md', 'a/b/c.md')); assert.ok(!m('*.js', 'a/b.js'));
  assert.ok(m('a/**/b', 'a/b')); assert.ok(m('a/**/b', 'a/x/y/b')); assert.ok(!m('a/**/b', 'a/xb'));
  assert.ok(m('a**b', 'a/x/b')); assert.ok(!m('a*b', 'a/b')); assert.ok(m('?.js', 'a.js')); assert.ok(!m('?.js', '/.js'));
  assert.ok(m('[a-c].js', 'b.js')); assert.ok(!m('[a-c].js', 'd.js')); assert.ok(m('[!a].js', 'b.js')); assert.ok(!m('[!a].js', '/.js'));
  assert.ok(m('{a,b{c,d}}/x', 'bd/x')); assert.ok(m('a{b', 'a{b')); assert.ok(m('a[b', 'a[b'));
  assert.ok(!m('src/*.js', 'src/a.jsx'));
  assert.equal(compileGlob('x{a,b}{c,d}').test('xbd'), true);
});

test('N1: path length cap fails closed for deny globs and open for scopes', () => {
  const long = `/w/${'a/'.repeat(MAX_MATCH_LEN)}x`;
  const r = W(DEFAULT_POLICY, long); assert.equal(r.decision, 'deny'); assert.equal(r.rule_id, 'floor:path_too_long');
  assert.equal(matchGlob('**', 'a'.repeat(MAX_MATCH_LEN + 1)), false); assert.equal(matchGlob('**', 'a'.repeat(MAX_MATCH_LEN + 1), true), true);
  assert.equal(isProtectedRel(DEFAULT_POLICY, `${'a'.repeat(MAX_MATCH_LEN + 1)}`), true);
});

test('N1: wildcard and brace caps at validation (rules and plan)', () => {
  const g = '*a'.repeat(9);
  assert.equal(validateRules({ version: 1, worker: { paths: { deny: [{ id: 'x', glob: g }] } } }).ok, false);
  assert.match(validateScope(g), /wildcards/);
  assert.equal(validateScope('{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}/x') === null, false, 'brace explosion refused');
  assert.equal(validateScope('src/**/*.js'), null);
});

test('S3a: invalid ranges are refused at validation, and matching never throws (fails closed)', () => {
  assert.match(validateScope('src/[z-a].js'), /does not compile/);
  assert.equal(validateRules({ version: 1, worker: { paths: { deny: [{ id: 'x', glob: '[z-a]' }] } } }).ok, false);
  assert.equal(validateRules({ version: 1, plan: { scope_deny: [{ id: 'x', glob: 'a/[z-a]' }] } }).ok, false);
  assert.equal(validateRules({ version: 1, worker: { paths: { read_extra: [{ id: 'x', glob: '~/[z-a]' }] } } }).ok, false);
  const pol = polWith(['[z-a].txt']);
  assert.doesNotThrow(() => isProtectedRel(pol, 'b.txt')); assert.equal(isProtectedRel(pol, 'b.txt'), true, 'broken deny glob protects');
  assert.doesNotThrow(() => matchAny(['[z-a]'], 'a')); assert.equal(matchAny(['[z-a]'], 'a'), false, 'broken scope glob matches nothing');
  assert.doesNotThrow(() => scopeHitsDeny('a/*', '[z-a]'));
  assert.equal(W(pol, '/w/b.txt').decision, 'deny');
});

test('S3b: isProtectedRel handles ** globs without a slash', () => {
  const pol = polWith(['**.pem']);
  assert.equal(isProtectedRel(pol, 'k.pem'), true); assert.equal(isProtectedRel(pol, 'a/b/k.pem'), true); assert.equal(isProtectedRel(pol, 'a/k.txt'), false);
});

test('S4: scope sampler handles [!a], interior range characters and range scopes', () => {
  assert.equal(scopeHitsDeny('src/[!a]/x.txt', 'src/b/**'), true);
  assert.equal(scopeHitsDeny('src/[!a]/x.txt', 'src/a/**'), false);
  assert.equal(scopeHitsDeny('src/[a-c]/**', 'src/b/**'), true);
  assert.equal(scopeHitsDeny('src/[a-c]/**', 'src/d/**'), false);
  assert.equal(scopeHitsDeny('src/[a-e]/x.txt', 'src/c/**'), true, 'interior char');
});

const ESC = '\u001b[2K\r';
const vp = (over) => validatePlan({ tasks: [{ ...ptask('t1', 'a.txt', 'alpha'), ...over }] }, { check_allowlist: ['grep', 'node'], max_tasks: 5 });
test('N2: control, C1, bidi, zero-width and tag characters are refused in every plan string', () => {
  const bads = ['\u001b[2J', '\u009b2J', 'a‮b', 'a‎b', 'a؜b', 'a​b', 'a⁠b', 'a﻿b', 'a b', 'a\u{e0041}b', 'a\rb'];
  for (const b of bads) {
    for (const over of [{ title: `T${b}` }, { path_scope: [`a.txt${b}`] }, { allowed_commands: [`grep x ${b}a.txt`] }, { acceptance: [`ok${b}`] }, { output_contract: `x${b}` }, { description: `x${b}` },
      { checks: [{ argv: ['grep', 'x', `f${b}`], timeout_s: 5 }] }]) {
      const r = vp(over);
      assert.equal(r.ok, false, JSON.stringify(over)); assert.ok(!CTRL_RE.test(r.errors.join('\n')), 'error text is escaped');
    }
  }
  assert.equal(vp({ path_scope: [`a.txt${ESC}`] }).ok, false);
  assert.equal(vp({ allowed_commands: ['grep \u001b[2J\u001b[H\rAPPROVED a.txt'] }).ok, false);
  assert.equal(vp({ description: 'two\nlines\tok' }).ok, true, 'a description may span lines');
  assert.equal(vp({}).ok, true);
});

test('N2: renderReview and escCtrl escape everything that could rewrite the screen', () => {
  const view = reviewView([{ id: 't1', depends_on: ['x\u009b'], orch: { model_tier: 'haiku', path_scope: ['a.txt\u001b[2K\r'], allowed_commands: ['grep ‮ x'], checks: [{ argv: ['grep', 'a‎b\u{e0041}'], timeout_s: 5 }] } }]);
  const out = renderReview(view, 'rules\nline2');
  assert.ok(!CTRL_RE.test(out.replace(/\n/g, '')), 'no raw control character survives'); assert.match(out, /\\u001b\[2K\\u000d/); assert.match(out, /\\u202e/); assert.match(out, /\\u\{e0041\}/);
  assert.equal(out.split('\n').length, 5, 'only the real line breaks remain');
  assert.equal(escCtrl('a‏b '), 'a\\u200fb\\u2029');
});
