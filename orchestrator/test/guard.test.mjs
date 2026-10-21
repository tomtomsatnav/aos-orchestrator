// Guard mode (lib/guard.mjs verifyTree + `aos-orch verify`): a finished tree judged against its base commit with the engine's guardrails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HERE, NO_OS_SANDBOX, git } from './helpers.mjs';
import { verifyTree, INTEGRITY_KINDS } from '../lib/guard.mjs';

const CLI = path.join(HERE, '..', 'bin', 'aos-orch.mjs');
const skip = NO_OS_SANDBOX ? 'needs the OS check sandbox' : false;
const ADD = "exports.add = (a, b) => a - b;\n";
const ADD_TEST = "const test = require('node:test'); const assert = require('node:assert'); const { add } = require('../src/add.js');\ntest('adds', () => { assert.strictEqual(add(2, 3), 5); });\ntest('zero', () => { assert.strictEqual(add(0, 0), 0); });\n";
const VAT_TEST = "const test = require('node:test'); const assert = require('node:assert'); const { withVat } = require('../src/vat.js');\ntest('adds 20% VAT', () => { assert.strictEqual(withVat(250), 301); });\n";

function repoWith(files) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-guard-t-')));
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false');
  for (const [f, t] of Object.entries({ 'package.json': '{"name":"x","version":"1.0.0","scripts":{"test":"node --test"}}\n', ...files })) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'seed');
  return d;
}
const put = (d, f, t) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
const kinds = (r) => r.rejections.map((x) => x.kind);
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

test('verifyTree: a clean fix is accepted; the tree and the repo are left untouched', { skip, timeout: 120000 }, async () => {
  const d = repoWith({ 'src/add.js': ADD, 'test/add.test.js': ADD_TEST });
  try {
    put(d, 'src/add.js', 'exports.add = (a, b) => a + b;\n'); put(d, 'test/more.test.js', "const test = require('node:test'); const assert = require('node:assert'); const { add } = require('../src/add.js');\ntest('more', () => { assert.strictEqual(add(1, 1), 2); });\n");
    const r = await verifyTree({ repo: d });
    assert.equal(r.accepted, true, r.reasons.join('\n'));
    assert.deepEqual(r.checks.map((c) => c.argv.join(' ')), ['node --test']); assert.equal(r.checks[0].tests, 3); assert.equal(r.checks[0].baseline, 2);
    assert.equal(r.protected.ok, true); assert.equal(r.integrity, false);
    assert.deepEqual(git(d, 'status', '--porcelain').split('\n').map((l) => l.trim()).sort(), ['?? test/more.test.js', 'M src/add.js']);
    assert.equal(git(d, 'rev-list', '--all', '--count'), '1'); // nothing was committed or branched in the agent's repo
    assert.match(fs.readFileSync(path.join(d, 'src/add.js'), 'utf8'), /a \+ b/);
  } finally { rm(d); }
});

test('verifyTree: an edited expected value in an existing test is rejected, naming the test', { skip, timeout: 120000 }, async () => {
  const d = repoWith({ 'src/add.js': ADD, 'test/add.test.js': ADD_TEST });
  try {
    put(d, 'test/add.test.js', ADD_TEST.replace('add(2, 3), 5', 'add(2, 3), -1')); // makes the broken add "pass"
    const r = await verifyTree({ repo: d });
    assert.equal(r.accepted, false); assert.equal(r.integrity, true);
    assert.ok(kinds(r).includes('tests_edited'), kinds(r).join(','));
    assert.ok(kinds(r).includes('protected_tests_failed'));
    assert.ok(r.reasons.some((x) => /test\/add\.test\.js/.test(x)), r.reasons.join('\n'));
    assert.ok(r.failing_tests.some((t) => t.file === 'test/add.test.js' && t.in === 'original'));
  } finally { rm(d); }
});

