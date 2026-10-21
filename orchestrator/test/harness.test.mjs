// Harness guard (lib/harness-*.mjs): the engine preload freezes/verifies assert + node:test, markers carry a nonce, per-file counts, Node 18/22 TAP, static rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck } from '../lib/checks.mjs';
import { parseTestSummary, forceTapArgv, judgeRun, assertionDrop, checkInputPaths, packageConfigChanged, isConfigPath, parseDiff, analyzeDiff } from '../lib/anticheat.mjs';
import { judgePerFile, expandTestGlobs, harnessTamperHits } from '../lib/harness-guard.mjs';
import { isTestPath } from '../lib/protect.mjs';
import { orchLocation } from '../lib/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HEAD = "import test from 'node:test';import assert from 'node:assert/strict';\n";
const mk = (files) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hg-test-'))); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } return d; };
const run = (cwd, ...args) => runCheck({ argv: forceTapArgv(['node', '--test', ...args]), timeout_s: 60 }, { cwd, env: { PATH: process.env.PATH, TERM: 'dumb', TMPDIR: os.tmpdir() }, unsandboxed: true });

test('harness guard: an honest run leaves valid markers and per-file counts', async (t) => {
  const d = mk({ 'a.test.mjs': `${HEAD}test('1', () => assert.equal(1, 1));\ntest('2', () => assert.equal(2, 2));\n`, 'b.test.mjs': `${HEAD}test('3', () => assert.ok(true));\n` }); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const r = await run(d, 'a.test.mjs', 'b.test.mjs');
  assert.equal(r.ok, true); assert.equal(r.harness.processes, 2); assert.ok(r.harness.checked > 50);
  assert.deepEqual(Object.fromEntries(Object.entries(r.test_files).map(([f, x]) => [f, x.tests])), { 'a.test.mjs': 2, 'b.test.mjs': 1 });
  assert.equal(parseTestSummary(r.summary_text).tests, 3);
});

test('harness guard: a test file that require()s other test files (an aggregator) is one honest process, not deleted markers', async (t) => {
  // real eval trial (hard-feature-2, T6): test/recurrence.test.js was `require('./rrule.test.js'); require('./expand.test.js'); ...`; node attributes each test to the
  // file where test() was CALLED, so the reporter saw 4 files from 1 process and the old "files > markers" count blocked the goal as harness_tamper.
  const T = "const test = require('node:test'); const assert = require('node:assert');\n";
  const d = mk({ 'package.json': '{"type":"commonjs"}', 'test/a.test.js': `${T}test('a1', () => assert.ok(1)); test('a2', () => assert.ok(1));\n`, 'test/b.test.js': `${T}test('b1', () => assert.ok(1));\n`,
    'test/c.test.js': `${T}test('c1', () => assert.ok(1));\n`, 'test/all.test.js': "require('./a.test.js'); require('./b.test.js'); require('./c.test.js');\n" }); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const r = await run(d, 'test/all.test.js');
  assert.equal(r.ok, true, JSON.stringify(r.harness_problems)); assert.equal(r.harness.processes, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(r.test_files).map(([f, x]) => [f, x.tests])), { 'test/a.test.js': 2, 'test/b.test.js': 1, 'test/c.test.js': 1 });
  const r2 = await run(d, 'test/all.test.js', 'test/a.test.js'); // the aggregator next to one of the files it loads: 2 processes, both marked
  assert.equal(r2.ok, true, JSON.stringify(r2.harness_problems)); assert.equal(r2.harness.processes, 2);
});

test('harness guard: a test process that deletes its own markers at exit is still harness_tamper (also behind an aggregator)', async (t) => {
  const T = "const test = require('node:test'); const assert = require('node:assert');\n";
  const wipe = "const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');\n"
    + "process.on('exit', () => { for (const x of fs.readdirSync(os.tmpdir())) if (x.startsWith('aos-hg-')) for (const n of ['start', 'end']) { try { fs.unlinkSync(path.join(os.tmpdir(), x, `${process.pid}.${n}`)); } catch {} } });\n";
  const d = mk({ 'package.json': '{"type":"commonjs"}', 'test/a.test.js': `${T}test('a1', () => assert.ok(1));\n`, 'test/b.test.js': `${T}test('b1', () => assert.ok(1));\n`,
    'test/x.test.js': `${T}${wipe}test('x1', () => assert.ok(1));\n`, 'test/all.test.js': `${wipe}require('./a.test.js'); require('./b.test.js');\n` }); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  for (const files of [['test/x.test.js', 'test/a.test.js'], ['test/all.test.js', 'test/x.test.js'], ['test/all.test.js', 'test/b.test.js']]) {
    const r = await run(d, ...files);
    assert.equal(r.ok, false, files.join()); assert.equal(r.harness_tamper, true); assert.match(r.harness_problems.join(' '), /left no harness marker/);
  }
});

