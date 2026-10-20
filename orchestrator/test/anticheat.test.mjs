// Anti-cheat layer (lib/anticheat.mjs): every rule is shown against a CHEATING worker played by fake-claude, followed (where useful) by an honest second attempt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkSandbox, drive, goalOf, tasksOf, crit, allowAllHook, git } from './helpers.mjs';
import { readEvents, paths } from '../lib/state.mjs';
import { reviewView, renderReview, validatePlan } from '../lib/plan.mjs';
import { buildReviewPrompt } from '../lib/review.mjs';
import { compileRules } from '../lib/rules.mjs';
import { PROFILES } from '../lib/profiles.mjs';
import * as A from '../lib/anticheat.mjs';

const onePlan = (...tasks) => ({ tasks, risks: [] });
const NT = (...files) => ({ argv: ['node', '--test', ...files], timeout_s: 60 });
const T = (id, { scope, checks, deps = [], ...extra }) => ({ id, title: id, description: `do ${id}`, depends_on: deps, model_tier: 'haiku', path_scope: scope, allowed_commands: [], checks, output_contract: id, acceptance: [id], ...extra });
const HEAD = "import test from 'node:test';import assert from 'node:assert/strict';\n";
const REAL_TEST = `${HEAD}test('adds', () => assert.equal(1 + 1, 2));\n`;
const THREE = `${HEAD}test('a', () => assert.ok(true));\ntest('b', () => assert.ok(true));\ntest('c', () => assert.ok(true));\n`;
const rules = (checks = {}) => ({ orch: { rules: { rules_version: 1, checks } } });
const commit = (sb, files) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(sb.repo, f)), { recursive: true }); fs.writeFileSync(path.join(sb.repo, f), c); } git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-q', '-m', 'base'); };
const step = (edits, extra = {}) => ({ behavior: 'success', edits: edits.map(([p, content]) => ({ path: p, content })), ...extra });
const B = (w = 'beta') => ['b.txt', `${w}\n`];
const log = (dir, id = 't1') => tasksOf(dir).find((t) => t.id === id).orch.attempt_log;
const ev = (dir, type) => readEvents(dir).filter((e) => e.type === type);
const kinds = (dir) => ev(dir, 'orch.anticheat.failed').map((e) => e.data.kind);
const ONE = { orch: { budgets: { max_attempts: 1 } } };
const merge = (...o) => o.reduce((a, b) => ({ ...a, ...b, orch: { ...(a.orch || {}), ...(b.orch || {}), budgets: { ...(a.orch?.budgets || {}), ...(b.orch?.budgets || {}) } } }), {});

