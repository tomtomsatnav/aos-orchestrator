// R9: dead config (G3): approval_policy.outside_allowlist maps onto worker.bash.ask_on; the rest is reported as deprecated; old goals keep loading.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkSandbox, drive, goalOf, ptask, crit, edit } from './helpers.mjs';
import { goalLegacyRules } from '../lib/rules.mjs';
import { readEvents, paths, readJSON } from '../lib/state.mjs';

const onePlan = (...tasks) => ({ tasks, risks: [] });
const run = async (t, ap, user = null) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  if (user) fs.writeFileSync(path.join(sb.orch, 'rules.json'), JSON.stringify({ rules_version: 1, ...user }));
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), orch: { approval_policy: { plan: 'auto', ...ap } } });
  await drive(sb.engine(dir));
  return { dir, snap: readJSON(paths(dir).rules) };
};

test('R9: outside_allowlist "deny" removes unknown_command from ask_on (a tightening, nothing listed)', async (t) => {
  const { dir, snap } = await run(t, { outside_allowlist: 'deny' });
  assert.equal(goalOf(dir).status, 'achieved');
  assert.deepEqual(snap.compiled.worker.bash.ask_on, ['substitution', 'unparsed']);
  assert.deepEqual(snap.policy.bash.ask_on, ['substitution', 'unparsed']);
  assert.equal(snap.loosenings.some((l) => l.path === 'worker.bash.ask_on'), false);
});

test('R9: it never adds back what a user layer removed', async (t) => {
  const { snap } = await run(t, { outside_allowlist: 'deny' }, { worker: { bash: { ask_on: ['unknown_command', 'unparsed'] } } });
  assert.deepEqual(snap.compiled.worker.bash.ask_on, ['unparsed']);
});

test('R9: "ask" is the default (no change); dead values are reported as deprecated and the goal still loads', async (t) => {
  const { dir, snap } = await run(t, { outside_allowlist: 'allow', dangerous: 'allow', whatever: 1 });
  assert.equal(goalOf(dir).status, 'achieved');
  assert.deepEqual(snap.compiled.worker.bash.ask_on, ['substitution', 'unparsed', 'unknown_command']);
  const ev = readEvents(dir).find((e) => e.type === 'orch.rules.deprecated');
  assert.equal(ev.data.notes.length, 3); assert.ok(ev.data.notes.every((n) => n.startsWith('deprecated: ')));
  const d = await run(t, {}); assert.ok(!readEvents(d.dir).some((e) => e.type === 'orch.rules.deprecated'), 'defaults report nothing');
});

test('R9 unit: goalLegacyRules flags denyUnknown only for "deny"', () => {
  assert.equal(goalLegacyRules({ orch: { approval_policy: { outside_allowlist: 'deny' } }, budget: {} }).denyUnknown, true);
  assert.equal(goalLegacyRules({ orch: { approval_policy: { outside_allowlist: 'ask', dangerous: 'deny' } }, budget: {} }).denyUnknown, false);
});
