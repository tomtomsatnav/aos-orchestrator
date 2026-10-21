// Verdict records written by `aos-orch verify` (lib/verdicts.mjs; contract in docs/orch-state-contract.md "Verdicts").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HERE, NO_OS_SANDBOX, git } from './helpers.mjs';
import { buildVerdictRecord, writeVerdict, verdictsRoot, VERDICT_ID_RE } from '../lib/verdicts.mjs';

const CLI = path.join(HERE, '..', 'bin', 'aos-orch.mjs');
const skip = NO_OS_SANDBOX ? 'needs the OS check sandbox' : false;
const ADD = 'exports.add = (a, b) => a - b;\n';
const ADD_TEST = "const test = require('node:test'); const assert = require('node:assert'); const { add } = require('../src/add.js');\ntest('adds', () => { assert.strictEqual(add(2, 3), 5); });\ntest('zero', () => { assert.strictEqual(add(0, 0), 0); });\n";
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const put = (d, f, t) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
function repoWith(files) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-verdict-t-')));
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false');
  for (const [f, t] of Object.entries({ 'package.json': '{"name":"x","version":"1.0.0","scripts":{"test":"node --test"}}\n', ...files })) put(d, f, t);
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'seed');
  return d;
}
const mkOrch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aos-verdict-orch-'));
const verdicts = (orch) => fs.readdirSync(path.join(orch, 'verdicts')).filter((f) => f.endsWith('.json'));
const FAKE = { accepted: false, base: 'a'.repeat(40), rejections: [{ kind: 'check_failed', detail: 'x\u0007y'.repeat(200) }], anticheat: { warnings: [{ kind: 'w', detail: 'd' }] }, failing_tests: [{ name: 't', file: 'f.js' }], checks: [{ argv: ['node', '--test'], ok: false, exit_code: 1, duration_ms: 12.4 }] };
const META = { repo: '/tmp/some/repo', base_ref: 'main', tree: 'working', source: 'cli', session_id: null, duration_ms: 5, tool_version: '0.1.0' };

test('record: exact fields and types, detail capped and control chars stripped', () => {
  const rec = buildVerdictRecord(FAKE, META);
  assert.deepEqual(Object.keys(rec), ['schema', 'id', 'created_at', 'repo', 'repo_name', 'base', 'base_ref', 'tree', 'accepted', 'integrity', 'rejections', 'warnings', 'failing_tests', 'checks', 'duration_ms', 'source', 'session_id', 'tool_version']);
  assert.equal(rec.schema, 'aos.verdict/1'); assert.match(rec.id, VERDICT_ID_RE); assert.equal(rec.repo_name, 'repo');
  assert.equal(rec.rejections[0].detail.length, 300); assert.ok(!/[\u0000-\u001f]/.test(rec.rejections[0].detail));
  assert.deepEqual(rec.checks, [{ argv: 'node --test', ok: false, exit_code: 1, duration_ms: 12 }]);
  assert.deepEqual(rec.failing_tests, ['f.js: t']); assert.deepEqual(rec.warnings, ['w: d']);
});

test('integrity flag: true for an edited-test rejection, false for a capability rejection', () => {
  assert.equal(buildVerdictRecord({ ...FAKE, rejections: [{ kind: 'check_failed', detail: 'a' }, { kind: 'tests_edited', detail: 'b' }] }, META).integrity, true);
  assert.equal(buildVerdictRecord({ ...FAKE, rejections: [{ kind: 'check_failed', detail: 'a' }, { kind: 'protected_tests_failed', detail: 'b' }] }, META).integrity, false);
});

test('writeVerdict: atomic (no temp files), mode 0600 / 0700, within 64 KB', () => {
  const orch = mkOrch();
  try {
    const big = { ...FAKE, checks: Array.from({ length: 50 }, () => ({ argv: ['x'.repeat(5000)], ok: true, exit_code: 0, duration_ms: 1 })), warnings: [] };
    const { id, path: file } = writeVerdict(orch, buildVerdictRecord(big, META));
    assert.deepEqual(fs.readdirSync(verdictsRoot(orch)), [`${id}.json`]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(verdictsRoot(orch)).mode & 0o777, 0o700);
    assert.ok(fs.statSync(file).size <= 64 * 1024); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).id, id);
  } finally { rm(orch); }
});