// ---------------------------------------------------------------- units
test('anticheat: node:test summaries (TAP and spec) are parsed; file-only entries are not tests; the runner\'s own LAST summary wins over spoofed lines', () => {
  const tap = '# Subtest: a\nok 1 - a\n# tests 5\n# suites 0\n# pass 1\n# fail 1\n# cancelled 0\n# skipped 2\n# todo 1\n# duration_ms 7\n';
  assert.deepEqual(A.parseTestSummary(tap), { tests: 5, pass: 1, fail: 1, cancelled: 0, skipped: 2, todo: 1 });
  assert.deepEqual(A.parseTestSummary('ℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n'), { tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(A.parseTestSummary('all good\n'), null);
  // a test file that declares nothing is reported by node as one passing "test" named after the file
  const empty = 'TAP version 13\n# Subtest: e.test.mjs\nok 1 - e.test.mjs\n  ---\n  type: \'test\'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(A.parseTestSummary(empty).tests, 0); assert.equal(A.parseTestSummary(empty).pass, 0);
  assert.equal(A.parseTestSummary('✔ e.test.mjs (50ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0\n').tests, 0);
  assert.equal(A.parseTestSummary('# tests 99\n# pass 99\n# fail 0\n# Subtest: real\nok 1 - real\n# tests 1\n# pass 1\n# fail 0\n').tests, 1, 'spoofed earlier summary lines do not count');
});

test('anticheat: node --test checks are run with the TAP reporter (argv rewritten for execution only); judgeRun refuses 0 / all-skipped / fewer-than-base', () => {
  assert.deepEqual(A.forceTapArgv(['node', '--test', 'test/a.mjs']), ['node', '--test', '--test-reporter=tap', 'test/a.mjs']);
  assert.deepEqual(A.forceTapArgv(['node', '--test', '--test-reporter=spec', 'a']), ['node', '--test', '--test-reporter=spec', 'a']);
  assert.deepEqual(A.forceTapArgv(['npm', 'test']), ['npm', 'test']);
  const nt = ['node', '--test', 'x'];
  const s = (o) => ({ tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...o });
  assert.equal(A.judgeRun(nt, s({}), null).ok, true);
  assert.equal(A.judgeRun(nt, s({ tests: 0, pass: 0 }), null).kind, 'vacuous_pass');
  assert.match(A.judgeRun(nt, s({ tests: 3, pass: 0, skipped: 2, todo: 1 }), null).reason, /no test actually passed/);
  assert.equal(A.judgeRun(nt, s({ tests: 2, pass: 2 }), { tests: 3, source: 'run' }).kind, 'tests_reduced');
  assert.equal(A.judgeRun(nt, s({ tests: 3 }), { tests: 3 }).ok, true);
  assert.equal(A.judgeRun(nt, null, null).kind, 'vacuous_pass', 'node --test without a summary cannot be counted');
  assert.deepEqual(A.judgeRun(['make', 'test'], null, null), { ok: true, applicable: false });
  assert.equal(A.staticTestCount(['node', '--test'], [{ path: 'test/x.test.mjs', text: "test('a',()=>{});it('b',()=>{});test.skip('c',()=>{})" }, { path: 'src/a.mjs', text: "test('no')" }]), 3);
});

test('anticheat: skip patterns on added test lines; plain data named todo/skip is not a skip', () => {
  const hit = (l) => A.skipHits([l]).length > 0;
  for (const l of ["it.skip('x', () => {})", "describe.skip('x', () => {})", "test.only('x', f)", "test.todo('later')", "test('x', { skip: true }, () => {})", "test('x', { concurrency: 1, todo: 'wip' }, f)", "xit('x', f)", "xdescribe('x', f)", "  t.skip('no');", '  skip: true,', '@pytest.mark.skip', 'func T(t *testing.T) { t.Skip("x") }']) assert.equal(hit(l), true, l);
  for (const l of ["const item = { todo: 'buy milk' };", "assert.deepEqual(list, [{ skip: 2 }]);", "cursor.skip(10)", "test('normal', () => {})"]) assert.equal(hit(l), false, l);
});

test('anticheat: diff parsing (add / modify / delete / rename), package.json config keys, check input files, literal copies', async () => {
  const diff = [
    'diff --git a/test/old.test.mjs b/test/old.test.mjs', 'deleted file mode 100644', 'index 1..0', '--- a/test/old.test.mjs', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b',
    'diff --git a/test/x.test.mjs b/test/y.test.mjs', 'similarity index 100%', 'rename from test/x.test.mjs', 'rename to test/y.test.mjs',
    'diff --git a/src/s.mjs b/src/s.mjs', 'new file mode 100644', '--- /dev/null', '+++ b/src/s.mjs', '@@ -0,0 +1,2 @@', "+export const s = (x) => {", "+  if (x === 'Hello World!') return 'hello-world';"].join('\n');
  const f = A.parseDiff(diff);
  assert.deepEqual(f.map((x) => [x.status, x.path, x.from]), [['D', 'test/old.test.mjs', 'test/old.test.mjs'], ['R', 'test/y.test.mjs', 'test/x.test.mjs'], ['A', 'src/s.mjs', 'src/s.mjs']]);
  assert.equal(f[2].added.length, 2);
  assert.deepEqual(A.packageConfigChanged('{"scripts":{"test":"node --test"},"name":"a"}', '{"name":"b","scripts":{"test":"node --test"}}'), []);
  assert.deepEqual(A.packageConfigChanged('{"scripts":{"test":"node --test"}}', '{"scripts":{"test":"true"}}'), ['scripts']);
  assert.deepEqual(A.packageConfigChanged(null, '{"scripts":{"test":"true"}}'), ['scripts']);
  assert.deepEqual(A.checkInputPaths([['node', 'scripts/verify.mjs', '--x'], ['make', 'test'], ['node', '--test', 'test/a.test.mjs']]).sort(), ['GNUmakefile', 'Makefile', 'makefile', 'scripts/verify.mjs']);
  assert.equal(A.isConfigPath('package.json') && A.isConfigPath('sub/.mocharc.yml') && A.isConfigPath('jest.config.cjs') && A.isConfigPath('.c8rc.json') && A.isConfigPath('.npmrc') && A.isConfigPath('vitest.config.ts'), true);
  const lits = A.expectedLiterals([{ path: 'test/s.test.mjs', text: "import { s } from '../src/s.mjs';\nassert.equal(s('Hello World!'), 'hello-world');\nassert.equal(total(), 1250);\n" }]);
  assert.deepEqual(lits.strs.sort(), ['Hello World!', 'hello-world']); assert.deepEqual(lits.nums, ['1250']);
  const copies = A.literalCopies(f, lits);
  assert.equal(copies.length, 1); assert.equal(copies[0].literal, 'Hello World!');
  assert.equal(A.literalCopies([{ path: 'src/t.mjs', status: 'A', removed: [], added: ['// Hello World! is the example'] }], lits).length, 0, 'comments are ignored');
  assert.equal(A.literalCopies([{ path: 'src/t.mjs', status: 'M', removed: ["const h = 'Hello World!';"], added: ["if (x === 'Hello World!') go();"] }], lits).length, 0, 'a literal that was already in the file is not new');
});

test('anticheat: an acceptance test that another task changes (even under a grant) is acceptance_modified; named config files are "allowed", not failed', async () => {
  const io = { before: async () => '{"scripts":{"test":"a"}}', after: async () => '{"scripts":{"test":"b"}}', tests: async () => [] };
  const files = [{ path: 'test/accept.test.mjs', from: 'test/accept.test.mjs', status: 'M', added: ['x'], removed: [] }, { path: 'package.json', from: 'package.json', status: 'M', added: [], removed: [] }];
  const r = await A.analyzeDiff(files, { path_scope: ['package.json'], checks: [], acceptance: { files: ['test/accept.test.mjs'], scopes: ['test/accept.test.mjs'] } }, io);
  assert.deepEqual(r.findings.map((f) => `${f.kind}:${f.severity}`).sort(), ['acceptance_modified:fail', 'check_config_changed:allowed']);
  const r2 = await A.analyzeDiff(files.slice(1), { path_scope: ['*.json'], checks: [] }, io);
  assert.equal(r2.findings[0].severity, 'fail', 'a glob is not an explicit mention');
});

// ---------------------------------------------------------------- (a) vacuous passes
test('a) vacuous: a test file with no tests passes node --test (exit 0) but is refused (vacuous_pass); the honest retry passes; outcome is in attempt, events, status and report.md', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [step([B(), ['test/new.test.mjs', HEAD]]), step([B(), ['test/new.test.mjs', REAL_TEST]])] } });
  const { dir } = await sb.goal({ success_criteria: [crit('b.txt', 'beta')], plan: onePlan(T('t1', { scope: ['b.txt', 'test/new.test.mjs'], checks: [NT('test/new.test.mjs')] })) });
  const eng = sb.engine(dir); await drive(eng);
  const g = goalOf(dir); assert.equal(g.status, 'achieved');
  const L = log(dir); assert.equal(L[0].outcome, 'vacuous_pass'); assert.equal(L[0].anticheat.status, 'fail'); assert.equal(L[0].anticheat.failed, 'vacuous_pass');
  assert.equal(L[1].outcome, 'success'); assert.equal(L[1].anticheat.status, 'pass'); assert.equal(L[1].anticheat.tests[0].tests, 1);
  assert.deepEqual(kinds(dir), ['vacuous_pass']); assert.equal(ev(dir, 'orch.anticheat.passed').length, 1);
  assert.match(tasksOf(dir)[0].orch.last_failure.note, /ran 0 tests/);
  assert.equal(g.orch.anticheat.baselines['node --test test/new.test.mjs'].source, 'static', 'the check could not run at base (no such file): static fallback');
  assert.equal(eng.summary().anticheat.failures.vacuous_pass, 1);
  const rep = fs.readFileSync(paths(dir).report, 'utf8');
  assert.match(rep, /## Anti-cheat/); assert.match(rep, /\*\*FAILED\*\* t1#1: vacuous_pass/);
});

