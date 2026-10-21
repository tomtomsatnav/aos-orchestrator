// An acceptance test that requires a file only a LATER task writes (found by the real hard-feature eval): the engine scans the merged acceptance
// files before dispatch and either makes the task wait for the writer, or (when the writer already runs after the task) blocks the goal at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkSandbox, drive, goalOf, tasksOf } from './helpers.mjs';
import { readEvents, paths } from '../lib/state.mjs';
import { relativeSpecifiers, candidatesFor } from '../lib/requires.mjs';

const T = (id, { scope, checks, deps = [], ...extra }) => ({ id, title: id, description: `do ${id}`, depends_on: deps, model_tier: 'haiku', path_scope: scope, allowed_commands: [], checks, output_contract: id, acceptance: [id], ...extra });
const step = (edits) => ({ behavior: 'success', edits: edits.map(([p, content]) => ({ path: p, content })) });
const HEAD = "import test from 'node:test';import assert from 'node:assert/strict';\n";
const NT = (f) => ({ argv: ['node', '--test', f], timeout_s: 60 });
const GREP = (w, f) => ({ argv: ['grep', '-q', w, f], timeout_s: 30 });
const GOAL = { orch: { rules: { rules_version: 1, checks: { acceptance_first: true } } }, success_criteria: [{ id: 'c1', text: 'vat exists', check: GREP('vat', 'src/vat.mjs') }] };
const acc = () => T('acc', { scope: ['test/vat.test.mjs'], checks: [{ argv: ['node', '--check', 'test/vat.test.mjs'], timeout_s: 30 }], role: 'acceptance' });
// the hard-feature shape: the feature's acceptance file also asserts that the index re-exports the new helper
const VAT_TEST = `${HEAD}// a comment: require('./not-real.mjs')\nimport { vat } from '../src/vat.mjs';\nimport * as idx from '../src/index.mjs';\ntest('vat', () => assert.equal(vat(100), 20));\ntest('index exports vat', () => assert.equal(typeof idx.vat, 'function'));\n`;
const VAT = ['src/vat.mjs', 'export const vat = (n) => n * 0.2;\n'];
const INDEX = ['src/index.mjs', "export * from './vat.mjs';\n"];
const evs = (dir, type) => readEvents(dir).filter((e) => e.type === type);

test('requires: relative specifiers are found statically (comments ignored) and resolved inside the repo only', () => {
  assert.deepEqual(relativeSpecifiers(VAT_TEST).sort(), ['../src/index.mjs', '../src/vat.mjs']);
  assert.deepEqual(relativeSpecifiers("const a = require('../lib');\nexport { b } from './b.js';\nawait import('./c');\nrequire('fs');"), ['../lib', './c', './b.js']);
  assert.deepEqual(candidatesFor('test/a.test.js', '../src/x').slice(0, 5), ['src/x', 'src/x.js', 'src/x.mjs', 'src/x.cjs', 'src/x/index.js']);
  assert.deepEqual(candidatesFor('test/a.test.js', '../../etc/passwd'), []);
  assert.deepEqual(candidatesFor('a.test.js', "./x'; rm -rf /"), [], 'a specifier that is not a plain path yields nothing');
});

test('acceptance requires: the hard-feature shape (index wiring owned by a task that runs AFTER) blocks the goal at once, without attempts or escalation', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { acc: [step([['test/vat.test.mjs', VAT_TEST]])], impl: [step([VAT])], wire: [step([INDEX])] } });
  const plan = { tasks: [acc(), T('impl', { scope: ['src/vat.mjs'], deps: ['acc'], checks: [NT('test/vat.test.mjs')] }), T('wire', { scope: ['src/index.mjs'], deps: ['acc', 'impl'], checks: [GREP('vat', 'src/index.mjs')] })], risks: [] };
  const { dir } = await sb.goal({ ...GOAL, plan });
  await drive(sb.engine(dir));
  const g = goalOf(dir); const impl = tasksOf(dir).find((x) => x.id === 'impl');
  assert.equal(g.status, 'blocked');
  assert.match(g.blocked_reason, /acceptance test dependency cycle: task impl's check runs test\/vat\.test\.mjs, which requires src\/index\.mjs; only task wire can write src\/index\.mjs/);
  assert.match(g.blocked_reason, /re-plan[\s\S]*aos-orch archive/);
  assert.equal(impl.status, 'failed'); assert.equal(impl.attempts, 0); assert.equal(impl.orch.attempt_log.length, 0);
  assert.equal(impl.orch.model_tier, 'haiku', 'no tier escalation');
  assert.equal(evs(dir, 'task.started').filter((e) => e.task_id === 'impl').length, 0);
  assert.equal(tasksOf(dir).find((x) => x.id === 'wire').status, 'pending');
});

test('acceptance requires: when the writer of the required file can run first, the task waits for it (event + report) and then succeeds', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { acc: [step([['test/vat.test.mjs', VAT_TEST]])], impl: [step([VAT])], wire: [step([INDEX])] } });
  const plan = { tasks: [acc(), T('impl', { scope: ['src/vat.mjs'], deps: ['acc'], checks: [NT('test/vat.test.mjs')] }), T('wire', { scope: ['src/index.mjs'], deps: ['acc'], checks: [GREP('vat', 'src/index.mjs')] })], risks: [] };
  const { dir } = await sb.goal({ ...GOAL, plan });
  await drive(sb.engine(dir));
  const g = goalOf(dir); const impl = tasksOf(dir).find((x) => x.id === 'impl');
  assert.equal(g.status, 'achieved', g.blocked_reason);
  assert.deepEqual(impl.depends_on, ['acc'], 'the approved dependencies are unchanged');
  assert.deepEqual(impl.orch.run_deps, ['wire']); assert.equal(impl.attempts, 1);
  const added = evs(dir, 'orch.plan.deps_added').filter((e) => e.data.rule === 'acceptance.requires');
  assert.equal(added.length, 1); assert.deepEqual(added[0].data.added, ['wire']); assert.match(added[0].data.text, /test\/vat\.test\.mjs requires src\/index\.mjs \(written by wire\)/);
  const started = readEvents(dir).filter((e) => e.type === 'task.started').map((e) => e.task_id);
  assert.ok(started.indexOf('wire') < started.indexOf('impl'));
  assert.match(fs.readFileSync(paths(dir).report, 'utf8'), /Dependencies the engine added at run time[\s\S]*impl: ACCEPTANCE TEST REQUIRES ANOTHER TASK'S FILE/);
});

test('acceptance requires: an acceptance file that only requires the task\'s own files is unaffected', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const OWN = `${HEAD}import { vat } from '../src/vat.mjs';\ntest('vat', () => assert.equal(vat(100), 20));\n`;
  sb.scenario({ tasks: { acc: [step([['test/vat.test.mjs', OWN]])], impl: [step([VAT])], wire: [step([INDEX])] } });
  const plan = { tasks: [acc(), T('impl', { scope: ['src/vat.mjs'], deps: ['acc'], checks: [NT('test/vat.test.mjs')] }), T('wire', { scope: ['src/index.mjs'], deps: ['acc', 'impl'], checks: [GREP('vat', 'src/index.mjs')] })], risks: [] };
  const { dir } = await sb.goal({ ...GOAL, plan });
  await drive(sb.engine(dir));
  assert.equal(goalOf(dir).status, 'achieved', goalOf(dir).blocked_reason);
  assert.equal(tasksOf(dir).find((x) => x.id === 'impl').orch.run_deps, undefined);
  assert.equal(evs(dir, 'orch.plan.deps_added').filter((e) => e.data.rule === 'acceptance.requires').length, 0);
});
