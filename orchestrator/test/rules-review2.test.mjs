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
  const { compileGlob: globToRegex, matchGlob } = await import('../lib/glob.mjs');
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

test('S5: plan-time allowed_commands are judged by the worst of the default and the goal policy', async () => {
  const { validatePlan } = await import('../lib/plan.mjs');
  const { DEFAULT_POLICY } = await import('../lib/policy.mjs');
  const weak = { ...DEFAULT_POLICY, bash: { ...DEFAULT_POLICY.bash, deny_patterns: [], deny: [] } }; // a legacy goal policy that dropped the default deny patterns
  const t = { ...ptask('t1', 'a.txt', 'alpha'), allowed_commands: ['grep "| sh" a.txt'] };
  const run = (policy) => validatePlan({ tasks: [t] }, { max_tasks: 12, check_allowlist: ['node'], ...(policy ? { policy } : {}) });
  assert.equal(run().ok, false, 'the default denies it');
  const r = run(weak); assert.equal(r.ok, false, 'a weaker goal policy cannot make it pass'); assert.match(r.errors.join(' '), /dangerous_pattern/);
});

// ---- engine-level helpers
import { paths, readJSON, loadState, readEvents } from '../lib/state.mjs';
import { normalizeGoalSpec } from '../lib/state.mjs';
import { compileGoal } from '../lib/rules-store.mjs';
const onePlan = (...tasks) => ({ tasks, risks: [] });
const commitRules = (sb, rules) => {
  fs.mkdirSync(path.join(sb.repo, '.aos'), { recursive: true });
  fs.writeFileSync(path.join(sb.repo, '.aos', 'rules.json'), JSON.stringify(rules));
  git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-q', '-m', 'rules');
};
async function parked(sb, spec = {}) {
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const g = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), ...spec, orch: { approval_policy: { plan: 'required' }, ...(spec.orch || {}) } });
  const eng = sb.engine(g.dir, { humanApproves: false }); await eng.start(); await eng.tick();
  return { ...g, eng };
}

test('S6a: an explicit goal value equal to the default still caps; it never raises a tighter user layer', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const compileWith = (userRules, budget) => {
    fs.writeFileSync(path.join(sb.orch, 'rules.json'), JSON.stringify(R(userRules)));
    const goal = normalizeGoalSpec({ title: 'g', success_criteria: [crit('a.txt', 'alpha')], budget, orch: { repo: sb.repo } });
    const r = compileGoal({ orchDir: sb.orch, goal, dir: sb.root }); assert.equal(r.ok, true, JSON.stringify(r.errors)); return r.snap.compiled;
  };
  // the probe: the user layer raises the cap to 20, the goal says max_usd 5 explicitly (= the default): the goal's 5 must win
  assert.equal(compileWith({ budgets: { max_usd: 20 } }, { max_usd: 5 }).budgets.max_usd, 5);
  // without an explicit value the user's 20 stands
  assert.equal(compileWith({ budgets: { max_usd: 20 } }, {}).budgets.max_usd, 20);
  // an explicit default does not undo a tighter user layer
  assert.equal(compileWith({ budgets: { max_usd: 2 } }, { max_usd: 5 }).budgets.max_usd, 2);
});

test('S6b: accepting a repo loosening does not undo a human budget patch made before approval', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  commitRules(sb, R({ checks: { localhost_ports: [8080] }, budgets: { max_usd: 4 } }));
  const { dir, eng } = await parked(sb, { budget: { max_ticks: 500, max_usd: 5, max_wall_clock_s: 7200 } });
  assert.equal(goalOf(dir).budget.max_usd, 4);
  await eng.command({ cmd: 'budgets', by: 'test', patch: { max_usd: 1, max_parallel: 1 } });
  assert.equal(goalOf(dir).budget.max_usd, 1);
  const id = readJSON(paths(dir).rules).dropped[0].rule_id;
  await eng.command({ cmd: 'accept-repo-loosening', by: 'test', ids: [id] });
  const g = goalOf(dir);
  assert.deepEqual(readJSON(paths(dir).rules).compiled.checks.localhost_ports, [8080], 'the acceptance applied');
  assert.equal(g.budget.max_usd, 1, 'the patch survived'); assert.equal(g.orch.budgets.max_parallel, 1);
  const sm = (await import('../lib/rules-store.mjs')).readRulesSummary(dir, g);
  assert.equal(sm.limits.max_usd, 1, 'the summary shows what is enforced, not the pre-patch snapshot value'); assert.equal(sm.limits.max_parallel, 1);
});

test('S7: an applied repo loosening forces human plan review even when plan.approval is auto', async (t) => {
  const run = async (loosening) => {
    const sb = mkSandbox(); t.after(() => sb.cleanup());
    commitRules(sb, R({ checks: { localhost_ports: [8080] } }));
    const id = `repo:checks.localhost_ports.8080@${bindHash(8080)}`;
    const grepTask = { ...ptask('t1', 'a.txt', 'alpha'), checks: [{ argv: ['grep', '-qx', 'alpha', 'a.txt'], timeout_s: 30 }] }; // a plan that auto-approval would accept
    const { dir } = await parked(sb, { plan: onePlan(grepTask), orch: { approval_policy: { plan: 'auto' }, ...(loosening ? { accept_repo_loosening: [id] } : {}) } });
    return dir;
  };
  const a = await run(true);
  assert.equal(goalOf(a).orch.plan_state, 'awaiting_approval', 'accepted loosening: parked for a human');
  assert.ok(readEvents(a).some((e) => e.type === 'orch.plan.approval_required' && /repo rule loosening/.test(e.data.reason)));
  const b = await run(false);
  assert.notEqual(goalOf(b).orch.plan_state, 'awaiting_approval', 'nothing applied from the repo: auto still works');
});