test('a) vacuous: every test skipped is a failed check even when the plan approved allow_skip; the approval screen shows ALLOW_SKIP', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [step([B(), ['test/new.test.mjs', `${HEAD}test('later', { skip: true }, () => {});\n`]])] } });
  const { dir } = await sb.goal(merge({ success_criteria: [crit('b.txt', 'beta')], plan: onePlan(T('t1', { scope: ['b.txt', 'test/new.test.mjs'], checks: [NT('test/new.test.mjs')], allow_skip: ['legacy test is flaky on CI'] })) }, ONE));
  await drive(sb.engine(dir));
  assert.equal(goalOf(dir).status, 'blocked');
  assert.equal(log(dir)[0].outcome, 'vacuous_pass'); assert.match(log(dir)[0].anticheat.failed, /vacuous_pass/);
  assert.ok(log(dir)[0].anticheat.findings.some((f) => f.kind === 'tests_skipped' && f.severity === 'allowed'));
  assert.match(goalOf(dir).orch.plan_warnings.t1.join('\n'), /ALLOW_SKIP.*flaky on CI/);
  assert.match(renderReview(reviewView(tasksOf(dir), goalOf(dir))), /!! ALLOW_SKIP: .*flaky on CI/);
});

test('a) vacuous: fewer tests than the base commit (3 -> 1, no skip, no delete) is tests_reduced; the baseline was recorded by RUNNING the check on the base commit', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); commit(sb, { 'test/base.test.mjs': THREE });
  sb.scenario({ tasks: { t1: [step([B(), ['test/base.test.mjs', REAL_TEST]]), step([B(), ['test/base.test.mjs', THREE], ['test/more.test.mjs', REAL_TEST]])] } });
  const { dir } = await sb.goal({ success_criteria: [crit('b.txt', 'beta')], plan: onePlan(T('t1', { scope: ['b.txt', 'test/*.test.mjs'], checks: [NT('test/*.test.mjs')] })) });
  await drive(sb.engine(dir));
  const g = goalOf(dir); assert.equal(g.status, 'achieved');
  assert.deepEqual(g.orch.anticheat.baselines['node --test test/*.test.mjs'].source, 'run'); assert.equal(g.orch.anticheat.baselines['node --test test/*.test.mjs'].tests, 3);
  assert.equal(log(dir)[0].outcome, 'tests_reduced'); assert.match(tasksOf(dir)[0].orch.last_failure.note, /fewer than the 3 on the base commit/);
  assert.equal(log(dir)[1].anticheat.tests[0].tests, 4);
});

