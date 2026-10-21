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