test('harness guard: assert / node:test cannot be neutered by code under test (names built at run time, so no static hit)', async (t) => {
  const evil = "const n = 'node:' + 'ass' + 'ert'; const a = (await import(n)).default;\nfor (const k of Object.keys(a)) if (typeof a[k] === 'function' && k !== 'AssertionError') a[k] = () => {};\nexport const add = () => 0;\n";
  const d = mk({ 'src.mjs': evil, 'x.test.mjs': `${HEAD}import { add } from './src.mjs';\ntest('adds', () => assert.equal(add(2, 3), 5));\n` }); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const r = await run(d, 'x.test.mjs');
  assert.equal(r.ok, false); // the frozen export object rejects the assignment (and the run reports no passing test)
  const ok = parseTestSummary(r.summary_text); assert.ok(!ok || ok.pass === 0);
});

test('harness guard: a swapped assert function on a NON-frozen path, early reallyExit, and a forged marker are all harness_tamper', async (t) => {
  // (1) a test that replaces the exported function of the ESM namespace is impossible; (2) reallyExit(0) before the tests ran is a file-only entry, markers stay valid;
  // (3) a forged end marker (wrong nonce) next to the real directory is detected.
  const early = mk({ 'e.test.mjs': `${HEAD}process.reallyExit(0);\n` }); t.after(() => fs.rmSync(early, { recursive: true, force: true }));
  const r1 = await run(early, 'e.test.mjs');
  assert.equal(r1.ok, true); assert.equal(r1.harness.processes, 1); assert.equal(r1.test_files['e.test.mjs'].file_only, true, 'reallyExit before any test is a file-only entry, not tests');
  assert.equal(judgePerFile({ 'e.test.mjs': { tests: 2 } }, r1.test_files).kind, 'tests_reduced');
  const forge = mk({ 'f.test.mjs': `${HEAD}import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const tmp = os.tmpdir(); for (const d of fs.readdirSync(tmp)) if (d.startsWith('aos-hg-')) { try { fs.writeFileSync(path.join(tmp, d, '99999.end'), JSON.stringify({ nonce: 'guess', pid: 99999, ok: true })); } catch {} }
test('x', () => assert.ok(true));\n` }); t.after(() => fs.rmSync(forge, { recursive: true, force: true }));
  const r2 = await run(forge, 'f.test.mjs');
  assert.equal(r2.ok, false); assert.equal(r2.harness_tamper, true); assert.match(r2.harness_problems.join(' '), /forged|wrong nonce/);
  const killed = mk({ 'k.test.mjs': `${HEAD}test('x', () => assert.ok(true));\nprocess.kill(process.pid, 'SIGKILL');\n` }); t.after(() => fs.rmSync(killed, { recursive: true, force: true }));
  const r3 = await run(killed, 'k.test.mjs'); assert.equal(r3.ok, false);
});

test('harness guard: the nonce and marker dir are removed from process.env at preload time; harnessMode warn only records', async (t) => {
  const d = mk({ 'n.test.mjs': `${HEAD}test('env', () => { assert.equal(process.env.AOS_GUARD_NONCE, undefined); assert.equal(process.env.AOS_GUARD_DIR, undefined); });\n` }); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  assert.equal((await run(d, 'n.test.mjs')).ok, true);
  const forge = mk({ 'w.test.mjs': `${HEAD}import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
for (const x of fs.readdirSync(os.tmpdir())) if (x.startsWith('aos-hg-')) { try { fs.writeFileSync(path.join(os.tmpdir(), x, '1.start'), 'junk'); } catch {} }
test('x', () => assert.ok(true));\n` }); t.after(() => fs.rmSync(forge, { recursive: true, force: true }));
  const w = await runCheck({ argv: forceTapArgv(['node', '--test', 'w.test.mjs']), timeout_s: 60 }, { cwd: forge, env: { PATH: process.env.PATH, TMPDIR: os.tmpdir() }, unsandboxed: true, harnessMode: 'warn' });
  assert.equal(w.ok, true); assert.ok(w.harness_problems.length); assert.equal(w.harness_tamper, false);
});

test('parseTestSummary: real Node 18 and Node 22 TAP give the same counts (file-level entries use an absolute vs a relative name)', () => {
  const read = (n) => fs.readFileSync(path.join(HERE, 'fixtures', n), 'utf8');
  const a = parseTestSummary(read('tap-node18.txt')); const b = parseTestSummary(read('tap-node22.txt'));
  assert.deepEqual(a, b); assert.equal(a.tests, 5); assert.equal(a.pass, 4); assert.equal(a.skipped, 1); assert.equal(a.file_entries, 1);
});