test('a) vacuous: a success criterion that passes by running no test is not met (blocked, recorded under anticheat.criteria)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); commit(sb, { 'test/empty.test.mjs': HEAD });
  sb.scenario({ tasks: { t1: [step([B()])] } });
  const { dir } = await sb.goal({ success_criteria: [{ id: 'c1', text: 'tests pass', check: NT('test/empty.test.mjs') }], plan: onePlan(T('t1', { scope: ['b.txt'], checks: [{ argv: ['grep', '-qx', 'beta', 'b.txt'], timeout_s: 30 }] })) });
  await drive(sb.engine(dir));
  const g = goalOf(dir); assert.equal(g.status, 'blocked'); assert.match(g.blocked_reason, /criteria not met: c1/);
  assert.equal(g.orch.anticheat.criteria.c1.kind, 'vacuous_pass');
  assert.match(fs.readFileSync(paths(dir).report, 'utf8'), /\*\*FAILED\*\* criterion c1: vacuous_pass/);
});

// ---------------------------------------------------------------- (b) skips
test('b) skips: adding it.skip to a test file fails the attempt with tests_skipped; the honest retry passes', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const cheat = `${HEAD}import { it } from 'node:test';\ntest('adds', () => assert.equal(1 + 1, 2));\nit.skip('hard case', () => assert.equal(1, 2));\n`;
  sb.scenario({ tasks: { t1: [step([B(), ['test/new.test.mjs', cheat]]), step([B(), ['test/new.test.mjs', REAL_TEST]])] } });
  const { dir } = await sb.goal({ success_criteria: [crit('b.txt', 'beta')], plan: onePlan(T('t1', { scope: ['b.txt', 'test/new.test.mjs'], checks: [NT('test/new.test.mjs')] })) });
  await drive(sb.engine(dir));
  assert.equal(goalOf(dir).status, 'achieved'); assert.equal(log(dir)[0].outcome, 'tests_skipped');
  assert.match(tasksOf(dir)[0].orch.last_failure.note, /tests_skipped test\/new\.test\.mjs/); assert.deepEqual(kinds(dir), ['tests_skipped']);
});

