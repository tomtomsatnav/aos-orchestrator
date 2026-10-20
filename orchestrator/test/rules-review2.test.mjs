// Fixes for the Opus review of R5-R7 (docs/rules-design.md, Implementation notes "Review fixes after R5-R7"). One test per reviewer probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateRules, compileRules, bindHash, summarizeRules, renderRulesSummary, buildRulesSnapshot, DEFAULT_RULES } from '../lib/rules.mjs';
import { mkSandbox, git, goalOf, crit, ptask, edit } from './helpers.mjs';
import { createGoal } from '../lib/engine.mjs';

export const R = (o = {}) => ({ rules_version: 1, ...o });
const ESC = '\u001b';

test('B1: control characters and bidi overrides are rejected in every rules string', () => {
  const bad = ['\u001b[2J', 'a\rb', 'a\u0085b', 'a\u007fb', 'a‮b', 'a⁧b', 'a\u0000b', 'a\nb'];
  const places = (v) => [
    R({ worker: { bash: { allow: [{ id: 'x', cmd: `ls ${v}` }] } } }), R({ worker: { bash: { allow: [{ id: 'x', cmd: `ls`, description: v }] } } }),
    R({ worker: { bash: { deny: [{ id: 'x', cmd: `rm ${v}` }] } } }), R({ worker: { bash: { deny_patterns: [{ id: 'x', regex: `a${v}` }] } } }),
    R({ worker: { paths: { deny: [{ id: 'x', glob: `a/${v}` }] } } }), R({ worker: { paths: { read_extra: [{ id: 'x', glob: `a/${v}` }] } } }),
    R({ plan: { scope_deny: [{ id: 'x', glob: v }] } }), R({ checks: { allowlist: [{ id: 'x', cmd: `grep ${v}` }] } }), R({ plan: { auto_approvable_checks: [{ id: 'x', cmd: `grep ${v}` }] } }),
    R({ description: v }), R({ worker: { tools: { allow: [v] } } }),
  ];
  for (const v of bad) for (const r of places(v)) {
    const out = validateRules(r, { layer: 'repo' });
    assert.equal(out.ok, false, JSON.stringify(r)); assert.ok(out.errors.every((e) => !/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(e)), 'error text is plain');
  }
  // the second argv token (only the first was checked before)
  assert.equal(validateRules(R({ checks: { allowlist: [{ id: 'x', cmd: `grep -r ${ESC}[2J` }] } })).ok, false);
  // an id with an ESC fails its pattern, and the error does not echo the raw byte
  const bi = validateRules(R({ worker: { bash: { allow: [{ id: `x${ESC}`, cmd: 'ls' }] } } }));
  assert.equal(bi.ok, false); assert.ok(!bi.errors.join('').includes(ESC));
  assert.equal(validateRules(R({ worker: { bash: { allow: [{ id: 'ok', cmd: 'grep -r héllo' }] } } })).ok, true, 'ordinary non-ASCII text is fine');
});

test('B1: the renderer JSON-quotes any non-plain value even if one reaches the snapshot (defence in depth)', () => {
  const comp = compileRules([]);
  comp.compiled.worker.bash.allow.push({ id: 'evil', cmd: `ls${ESC}[2J${ESC}[H\rAPPROVED` });
  comp.compiled.plan.scope_deny.push({ id: 'g', glob: 'a‮b' });
  const snap = buildRulesSnapshot({ ...comp, loosenings: [{ layer: 'repo', rule_id: 'repo:x\u0085', path: 'p', from: null, to: `z${ESC}` }], dropped: [] }, []);
  snap.policy.bash.allow.unshift(`ls${ESC}[2J\rAPPROVED`); snap.notes = [`n${ESC}[2J`];
  const text = renderRulesSummary(summarizeRules(snap));
  assert.ok(!/[\u001b\r\u0085‮]/.test(text), 'no raw control characters');
  assert.match(text, /"ls\\u001b\[2J\\r/); assert.match(text, /\\u001b/);
});

test('S1: acceptance ids carry >= 128 bits of the content hash', () => {
  assert.match(bindHash('x'), /^[0-9a-f]{32}$/);
  const c = compileRules([{ layer: 'repo', rules: R({ budgets: { max_usd: 50 } }) }]);
  assert.match(c.dropped[0].rule_id, /@[0-9a-f]{32}$/);
});

test('S1: accepting a repo loosening at creation prints the FULL content of it', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  fs.mkdirSync(path.join(sb.repo, '.aos'), { recursive: true });
  const cmd = 'sort -u --very-long-option-that-would-be-truncated-by-a-short-display-form';
  fs.writeFileSync(path.join(sb.repo, '.aos', 'rules.json'), JSON.stringify(R({ worker: { bash: { allow: [{ id: 'sortu', cmd }] } } })));
  git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-q', '-m', 'rules');
  const id = `repo:worker.bash.allow.sortu@${bindHash(cmd)}`;
  const made = await createGoal(sb.orch, { title: 'g', description: 'd', success_criteria: [crit('a.txt', 'alpha')], orch: { repo: sb.repo, base_branch: 'main', accept_repo_loosening: [id] } });
  const n = made.notices.find((x) => x.startsWith('ACCEPTED repo loosening'));
  assert.ok(n, made.notices.join('\n')); assert.ok(n.includes(id)); assert.ok(n.includes(cmd), 'full content');
});
