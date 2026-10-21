// A grep pattern starting with "-" is read as an option, so the check fails on every run (found by the real evals: the drafter wrote
// grep -qx "- add retry to the fetcher" CHANGELOG.md and both attempts failed). The draft and plan validators refuse it with a fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { argvProblem } from '../lib/checks.mjs';
import { validateDraft } from '../lib/draft.mjs';
import { validatePlan } from '../lib/plan.mjs';
import { compileRules } from '../lib/rules.mjs';

test('argvProblem: a leading-dash grep pattern is flagged; -e, --, flags and other commands are fine', () => {
  assert.match(argvProblem(['grep', '-qx', '- add retry to the fetcher', 'CHANGELOG.md']), /starts with "-".*-e/);
  assert.match(argvProblem(['/usr/bin/grep', '-q', '-- x', 'F']), /starts with "-"/);
  for (const ok of [['grep', '-qx', '-e', '- add retry', 'F'], ['grep', '-q', '--', '- add', 'F'], ['grep', '-q', 'Usage', 'README.md'], ['grep', '-qE', '^## 1', 'F'],
    ['grep', '--count', 'x', 'F'], ['rg', '-q', 'x', 'F'], ['node', '--test'], ['test', '-f', 'a b'], ['grep', '-q', 'x', '- file']]) assert.equal(argvProblem(ok), null, ok.join(' '));
});

test('validateDraft and validatePlan refuse the leading-dash pattern', () => {
  const compiled = compileRules([{ layer: 'user', rules: { rules_version: 1, checks: { allowlist: [{ id: 'grep', cmd: 'grep' }] } } }]).compiled;
  const bad = ['grep', '-qx', '- add retry', 'CHANGELOG.md'];
  const d = validateDraft({ title: 'T', description: 'D', success_criteria: [{ id: 'a', text: 'bullet', check: { argv: bad, timeout_s: 30 } }, { id: 'b', text: 'file', check: { argv: ['grep', '-q', 'x', 'CHANGELOG.md'], timeout_s: 30 } }] }, { compiled });
  assert.equal(d.ok, false); assert.ok(d.errors.some((e) => /starts with "-"/.test(e)), d.errors.join('\n'));
  const p = validatePlan({ tasks: [{ id: 't1', title: 'T', description: 'D', depends_on: [], model_tier: 'haiku', path_scope: ['CHANGELOG.md'], allowed_commands: [], checks: [{ argv: bad, timeout_s: 30 }], output_contract: 'o', acceptance: ['a'] }] }, { check_allowlist: ['grep'] });
  assert.equal(p.ok, false); assert.ok(p.errors.some((e) => /starts with "-"/.test(e)), p.errors.join('\n'));
});