test('b) skips: allow_skip (shown at approval) lets a task add a skip, recorded as allowed in the attempt and the report', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const src = `${HEAD}test('adds', () => assert.equal(1 + 1, 2));\ntest('windows only', { skip: 'needs windows' }, () => {});\n`;
  sb.scenario({ tasks: { t1: [step([B(), ['test/new.test.mjs', src]])] } });
  const { dir } = await sb.goal({ success_criteria: [crit('b.txt', 'beta')], plan: onePlan(T('t1', { scope: ['b.txt', 'test/new.test.mjs'], checks: [NT('test/new.test.mjs')], allow_skip: ['needs windows'] })) });
  await drive(sb.engine(dir));
  assert.equal(goalOf(dir).status, 'achieved'); assert.equal(log(dir)[0].anticheat.status, 'warn');
  assert.ok(ev(dir, 'orch.anticheat.warning').length >= 1);
  assert.match(fs.readFileSync(paths(dir).report, 'utf8'), /allowed by the approved plan, t1#1: tests_skipped/);
});

// ---------------------------------------------------------------- (c) config tamper
const PKG = '{\n  "name": "p",\n  "scripts": { "test": "node --test" }\n}\n';
test('c) config: rewriting package.json scripts.test (scope *.json) fails with check_config_changed; reverting passes', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); commit(sb, { 'package.json': PKG, 'test/base.test.mjs': THREE });
  sb.scenario({ tasks: { t1: [step([B(), ['package.json', '{"name":"p","scripts":{"test":"true"}}\n']]), step([B(), ['package.json', PKG]])] } });
  const { dir } = await sb.goal({ success_criteria: [crit('b.txt', 'beta')], plan: onePlan(T('t1', { scope: ['b.txt', '*.json'], checks: [NT('test/base.test.mjs')] })) });
  await drive(sb.engine(dir));
  assert.equal(goalOf(dir).status, 'achieved'); assert.equal(log(dir)[0].outcome, 'check_config_changed');
  assert.match(log(dir)[0].anticheat.findings[0].detail, /package\.json scripts changed.*not named in path_scope/);
});

test('c) config: a runner config (.mocharc.json) and the script a check runs (scripts/verify.mjs) are also protected', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); commit(sb, { 'scripts/verify.mjs': "process.exit(0);\n", '.mocharc.json': '{"spec":["a"]}\n', 'test/base.test.mjs': THREE });
  sb.scenario({ tasks: { t1: [step([B(), ['.mocharc.json', '{"spec":[]}\n']]), step([B(), ['.mocharc.json', '{"spec":["a"]}\n'], ['scripts/verify.mjs', 'process.exit(0); // weaker\n']]), step([B(), ['scripts/verify.mjs', 'process.exit(0);\n']])] } });
  const { dir } = await sb.goal({ success_criteria: [crit('b.txt', 'beta')], plan: onePlan(T('t1', { scope: ['b.txt', '.*.json', 'scripts/*.mjs'], checks: [{ argv: ['node', 'scripts/verify.mjs'], timeout_s: 30 }] })) });
  await drive(sb.engine(dir));
  assert.deepEqual(log(dir).map((a) => a.outcome), ['check_config_changed', 'check_config_changed', 'success']);
  assert.match(log(dir)[0].anticheat.findings[0].detail, /test runner configuration changed/); assert.match(log(dir)[1].anticheat.findings[0].detail, /a file the check command runs or reads changed/);
});

