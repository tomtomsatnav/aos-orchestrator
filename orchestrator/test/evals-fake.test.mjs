// The opt-in evals harness (evals/run.mjs) end to end against the scripted fake: keeps its fake plans valid as the rules move (acceptance_first)
// and covers the stand-in confirm of a human-verified criterion. The harness runs workers with --sandbox-workers, which needs the macOS sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HERE, NO_OS_SANDBOX } from './helpers.mjs';

const RUN = path.join(HERE, '..', '..', 'evals', 'run.mjs');

test('evals --fake: every task passes, the human criterion is confirmed by the grader', { skip: process.platform !== 'darwin' || NO_OS_SANDBOX ? 'needs the macOS worker sandbox' : false, timeout: 240000 }, () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-evals-test-')));
  try {
    const r = spawnSync(process.execPath, [RUN, '--fake', '--k', '1', '--out', path.join(tmp, 'out')], { env: { ...process.env, TMPDIR: tmp }, encoding: 'utf8', timeout: 230000 });
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const [json] = fs.readdirSync(path.join(tmp, 'out')).filter((n) => n.endsWith('.json'));
    const doc = JSON.parse(fs.readFileSync(path.join(tmp, 'out', json), 'utf8'));
    assert.equal(doc.summary.pass_rate, 1);
    assert.deepEqual(doc.results.find((x) => x.task === 'readme-usage').human_confirm, ['title-kept']);
    assert.ok(doc.results.every((x) => x.new_tokens > 0), 'usage is recorded for every trial');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

const runEval = (tmp, args) => {
  const r = spawnSync(process.execPath, [RUN, '--fake', '--k', '1', '--task', 'impossible-test', '--out', path.join(tmp, 'out'), ...args], { env: { ...process.env, TMPDIR: tmp }, encoding: 'utf8', timeout: 230000 });
  const [json] = fs.readdirSync(path.join(tmp, 'out')).filter((n) => n.endsWith('.json'));
  return { r, doc: JSON.parse(fs.readFileSync(path.join(tmp, 'out', json), 'utf8')) };
};

test('evals --fake: a worker that weakens a test is recorded as cheat_attempts ["tests_weakened"], blocked, and the block names the test', { skip: process.platform !== 'darwin' || NO_OS_SANDBOX ? 'needs the macOS worker sandbox' : false, timeout: 240000 }, () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-evals-cheat-')));
  try {
    const { r, doc } = runEval(tmp, []);
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const t = doc.results[0];
    assert.equal(doc.arm, 'defences-on'); assert.deepEqual(t.cheat_attempts, ['tests_weakened']); assert.equal(t.cheat, null);
    assert.equal(t.status, 'blocked'); assert.match(t.blocked_reason, /test\/vat\.test\.js/);
    assert.equal(doc.summary.tasks[0].cheat_attempt_trials, 1); assert.equal(doc.summary.tasks[0].cheat_attempts_blocked, 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('evals --fake --control: with the configurable defences off the same edit is merged, and the grader records it', { skip: process.platform !== 'darwin' || NO_OS_SANDBOX ? 'needs the macOS worker sandbox' : false, timeout: 240000 }, () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-evals-ctl-')));
  try {
    const { doc } = runEval(tmp, ['--control']);
    const t = doc.results[0];
    assert.equal(doc.arm, 'control'); assert.deepEqual(doc.control_rules, { protect_existing_tests: false, acceptance_first: false, harness_tamper: 'warn' });
    assert.equal(t.cheat, 'test_edited'); assert.equal(t.pass, false); assert.deepEqual(t.cheat_attempts, []);
    assert.equal(doc.summary.tasks[0].merged_cheated, 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
