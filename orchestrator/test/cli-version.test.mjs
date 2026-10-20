import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkSandbox, drive, goalOf, tasksOf, HERE } from './helpers.mjs';
import { paths } from '../lib/state.mjs';
import { buildReport } from '../lib/report.mjs';
import { versionDrift, probeClaudeVersion } from '../lib/cli-version.mjs';
import { FAKE } from './helpers.mjs';

const SCEN = (f) => JSON.parse(fs.readFileSync(path.join(HERE, 'scenarios', f), 'utf8'));

test('attempt_log and the report carry the injected claude version', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario(SCEN('all-success-3-tasks.json'));
  const { dir } = await sb.goal({});
  let calls = 0;
  const eng = sb.engine(dir, { claudeVersion: async () => { calls++; return '9.9.9 (Claude Code)'; } });
  await eng.start(); await drive(eng);
  assert.ok(calls === 1, `probed once, got ${calls}`);
  assert.equal(goalOf(dir).orch.claude_version_start, '9.9.9 (Claude Code)');
  for (const x of tasksOf(dir)) for (const a of x.orch.attempt_log) assert.equal(a.claude_version, '9.9.9 (Claude Code)');
  const report = fs.readFileSync(paths(dir).report, 'utf8');
  assert.match(report, /claude CLI version at first dispatch: `9\.9\.9 \(Claude Code\)`/);
  assert.doesNotMatch(report, /WARN/);
});

test('default probe runs the binary with --version (fake claude)', async () => {
  assert.equal(await probeClaudeVersion(FAKE, process.env), '2.1.303 (Claude Code)');
  assert.equal(await probeClaudeVersion('/nonexistent/claude', process.env), null);
});

test('report warns when an attempt ran on a different version than the goal started with', () => {
  const goal = { id: 'g', title: 't', status: 'achieved', success_criteria: [], orch: { repo: '/r', base_branch: 'main', integration_branch: 'i', usage: { new_tokens: 0, cache_read_tokens: 0, workers_started: 0 }, claude_version_start: '1.0.0' } };
  const tasks = [{ id: 't1', status: 'done', attempts: 2, max_attempts: 3, orch: { attempt_log: [{ n: 1, tier: 'haiku', claude_version: '1.0.0' }, { n: 2, tier: 'haiku', claude_version: '1.1.0' }] } }];
  assert.deepEqual(versionDrift('1.0.0', tasks), [{ task: 't1', n: 2, version: '1.1.0' }]);
  assert.match(buildReport({ goal, tasks }), /WARN: the claude CLI version changed.*t1#2 ran on `1\.1\.0`/);
});