test('c) config: naming package.json in path_scope lifts the rule for that file only, and the approval screen highlights it', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); commit(sb, { 'package.json': PKG, 'test/base.test.mjs': THREE });
  sb.scenario({ tasks: { t1: [step([B(), ['package.json', '{"name":"p","scripts":{"test":"node --test","lint":"x"}}\n']])] } });
  const { dir } = await sb.goal({ success_criteria: [crit('b.txt', 'beta')], plan: onePlan(T('t1', { scope: ['b.txt', 'package.json'], checks: [NT('test/base.test.mjs')] })) });
  await drive(sb.engine(dir));
  assert.equal(goalOf(dir).status, 'achieved'); assert.equal(log(dir)[0].anticheat.findings[0].severity, 'allowed');
  assert.match(goalOf(dir).orch.plan_warnings.t1[0], /CONFIG FILE IN SCOPE: package\.json/);
  assert.match(renderReview(reviewView(tasksOf(dir), goalOf(dir))), /!! WARNING \(task t1\): CONFIG FILE IN SCOPE: package\.json/);
});

// ---------------------------------------------------------------- (d) deleted / renamed tests
for (const [name, cmd, what] of [['deleted', 'rm test/old.test.mjs', /test file deleted/], ['renamed', 'mv test/old.test.mjs test/moved.test.mjs', /test file renamed to test\/moved\.test\.mjs/]]) {
  test(`d) tests: a ${name} test file fails with tests_deleted (no protect_existing_tests needed); restoring it passes`, async (t) => {
    const sb = mkSandbox(); t.after(() => sb.cleanup()); commit(sb, { 'test/old.test.mjs': THREE, 'test/keep.test.mjs': REAL_TEST });
    sb.scenario({ tasks: { t1: [{ ...step([B()]), commands: [{ command: cmd, run: true }] }, step([B(), ['test/old.test.mjs', THREE]])] } });
    const { dir } = await sb.goal({ success_criteria: [crit('b.txt', 'beta')], plan: onePlan(T('t1', { scope: ['b.txt', 'test/*.mjs'], checks: [NT('test/keep.test.mjs')] })) });
    await drive(sb.engine(dir, { hookScript: allowAllHook(sb.root) }));
    assert.equal(log(dir)[0].outcome, 'tests_deleted'); assert.match(log(dir)[0].anticheat.findings[0].detail, what);
    assert.equal(goalOf(dir).status, 'achieved');
  });
}

// ---------------------------------------------------------------- (e) acceptance tests first
const ACCEPT = `${HEAD}import { add } from '../src/calc.mjs';\ntest('adds 2+3', () => assert.equal(add(2, 3), 5));\ntest('adds 10+20', () => assert.equal(add(10, 20), 30));\n`;
const accTask = (extra = {}) => T('acc', { scope: ['test/accept.test.mjs'], checks: [{ argv: ['node', '--check', 'test/accept.test.mjs'], timeout_s: 30 }], role: 'acceptance', ...extra });
const implTask = (extra = {}) => T('impl', { scope: ['src/calc.mjs'], deps: ['acc'], checks: [{ argv: ['grep', '-q', 'add', 'src/calc.mjs'], timeout_s: 30 }], ...extra });
const ACC = merge(rules({ acceptance_first: true }), { success_criteria: [{ id: 'c1', text: 'calc has add', check: { argv: ['grep', '-q', 'add', 'src/calc.mjs'], timeout_s: 30 } }] });

test('e) acceptance: an implementation that hard-codes the answer passes its own weak check but fails the acceptance tests re-run at verify (goal blocked)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { acc: [step([['test/accept.test.mjs', ACCEPT]])], impl: [step([['src/calc.mjs', 'export const add = () => 5;\n']])] } });
  const { dir } = await sb.goal({ ...ACC, plan: onePlan(accTask(), implTask()) });
  const eng = sb.engine(dir); await drive(eng);
  const g = goalOf(dir); assert.equal(g.status, 'blocked'); assert.match(g.blocked_reason, /ACCEPTANCE tests .* fail against the integration branch/);
  assert.equal(g.orch.anticheat.acceptance_result.ok, false); assert.deepEqual(g.orch.anticheat.acceptance.items[0].files, ['test/accept.test.mjs']);
  assert.ok(tasksOf(dir).every((x) => x.status === 'done'));
  assert.equal(eng.summary().anticheat.acceptance.result.ok, false);
  assert.match(fs.readFileSync(paths(dir).report, 'utf8'), /acceptance tests .*re-run: \*\*FAILED\*\*/);
  assert.ok(ev(dir, 'orch.anticheat.acceptance').length >= 2);
  assert.match(renderReview(reviewView(tasksOf(dir), g)), /ACCEPTANCE TASK/);
});

