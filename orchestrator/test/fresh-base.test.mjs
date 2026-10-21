// BUG 1 regressions (real runs 2026-10-21, goalA / goalA2): a task check that judges OTHER tasks' work failed because
// (a) retries reused the first attempt's branch (stale base: work merged since was invisible) and
// (b) a whole-suite task check ran before the tasks it depends on in practice were merged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkSandbox, drive, git, goalOf, tasksOf, assertValidState } from './helpers.mjs';
import { readEvents } from '../lib/state.mjs';
import { validatePlan, isWholeSuiteCheck, docsOnlyScope } from '../lib/plan.mjs';

const onePlan = (...tasks) => ({ tasks, risks: [] });
const T = (id, scope, checks, deps = []) => ({ id, title: id, description: `do ${id}`, depends_on: deps, model_tier: 'haiku', path_scope: scope, allowed_commands: [], checks, output_contract: id, acceptance: [id] });
const nodeTest = (...files) => ({ argv: ['node', '--test', ...files], timeout_s: 60 });
const FIXED = 'export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n';

/** A repo like the real run's: src/math.mjs has a bug that its existing test catches. */
function buggyRepo(sb) {
  fs.mkdirSync(path.join(sb.repo, 'src')); fs.mkdirSync(path.join(sb.repo, 'test'));
  fs.writeFileSync(path.join(sb.repo, 'src', 'math.mjs'), 'export const clamp = (x, lo, hi) => 0;\n');
  fs.writeFileSync(path.join(sb.repo, 'test', 'math.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from '../src/math.mjs';\ntest('clamp mid', () => assert.equal(clamp(5, 0, 10), 5));\ntest('clamp high', () => assert.equal(clamp(15, 0, 10), 10));\n");
  git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-q', '-m', 'buggy clamp');
}
const suiteCrit = { id: 'suite', text: 'whole suite green', check: nodeTest() };
const started = (dir, id) => readEvents(dir).filter((e) => e.type === 'task.started' && e.task_id === id);
const mergedIdx = (ev, id) => ev.findIndex((e) => e.type === 'orch.integrate.merged' && e.task_id === id);

test('BUG 1b: a docs task whose check runs the WHOLE suite waits for the code task (dependency added at plan time, shown at approval) and the goal is achieved', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); buggyRepo(sb);
  sb.scenario({ planner: { behavior: 'success', plan: onePlan(
    T('fix', ['src/math.mjs'], [nodeTest('test/math.test.mjs')]),
    T('docs', ['README.md'], [{ argv: ['node', '--check', 'src/math.mjs'], timeout_s: 30 }, nodeTest()]), // no depends_on: before the fix it ran in parallel with `fix` and failed
  ) },
  tasks: { fix: [{ behavior: 'success', delay_ms: 600, edits: [{ path: 'src/math.mjs', content: FIXED }] }], docs: [{ behavior: 'success', edits: [{ path: 'README.md', content: '# fixture\n\nclamp(x, lo, hi)\n' }] }] } });
  const { dir } = await sb.goal({ success_criteria: [suiteCrit] });
  const eng = sb.engine(dir); await eng.start(); await drive(eng);
  const g = goalOf(dir);
  assert.equal(g.status, 'achieved', String(g.blocked_reason));
  const docs = tasksOf(dir).find((x) => x.id === 'docs');
  assert.deepEqual(docs.depends_on, ['fix'], 'the engine added the dependency');
  assert.equal(docs.attempts, 1, 'first attempt passes: it starts after the fix is merged');
  assert.match(g.orch.plan_warnings.docs.join(' '), /WHOLE-SUITE CHECK: "node --test" .*wait for fix/);
  assert.equal((g.orch.plan_warnings.fix || []).some((w) => /CONFIG FILE IN SCOPE/.test(w)), false, '`node --check src/math.mjs` does not make src/math.mjs a config file');
  const ev = readEvents(dir);
  assert.ok(mergedIdx(ev, 'fix') < ev.findIndex((e) => e.type === 'task.started' && e.task_id === 'docs'));
  assert.ok(ev.some((e) => e.type === 'orch.plan.deps_added' && e.task_id === 'docs'));
  assertValidState(assert, dir);
});