test('S8: one evaluate() call has a total regex time budget (deny floor:regex_budget); the hook wait shrinks by the time already used', async () => {
  const { evaluate, DEFAULT_POLICY, REGEX_BUDGET_MS } = await import('../lib/policy.mjs');
  const { remainingWaitMs } = await import('../lib/policy-hook.mjs');
  assert.equal(REGEX_BUDGET_MS, 1000);
  const many = Array.from({ length: 40 }, (_, i) => `zzz${i}qqq`); // 40 cheap, valid user patterns that never match
  const pol = { ...DEFAULT_POLICY, bash: { ...DEFAULT_POLICY.bash, deny_patterns: [...DEFAULT_POLICY.bash.deny_patterns, ...many] } };
  const call = { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/w' };
  const ctx = { worktree: '/w', path_scope: [], allowed_tools: ['Bash'], grants: [] };
  assert.equal(evaluate(pol, call, ctx).decision, 'allow', 'with the real clock the cheap patterns are well inside the budget');
  // a clock in which every pattern "takes" 300 ms: the fourth pattern exhausts the budget
  let t = 0; const slow = { ...ctx, now: () => (t += 150) };
  const v = evaluate(pol, call, slow);
  assert.equal(v.decision, 'deny'); assert.equal(v.rule, 'regex_budget'); assert.equal(v.rule_id, 'floor:regex_budget');
  // the hook: 20 s wait, 4 s already spent -> 16 s; more than the wait spent -> 0, never negative
  assert.equal(remainingWaitMs({ approval: { wait_in_hook_s: 20 } }, 4000), 16000);
  assert.equal(remainingWaitMs({ approval: { wait_in_hook_s: 20 } }, 60000), 0);
  assert.equal(remainingWaitMs({ approval: { wait_in_hook_s: 20 } }, -5), 20000);
});

test('nit: showBlob distinguishes an absent path (null) from git errors and oversize blobs (reject)', async (t) => {
  const { showBlob } = await import('../lib/git.mjs');
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  assert.equal(await showBlob(sb.repo, 'main', 'nope.txt'), null, 'absent');
  assert.equal((await showBlob(sb.repo, 'main', 'README.md')).toString(), '# fixture\n');
  await assert.rejects(() => showBlob(sb.repo, 'no-such-ref', 'README.md'), /failed/, 'a bad ref is an error, not "absent"');
  await assert.rejects(() => showBlob(path.join(sb.root, 'not-a-repo'), 'main', 'README.md'), /failed/);
  await assert.rejects(() => showBlob(sb.repo, 'main', 'README.md', { maxBytes: 4 }), /larger than 4 bytes/);
  // creation refuses a repo whose rules file cannot be read as opposed to treating it as absent
  fs.mkdirSync(path.join(sb.repo, '.aos')); fs.writeFileSync(path.join(sb.repo, '.aos', 'rules.json'), ' '.repeat(17 * 1024 * 1024)); git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-q', '-m', 'big');
  await assert.rejects(() => sb.goal({ success_criteria: [crit('a.txt', 'alpha')] }), /refusing repo .*cannot read its \.aos\/rules\.json/);
});

test('nit: a user rules.json with repo_config.trust false wins over trust_repo_config; the compiled value decides', async (t) => {
  const mk = async (userRules, trustFlag) => {
    const sb = mkSandbox(); t.after(() => sb.cleanup());
    fs.mkdirSync(path.join(sb.repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(sb.repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-q', '-m', 'cfg');
    if (userRules) fs.writeFileSync(path.join(sb.orch, 'rules.json'), JSON.stringify(userRules));
    return sb.goal({ success_criteria: [crit('a.txt', 'alpha')], orch: { trust_repo_config: trustFlag } });
  };
  await assert.rejects(() => mk(null, false), /refusing repo/, 'no trust: refused');
  const ok = await mk(null, true); assert.equal(goalOf(ok.dir).orch.trust_repo_config, true, 'the flag alone still works');
  await assert.rejects(() => mk(R({ repo_config: { trust: false } }), true), /compiled rules forbid it/, 'the user layer forbids: the flag is ignored and the repo refused');
  const u = await mk(R({ repo_config: { trust: true } }), false); assert.equal(goalOf(u.dir).orch.trust_repo_config, true, 'a user layer may grant it');
});

test('nit: the summary lists the success-criteria check argv; a dropped __proto__ key is reported', async (t) => {
  const { summarizeRules, renderRulesSummary: render, policyToRules } = await import('../lib/rules.mjs');
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const { dir } = await parked(sb);
  const { renderRulesFor } = await import('../lib/rules-store.mjs');
  assert.match(renderRulesFor(dir, goalOf(dir)), /success-criteria checks \(1\): node -e /);
  const sm = summarizeRules(readJSON(paths(dir).rules)); assert.deepEqual(sm.checks.criteria, [], 'without a goal there is nothing to list');
  assert.match(render(sm), /checks:/);
  const poisoned = JSON.parse('{"__proto__": {"x": 1}, "bash": {"__proto__": {"allow": ["rm"]}, "allow": ["ls"]}}');
  const m = policyToRules(poisoned);
  assert.ok(m.notes.some((n) => /policy\.__proto__ is not a rule.*never applied/.test(n)), m.notes.join('|'));
  assert.ok(m.notes.some((n) => /policy\.bash\.__proto__ is not a rule/.test(n)));
  assert.deepEqual(m.rules.worker.bash.allow.map((e) => e.cmd), ['ls']); assert.equal(({}).x, undefined);
});
