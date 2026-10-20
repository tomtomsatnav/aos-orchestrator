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

test('S2: snapshotHash covers inputs and layers; recompileSnapshot refuses inputs that goal.json did not record', async () => {
  const { snapshotHash } = await import('../lib/rules.mjs');
  const { recompileSnapshot } = await import('../lib/rules-store.mjs');
  const { sha256 } = await import('../lib/plan.mjs'); const { canonical } = await import('../lib/plan.mjs');
  const layers = [{ layer: 'repo', rules: R({ worker: { bash: { allow: [{ id: 'sortu', cmd: 'sort' }] } } }), source: 'r' }];
  const comp = compileRules(layers);
  const snap = buildRulesSnapshot(comp, layers);
  const h = snapshotHash(snap);
  const t1 = structuredClone(snap); t1.inputs[0].rules.budgets = { max_usd: 1 };
  assert.notEqual(snapshotHash(t1), h, 'inputs are covered');
  const t2 = structuredClone(snap); t2.layers[1].source = 'elsewhere';
  assert.notEqual(snapshotHash(t2), h, 'layers are covered');
  // the reviewer's probe: inputs and the snapshot's own layer hashes rewritten consistently; only goal.json still remembers the real ones
  const goal = { orch: { rules: { layers: snap.layers.map((l) => ({ layer: l.layer, sha12: l.sha256.slice(0, 12) })) }, repo_rules: { sha256: sha256(canonical(layers[0].rules)) } } };
  assert.equal(recompileSnapshot(snap, [], goal).ok, true);
  const forged = structuredClone(snap); forged.inputs[0].rules = R({ worker: { tools: { allow: ['Read', 'WebFetch'] } } }); forged.layers[1].sha256 = sha256(canonical(forged.inputs[0].rules));
  assert.equal(recompileSnapshot(forged, []).ok, true, 'self-consistent on its own');
  const r = recompileSnapshot(forged, [], goal); assert.equal(r.ok, false); assert.match(r.errors[0], /do not match/);
  assert.equal(recompileSnapshot(snap, [], { orch: { rules: goal.orch.rules, repo_rules: { sha256: 'f'.repeat(64) } } }).ok, false, 'repo_rules.sha256 is checked too');
});

test('S3: brace globs and root-relative deny globs bind (the reviewer probes)', async () => {
  const { evaluate, DEFAULT_POLICY, isProtectedRel } = await import('../lib/policy.mjs');
  const { globToRegex, matchGlob } = await import('../lib/glob.mjs');
  const pol = { ...DEFAULT_POLICY, paths: { ...DEFAULT_POLICY.paths, deny: [...DEFAULT_POLICY.paths.deny, '**/*.{js,mjs}', 'node_modules/**'] } };
  const ctx = { worktree: '/w', path_scope: ['**'], allowed_tools: ['Write'], grants: [] };
  const w = (f) => evaluate(pol, { tool_name: 'Write', tool_input: { file_path: f }, cwd: '/w' }, ctx);
  assert.equal(w('/w/lib/x.js').decision, 'deny'); assert.equal(w('/w/lib/x.mjs').decision, 'deny'); assert.equal(w('/w/node_modules/a.txt').decision, 'deny');
  assert.equal(w('/w/lib/x.ts').decision, 'allow'); assert.equal(w('/w/src/node_modules/a.txt').decision, 'allow', 'a relative glob is anchored at the worktree root');
  assert.equal(isProtectedRel(pol, 'node_modules/a.txt'), true); assert.equal(isProtectedRel(pol, 'lib/ok.txt'), false);
  assert.equal(globToRegex('a{b,c{d,e}}f').test('acef'), true); assert.equal(globToRegex('a{b').test('a{b'), true, 'unbalanced brace is a literal');
  assert.equal(matchGlob('src/*.{js,ts}', 'src/a.ts'), true); assert.equal(matchGlob('[ab].js', 'b.js'), true); assert.equal(matchGlob('[!a].js', 'a.js'), false);
  assert.equal(validateRules(R({ worker: { paths: { deny: [{ id: 'x', glob: '{a,b}{a,b}{a,b}{a,b}{a,b}' }] } } })).ok, false, 'a regex-expensive glob is refused');
  assert.equal(validateRules(R({ worker: { paths: { deny: [{ id: 'x', glob: '**/*.{js,mjs}' }] } } })).ok, true);
});

test('S4: scope checks fold case/NFKC, expand braces, sample inside [] classes; scope_deny is enforced at run time', async () => {
  const { scopeHitsDeny, expandBraces } = await import('../lib/glob.mjs');
  const { evaluate } = await import('../lib/policy.mjs');
  const { toPolicy } = await import('../lib/rules.mjs');
  assert.deepEqual(expandBraces('a{b,c{d,e}}f').sort(), ['abf', 'acdf', 'acef']);
  assert.equal(scopeHitsDeny('Certs/Server.PEM', '**/*.pem'), true, 'case');
  assert.equal(scopeHitsDeny('ｓecrets/**', 'secrets/**'), true, 'NFKC (fullwidth s)');
  assert.equal(scopeHitsDeny('lib/{a,b}/x.txt', 'lib/b/**'), true, 'brace in the scope');
  assert.equal(scopeHitsDeny('lib/b/x.txt', '{lib,src}/b/**'), true, 'brace in the deny');
  assert.equal(scopeHitsDeny('[ab]/x.txt', 'b/**'), true, 'class sample (b, not x)');
  assert.equal(scopeHitsDeny('docs/*.md', 'secrets/**'), false);
  assert.equal(scopeHitsDeny('lib/{a,b}/x.txt', 'lib/c/**'), false);
  // run time: the hook policy carries scope_deny; a write that matches it is denied even inside path_scope
  const comp = compileRules([{ layer: 'user', rules: R({ plan: { scope_deny: [{ id: 'lock', glob: 'package-lock.json' }, { id: 'keys', glob: '**/*.{pem,key}' }] } }) }]);
  const pol = toPolicy(comp.compiled); assert.deepEqual(pol.paths.scope_deny, ['package-lock.json', '**/*.{pem,key}']);
  const ctx = { worktree: '/w', path_scope: ['**'], allowed_tools: ['Write'], grants: [] };
  const w = (f) => evaluate(pol, { tool_name: 'Write', tool_input: { file_path: f }, cwd: '/w' }, ctx);
  assert.equal(w('/w/package-lock.json').decision, 'deny'); assert.equal(w('/w/package-lock.json').rule, 'scope_denied');
  assert.equal(w('/w/a/b/server.KEY').decision, 'deny'); assert.equal(w('/w/a/b/ok.txt').decision, 'allow');
  assert.deepEqual(toPolicy(compileRules([]).compiled).paths.scope_deny, undefined, 'no scope_deny key by default: the default policy is unchanged');
});