test('verifyTree: a deleted test, an added .skip and a reduced test count are each rejected with their kind', { skip, timeout: 240000 }, async () => {
  const d = repoWith({ 'src/add.js': ADD, 'test/add.test.js': ADD_TEST });
  try {
    fs.rmSync(path.join(d, 'test/add.test.js'));
    let r = await verifyTree({ repo: d });
    assert.ok(kinds(r).includes('tests_deleted'), kinds(r).join(',')); assert.equal(r.integrity, true);
    git(d, 'checkout', '-q', '--', '.');
    put(d, 'test/add.test.js', ADD_TEST.replace("test('adds'", "test.skip('adds'"));
    r = await verifyTree({ repo: d });
    assert.ok(kinds(r).includes('tests_skipped'), kinds(r).join(','));
    git(d, 'checkout', '-q', '--', '.');
    put(d, 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    put(d, 'test/add.test.js', "const test = require('node:test'); const assert = require('node:assert'); const { add } = require('../src/add.js');\ntest('adds', () => { assert.strictEqual(add(2, 3), 5); assert.strictEqual(add(0, 0), 0); });\n");
    r = await verifyTree({ repo: d });
    assert.ok(kinds(r).includes('tests_reduced'), kinds(r).join(',')); assert.ok(INTEGRITY_KINDS.has('tests_reduced'));
  } finally { rm(d); }
});

test('verifyTree: a correct implementation against an impossible original test is rejected (capability), naming the failing test', { skip, timeout: 120000 }, async () => {
  const d = repoWith({ 'src/vat.js': 'exports.withVat = (p) => p;\n', 'test/vat.test.js': VAT_TEST });
  try {
    put(d, 'src/vat.js', 'exports.withVat = (p) => Math.round(p * 1.2);\n');
    const r = await verifyTree({ repo: d, base: 'main' });
    assert.equal(r.accepted, false); assert.equal(r.integrity, false);
    assert.deepEqual([...new Set(kinds(r))].sort(), ['check_failed', 'protected_tests_failed']);
    assert.ok(r.reasons.every((x) => /test\/vat\.test\.js/.test(x)), r.reasons.join('\n'));
  } finally { rm(d); }
});

test('verifyTree: a committed tree (--tree) is judged too; checks run sandboxed', { skip, timeout: 120000 }, async () => {
  const d = repoWith({ 'src/add.js': ADD, 'test/add.test.js': ADD_TEST });
  try {
    git(d, 'checkout', '-q', '-b', 'work'); put(d, 'src/add.js', 'exports.add = (a, b) => a + b;\n'); git(d, 'commit', '-qam', 'fix'); git(d, 'checkout', '-q', 'main');
    const r = await verifyTree({ repo: d, tree: 'work', checks: [{ argv: ['node', '--test'], timeout_s: 60 }] });
    assert.equal(r.accepted, true, r.reasons.join('\n')); assert.equal(r.checks[0].sandboxed, true); assert.deepEqual(r.files.map((f) => f.path), ['src/add.js']);
  } finally { rm(d); }
});

test('aos-orch verify: exit 0 accepted / 1 rejected, --json, usage errors exit 2', { skip, timeout: 120000 }, () => {
  const d = repoWith({ 'src/add.js': ADD, 'test/add.test.js': ADD_TEST });
  const orch = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-guard-orch-'));
  const run = (...a) => spawnSync(process.execPath, [CLI, 'verify', ...a], { env: { ...process.env, AOS_ORCH_DIR: orch }, encoding: 'utf8', timeout: 110000 });
  try {
    let r = run('--repo', d, '--json');
    assert.equal(r.status, 1, r.stderr); const j = JSON.parse(r.stdout); assert.equal(j.accepted, false); assert.ok(j.rejections.some((x) => x.kind === 'check_failed'));
    put(d, 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    r = run('--repo', d, '--base', 'main', '--check', 'node --test');
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /^ACCEPTED/);
    assert.equal(run('--repo', d, '--check', 'node --test | cat').status, 2);
    assert.equal(run().status, 2);
  } finally { rm(d); rm(orch); }
});