test('e) acceptance: the honest implementation is achieved; the acceptance tests ran from their committed version (2 tests)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { acc: [step([['test/accept.test.mjs', ACCEPT]])], impl: [step([['src/calc.mjs', 'export const add = (a, b) => a + b;\n']])] } });
  const { dir } = await sb.goal({ ...ACC, plan: onePlan(accTask(), implTask()) });
  await drive(sb.engine(dir));
  const g = goalOf(dir); assert.equal(g.status, 'achieved'); assert.equal(g.orch.anticheat.acceptance_result.ok, true); assert.equal(g.orch.anticheat.acceptance_result.tests, 2);
});

test('e) acceptance: an implementation task that writes the acceptance file is stopped (scope), and a plan that lets it is rejected by validatePlan', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { acc: [step([['test/accept.test.mjs', ACCEPT]])], impl: [step([['src/calc.mjs', 'export const add = () => 5;\n'], ['test/accept.test.mjs', `${HEAD}test('x', () => {});\n`]])] } });
  const { dir } = await sb.goal(merge({ ...ACC, plan: onePlan(accTask(), implTask()) }, ONE, { orch: { rules: { rules_version: 1, checks: { acceptance_first: true }, worker: { paths: { on_outside_scope: 'deny' } } } } }));
  await drive(sb.engine(dir));
  assert.ok(['denied', 'scope_violation'].includes(log(dir, 'impl')[0].outcome), log(dir, 'impl')[0].outcome); assert.equal(goalOf(dir).status, 'blocked');
  const opts = { max_tasks: 8, check_allowlist: ['node', 'grep'], acceptance_first: true };
  const bad = (plan, re) => { const v = validatePlan(plan, opts); assert.equal(v.ok, false); assert.match(v.errors.join('\n'), re); };
  assert.equal(validatePlan(onePlan(accTask(), implTask()), opts).ok, true);
  bad(onePlan(implTask({ deps: [] })), /needs at least one task with "role":"acceptance"/);
  bad(onePlan(accTask(), implTask({ deps: [] })), /must depend on an acceptance task/);
  bad(onePlan(accTask(), implTask({ scope: ['src/calc.mjs', 'test/*.test.mjs'] })), /can reach the acceptance tests of acc/);
  bad(onePlan(accTask({ path_scope: ['src/calc.mjs'] }), implTask()), /may only write test files/);
  bad(onePlan(accTask({ role: 'oracle' }), implTask()), /role must be/);
  bad(onePlan(accTask(), implTask({ allow_skip: [''] })), /allow_skip must be/);
});

test('e) acceptance: with checks.acceptance_first a supplied plan without an acceptance task is rejected; an acceptance task that adds no test is acceptance_empty', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const { dir } = await sb.goal({ ...ACC, plan: onePlan(implTask({ deps: [] })) });
  await drive(sb.engine(dir));
  assert.equal(goalOf(dir).status, 'blocked'); assert.match(goalOf(dir).blocked_reason, /plan rejected: .*role":"acceptance"/);
  const sb2 = mkSandbox(); t.after(() => sb2.cleanup());
  sb2.scenario({ tasks: { acc: [step([['test/accept.test.mjs', `${HEAD}// TODO tests\n`]])] } });
  const g2 = await sb2.goal(merge({ ...ACC, plan: onePlan(accTask(), implTask()) }, ONE));
  await drive(sb2.engine(g2.dir));
  assert.equal(log(g2.dir, 'acc')[0].outcome, 'acceptance_empty');
});