test('BUG 1a: a retry starts from the CURRENT integration tip (fresh branch per attempt, base sha recorded), so it sees work merged after its first attempt', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); buggyRepo(sb);
  // `docs` runs another task's test file by name (not a whole-suite check, so no dependency is added): its first attempt fails while `fix` is not merged
  sb.scenario({ planner: { behavior: 'success', plan: onePlan(
    T('fix', ['src/math.mjs'], [nodeTest('test/math.test.mjs')]),
    T('docs', ['README.md'], [nodeTest('test/math.test.mjs')]),
  ) },
  // both start in the same tick; docs' first attempt is slow, so `fix` is merged while it works: the attempt still fails (its base is the old tip), the retry must not
  tasks: { fix: [{ behavior: 'success', edits: [{ path: 'src/math.mjs', content: FIXED }] }],
    docs: [{ behavior: 'success', delay_ms: 2000, edits: [{ path: 'README.md', content: '# fixture\n\nclamp docs\n' }] }, { behavior: 'success', edits: [{ path: 'README.md', content: '# fixture\n\nclamp docs v2\n' }] }] } });
  const { dir } = await sb.goal({ success_criteria: [suiteCrit] });
  const eng = sb.engine(dir); await eng.start(); await drive(eng);
  const g = goalOf(dir);
  assert.equal(g.status, 'achieved', String(g.blocked_reason));
  const docs = tasksOf(dir).find((x) => x.id === 'docs');
  assert.deepEqual(docs.depends_on, [], 'no dependency was added for a named-file check');
  const [a1, a2] = docs.orch.attempt_log;
  assert.equal(a1.outcome, 'check_failed'); assert.equal(a2.outcome, 'success');
  assert.match(a1.base_sha, /^[0-9a-f]{40}$/); assert.match(a2.base_sha, /^[0-9a-f]{40}$/);
  assert.notEqual(a2.base_sha, a1.base_sha, 'the retry branched from a newer integration tip');
  const ev = readEvents(dir); const fixSha = ev.find((e) => e.type === 'orch.integrate.merged' && e.task_id === 'fix').data.sha;
  assert.equal(a2.base_sha, fixSha, 'the retry starts exactly at the merge of fix');
  const st = started(dir, 'docs'); assert.ok(ev.findIndex((e) => e.seq === st[0].seq) < mergedIdx(ev, 'fix') && mergedIdx(ev, 'fix') < ev.findIndex((e) => e.seq === st[1].seq), 'attempt 1 started before the fix was merged, attempt 2 after');
  // the merged docs commit has only the second attempt's change on top of the fix (the first attempt's commit is gone)
  assert.equal(git(sb.repo, 'show', 'aos/g-test/integration:README.md'), '# fixture\n\nclamp docs v2');
  assert.equal(git(sb.repo, 'log', '--format=%s', 'aos/g-test/docs').split('\n').filter((s) => /docs attempt 1/.test(s)).length, 0);
  assertValidState(assert, dir);
});

test('BUG 1b units: whole-suite detection, docs-only scopes, transitive dependencies, and a clear rejection when the order is impossible', () => {
  for (const a of [['npm', 'test'], ['npm', 'run', 'test'], ['pnpm', 'test'], ['node', '--test'], ['node', '--test', 'test/'], ['node', '--test', 'test/**/*.test.js'], ['node', '--test', '--test-reporter', 'tap'], ['node', '--test', 'test']]) assert.equal(isWholeSuiteCheck(a), true, a.join(' '));
  for (const a of [['node', '--test', 'test/a.test.js'], ['node', '--test', '--test-reporter', 'tap', 'test/a.test.js', 'test/b.test.js'], ['node', '--check', 'src/a.js'], ['grep', '-q', 'x', 'README.md']]) assert.equal(isWholeSuiteCheck(a), false, a.join(' '));
  assert.equal(docsOnlyScope(['README.md', 'docs/**']), true); assert.equal(docsOnlyScope(['README.md', 'src/a.js']), false);
  const opts = { max_tasks: 8, check_allowlist: ['node', 'npm test'] };
  // acc <- impl1, acc <- impl2, docs(README, npm test) <- impl1 only: impl2 is added; acc is already an ancestor; another docs task is not code
  const v = validatePlan(onePlan(T('acc', ['test/a.test.js'], [nodeTest('test/a.test.js')]), T('impl1', ['src/a.js'], [nodeTest('test/a.test.js')], ['acc']), T('impl2', ['src/b.js'], [nodeTest('test/b.test.js')], ['acc']),
    T('notes', ['docs/notes.md'], [{ argv: ['node', '--check', 'src/a.js'], timeout_s: 30 }]), T('docs', ['README.md'], [{ argv: ['npm', 'test'], timeout_s: 60 }], ['impl1'])), opts);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.deepEqual(v.tasks.find((x) => x.id === 'docs').depends_on, ['impl1', 'impl2']);
  assert.deepEqual(v.notes.map((n) => [n.task, n.added]), [['docs', ['impl2']]]);
  // impossible: the whole-suite task is itself a dependency of a code task
  const bad = validatePlan(onePlan(T('a', ['src/a.js'], [{ argv: ['npm', 'test'], timeout_s: 60 }]), T('b', ['src/b.js'], [nodeTest('test/b.test.js')], ['a'])), opts);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /a: its check "npm test" runs the WHOLE test suite.*b run\(s\) after a\. Give a a check on its own test files instead/);
  // two code tasks with whole-suite checks cannot each wait for the other
  const two = validatePlan(onePlan(T('a', ['src/a.js'], [{ argv: ['npm', 'test'], timeout_s: 60 }]), T('b', ['src/b.js'], [{ argv: ['npm', 'test'], timeout_s: 60 }])), opts);
  assert.equal(two.ok, false); assert.match(two.errors.join(' '), /b: its check "npm test" runs the WHOLE test suite/);
  // the planner's own plan object is never mutated
  const p = onePlan(T('x', ['src/x.js'], [nodeTest('test/x.test.js')]), T('d', ['README.md'], [{ argv: ['npm', 'test'], timeout_s: 60 }]));
  validatePlan(p, opts); assert.deepEqual(p.tasks[1].depends_on, []);
});
