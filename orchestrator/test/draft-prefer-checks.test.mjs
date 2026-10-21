// The drafter is told to prefer checks over "verify":"human" (most small eval goals stopped for a sign-off a check could do), and is
// pointed at grep only when grep is on the allowlist (node-library has no grep: the advice alone made drafts fail).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftPrompt } from '../lib/draft.mjs';
import { compileRules } from '../lib/rules.mjs';

const prompt = (cmds) => buildDraftPrompt({ request: 'x', facts: { files: [], make_targets: [] }, compiled: compileRules([{ layer: 'user', rules: { rules_version: 1, checks: { allowlist: cmds.map((cmd, i) => ({ id: `a${i}`, cmd })) } } }]).compiled });

test('draft prompt: prefer checks; suggest grep only when it is allowed; no criterion for protected tests', () => {
  const withGrep = prompt(['grep', 'node --test']); const noGrep = prompt(['node --test']);
  for (const p of [withGrep, noGrep]) { assert.match(p, /Prefer a check/); assert.match(p, /do NOT add a criterion that they are unchanged/); }
  assert.match(withGrep, /use grep \(for example/);
  assert.doesNotMatch(noGrep, /use grep \(for example/);
});