// ---------------------------------------------------------------- (f) hard-coded answers
const SLUG_TEST = `${HEAD}import { slugify } from '../src/slug.mjs';\ntest('slug', () => { assert.equal(slugify('Hello World!'), 'hello-world'); assert.equal(slugify('A  b'), 'a-b'); });\n`;
const HARD = "export const slugify = (s) => { if (s === 'Hello World!') return 'hello-world'; if (s === 'A  b') return 'a-b'; return ''; };\n";
const HONEST = "export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n";
test('f) literal copy: a hard-coded answer is an ADVISORY warning by default (attempt passes; attempt, events, report.md and the reviewer input carry it)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); commit(sb, { 'test/slug.test.mjs': SLUG_TEST, 'src/slug.mjs': 'export const slugify = () => "";\n' });
  sb.scenario({ tasks: { t1: [step([B(), ['src/slug.mjs', HARD]])] } });
  const { dir } = await sb.goal({ success_criteria: [crit('b.txt', 'beta')], plan: onePlan(T('t1', { scope: ['b.txt', 'src/slug.mjs'], checks: [NT('test/slug.test.mjs')] })) });
  await drive(sb.engine(dir));
  assert.equal(goalOf(dir).status, 'achieved'); const a = log(dir)[0].anticheat; assert.equal(a.status, 'warn');
  assert.ok(a.findings.some((f) => f.kind === 'literal_copy' && f.severity === 'warn' && /Hello World!/.test(f.detail)));
  assert.equal(ev(dir, 'orch.anticheat.warning')[0].data.kinds[0], 'literal_copy');
  const rep = fs.readFileSync(paths(dir).report, 'utf8'); assert.match(rep, /ADVISORY t1#1: literal_copy src\/slug\.mjs/);
  const notes = A.reviewerNotes({ tasks: tasksOf(dir) });
  assert.match(buildReviewPrompt({ goal: goalOf(dir), diff: 'd', anticheat: notes }), /engine anti-cheat warnings[\s\S]*literal_copy src\/slug\.mjs/);
  assert.doesNotMatch(buildReviewPrompt({ goal: goalOf(dir), diff: 'd' }), /anti-cheat warnings/);
});

test('f) literal copy: with checks.literal_copy "fail" the hard-coded attempt fails; the honest one passes', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); commit(sb, { 'test/slug.test.mjs': SLUG_TEST, 'src/slug.mjs': 'export const slugify = () => "";\n' });
  sb.scenario({ tasks: { t1: [step([B(), ['src/slug.mjs', HARD]]), step([B(), ['src/slug.mjs', HONEST]])] } });
  const { dir } = await sb.goal({ ...rules({ literal_copy: 'fail' }), success_criteria: [crit('b.txt', 'beta')], plan: onePlan(T('t1', { scope: ['b.txt', 'src/slug.mjs'], checks: [NT('test/slug.test.mjs')] })) });
  await drive(sb.engine(dir));
  assert.equal(log(dir)[0].outcome, 'literal_copy'); assert.equal(log(dir)[1].outcome, 'success'); assert.equal(goalOf(dir).status, 'achieved');
  assert.equal(log(dir)[1].anticheat.findings.length, 0);
});

// ---------------------------------------------------------------- rules
test('rules: acceptance_first and literal_copy are tightening-only (a later layer cannot loosen them); the node-library profile turns acceptance_first on', () => {
  const R = (checks) => ({ rules_version: 1, checks });
  const c = compileRules([{ layer: 'user', rules: R({ acceptance_first: true, literal_copy: 'fail' }) }, { layer: 'repo', rules: R({ acceptance_first: false, literal_copy: 'warn' }) }], { accept: [] });
  assert.equal(c.compiled.checks.acceptance_first, true); assert.equal(c.compiled.checks.literal_copy, 'fail'); assert.equal(c.dropped.length, 2, 'a repo cannot loosen them');
  const g = compileRules([{ layer: 'user', rules: R({ acceptance_first: true }) }, { layer: 'goal', rules: R({ acceptance_first: false }) }]);
  assert.equal(g.compiled.checks.acceptance_first, false); assert.equal(g.loosenings[0].path, 'checks.acceptance_first', 'a human-approved goal layer may loosen it, and it is listed');
  assert.equal(PROFILES['node-library'].checks.acceptance_first, true);
  const d = compileRules([]); assert.equal(d.compiled.checks.acceptance_first, false); assert.equal(d.compiled.checks.literal_copy, 'warn');
  assert.equal(compileRules([{ layer: 'goal', rules: R({ literal_copy: 'strict' }) }]).ok, false);
});