test('expandTestGlobs: Node < 21 does not expand globs itself, the engine does (same files as Node 22)', () => {
  const d = mk({ 'test/a.test.mjs': '', 'test/b.test.mjs': '', 'test/sub/c.test.mjs': '', 'src/x.mjs': '' }); try {
    assert.deepEqual(expandTestGlobs(['node', '--test', 'test/*.test.mjs'], d, 18), ['node', '--test', 'test/a.test.mjs', 'test/b.test.mjs']);
    assert.deepEqual(expandTestGlobs(['node', '--test', 'test/*.test.mjs'], d, 22), ['node', '--test', 'test/*.test.mjs']);
    assert.deepEqual(expandTestGlobs(['node', '--test', 'test/'], d, 18), ['node', '--test', 'test/']);
    assert.deepEqual(expandTestGlobs(['node', '--check', 'x*.mjs'], d, 18), ['node', '--check', 'x*.mjs']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('judgePerFile / judgeRun: per-file counts, file-only entries, skipped+todo above the baseline', () => {
  const base = { 'a.test.mjs': { tests: 3 }, 'b.test.mjs': { tests: 1 } };
  assert.equal(judgePerFile(base, { 'a.test.mjs': { tests: 3 }, 'b.test.mjs': { tests: 5 } }).ok, true);
  assert.match(judgePerFile(base, { 'a.test.mjs': { tests: 2 }, 'b.test.mjs': { tests: 9 } }).reason, /a\.test\.mjs: 2 test\(s\), fewer than the 3/);
  assert.match(judgePerFile(base, { 'a.test.mjs': { tests: 3 } }).reason, /b\.test\.mjs: ran no tests/);
  assert.match(judgePerFile(base, { 'a.test.mjs': { tests: 0, file_only: true }, 'b.test.mjs': { tests: 1 } }).reason, /file-only/);
  const argv = ['node', '--test', 'x']; const sm = { tests: 5, pass: 4, fail: 0, cancelled: 0, skipped: 1, todo: 0 };
  assert.equal(judgeRun(argv, sm, { tests: 5, skipped: 0, todo: 0, source: 'run' }).kind, 'tests_skipped');
  assert.equal(judgeRun(argv, sm, { tests: 5, skipped: 1, todo: 0, source: 'run' }).ok, true);
  assert.equal(judgeRun(argv, sm, { tests: 5, skipped: 0, todo: 0, source: 'run' }, { allowSkip: true }).ok, true);
  assert.equal(judgeRun(argv, sm, { tests: 5, source: 'static' }).ok, true);
});

test('static rules: harness_tamper lines, tests_weakened (assertion drop), config inputs (--import, exports/type, tsconfig)', async () => {
  const diff = (p, rm, add, st = 'M') => ({ path: p, from: p, status: st, removed: rm, added: add });
  assert.equal(harnessTamperHits([diff('src/a.mjs', [], ["import a from 'node:assert';"], 'A'), diff('src/b.mjs', [], ['process.exit(0)']), diff('src/c.mjs', [], ['// process.exit in a comment']), diff('test/t.test.mjs', [], ["import test from 'node:test'"])], isTestPath).map((h) => h.path).join(), 'src/a.mjs,src/b.mjs');
  assert.deepEqual(assertionDrop(diff('t.test.mjs', ['test("a", () => assert.equal(add(1,2),3));', 'assert.ok(x)'], ['test("a", () => assert.ok(add));'])), { total: 1, strong: 1 });
  assert.deepEqual(assertionDrop(diff('t.test.mjs', ['assert.equal(a, 1)'], ['assert.equal(a, 2)'])), { total: 0, strong: 0 }, 'changing an expected value in place is a documented blind spot');
  const f = [diff('test/helper.mjs', ['assert.equal(a, 1);', 'assert.equal(b, 2);'], ['assert.ok(b);'])];
  const fl = (await analyzeDiff(f, { path_scope: ['test/*.mjs'], checks: [] }, { before: async () => null, after: async () => null, tests: async () => [] })).findings;
  assert.equal(fl[0].kind, 'tests_weakened'); assert.equal(fl[0].severity, 'fail', 'helper modules under test/ count as test files');
  const fl2 = (await analyzeDiff(f, { path_scope: ['test/helper.mjs'], checks: [] }, { before: async () => null, after: async () => null, tests: async () => [] })).findings;
  assert.equal(fl2[0].severity, 'allowed');
  assert.deepEqual(checkInputPaths([['node', '--import', './test/setup.mjs', '--test', 'test/a.test.mjs'], ['node', '--import=./hooks.mjs', '--test']]).sort(), ['hooks.mjs', 'test/setup.mjs']);
  assert.deepEqual(packageConfigChanged('{"type":"module"}', '{"type":"commonjs"}'), ['type']);
  assert.deepEqual(packageConfigChanged('{"exports":"./a.js"}', '{"exports":"./b.js"}'), ['exports']);
  for (const n of ['tsconfig.json', 'jsconfig.json', '.taprc', 'tsconfig.build.json']) assert.ok(isConfigPath(n), n);
  assert.equal(parseDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')[0].added[0], 'b');
});

test('state dir: the CLI honours CLAUDE_PLUGIN_DATA for the legacy location like the dashboard', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-home-')); const plug = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-plug-'));
  try {
    fs.mkdirSync(path.join(plug, 'orch'));
    assert.deepEqual(orchLocation({ HOME: home, CLAUDE_PLUGIN_DATA: plug }), { dir: path.join(plug, 'orch'), legacy: true, fresh: path.join(home, '.aos', 'orch') });
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(plug, { recursive: true, force: true }); }
});