test('writeVerdict: keeps only the newest `limit` records (500 by default)', () => {
  const orch = mkOrch();
  try {
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push(writeVerdict(orch, buildVerdictRecord(FAKE, { ...META, now: Date.UTC(2026, 9, 21, 9, 0, i) }), { limit: 5 }).id);
    assert.deepEqual(verdicts(orch).map((f) => f.slice(0, -5)).sort(), ids.slice(2).sort());
  } finally { rm(orch); }
});

test('aos-orch verify: record by default (--source, --session, --json record), --no-record, invalid --session', { skip, timeout: 170000 }, () => {
  const d = repoWith({ 'src/add.js': ADD, 'test/add.test.js': ADD_TEST });
  const orch = mkOrch();
  const run = (...a) => spawnSync(process.execPath, [CLI, 'verify', '--repo', d, ...a], { env: { ...process.env, AOS_ORCH_DIR: orch }, encoding: 'utf8', timeout: 80000 });
  try {
    let r = run('--no-record');
    assert.equal(r.status, 1, r.stderr); assert.ok(!fs.existsSync(path.join(orch, 'verdicts')));
    r = run('--json', '--source', 'hook', '--session', 'sess_1-A');
    assert.equal(r.status, 1, r.stderr); const j = JSON.parse(r.stdout);
    const files = verdicts(orch); assert.equal(files.length, 1); assert.equal(j.record.path, path.join(orch, 'verdicts', files[0])); assert.equal(j.record.id, files[0].slice(0, -5));
    const rec = JSON.parse(fs.readFileSync(j.record.path, 'utf8'));
    assert.equal(rec.accepted, false); assert.equal(rec.integrity, false); assert.equal(rec.source, 'hook'); assert.equal(rec.session_id, 'sess_1-A');
    assert.equal(rec.repo, d); assert.equal(rec.base_ref, 'main'); assert.equal(rec.tree, 'working'); assert.match(rec.base, /^[0-9a-f]{40}$/); assert.equal(rec.tool_version, '0.1.0');
    assert.ok(rec.rejections.some((x) => x.kind === 'check_failed')); assert.equal(rec.checks[0].argv, 'node --test');
    assert.equal(git(d, 'status', '--porcelain'), ''); // nothing written into the verified repo
    assert.equal(run('--session', 'bad id!').status, 2); assert.equal(run('--session', 'x'.repeat(65)).status, 2); assert.equal(run('--source', 'nope').status, 2);
    assert.equal(verdicts(orch).length, 1);
  } finally { rm(d); rm(orch); }
});

test('aos-orch verify: an edited test sets integrity true in the record', { skip, timeout: 120000 }, () => {
  const d = repoWith({ 'src/add.js': ADD, 'test/add.test.js': ADD_TEST });
  const orch = mkOrch();
  try {
    put(d, 'test/add.test.js', ADD_TEST.replace('add(2, 3), 5', 'add(2, 3), -1'));
    const r = spawnSync(process.execPath, [CLI, 'verify', '--repo', d, '--tree', 'HEAD'], { env: { ...process.env, AOS_ORCH_DIR: orch }, encoding: 'utf8', timeout: 100000 });
    assert.equal(r.status, 1, r.stderr); // --tree HEAD is the unchanged seed: capability rejection, integrity false
    assert.equal(JSON.parse(fs.readFileSync(path.join(orch, 'verdicts', verdicts(orch)[0]), 'utf8')).integrity, false);
    const r2 = spawnSync(process.execPath, [CLI, 'verify', '--repo', d], { env: { ...process.env, AOS_ORCH_DIR: orch }, encoding: 'utf8', timeout: 100000 });
    assert.equal(r2.status, 1, r2.stderr);
    const recs = verdicts(orch).map((f) => JSON.parse(fs.readFileSync(path.join(orch, 'verdicts', f), 'utf8')));
    const w = recs.find((x) => x.tree === 'working'); assert.equal(w.integrity, true); assert.ok(w.rejections.some((x) => x.kind === 'tests_edited'));
    assert.match(recs.find((x) => x.tree !== 'working').tree, /^[0-9a-f]{40}$/);
  } finally { rm(d); rm(orch); }
});
