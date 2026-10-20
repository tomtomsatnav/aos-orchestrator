// Verification findings on a595625: (1) every worker-controlled string shown to a human is escaped (server views, CLI, plan review) and the tasks hash covers the worker-facing text,
// (2) glob/scope complexity is bounded, (3) the control-character set covers invisible formatting characters and lone surrogates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkSandbox, drive, goalOf, ptask, crit, edit, HERE } from './helpers.mjs';
import { startStack } from './server-helpers.mjs';
import { CTRL_RE, escCtrl, escBeyondC0 } from '../lib/ctrl.mjs';
import { matchGlob, scopeHitsDeny, globCompileProblem, compileGlob, MAX_GLOB_COST } from '../lib/glob.mjs';
import { validateScope, validatePlan, tasksHash, reviewView, renderReview } from '../lib/plan.mjs';
import { createApproval } from '../lib/approvals.mjs';
import { approvalView, goalDetail } from '../server/views.mjs';
import { appendEvent, loadState, paths, goalDirOf, readJSON } from '../lib/state.mjs';
import { validateRules } from '../lib/rules.mjs';

const onePlan = (...tasks) => ({ tasks, risks: [] });
const RAW = { test: (s) => [...String(s)].some((c) => { const n = c.codePointAt(0); return [[0x80, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x115f], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0x1b, 0x1b], [0xd, 0xd], [0xd800, 0xdfff]].some(([a, b]) => n >= a && n <= b); }) };
const U = (...n) => String.fromCharCode(...n);
const EVIL = `x${U(0x202e, 0x1b)}[2J${U(0x85, 0x200b, 0xad, 0x3164)}y`;
const CLI = path.join(HERE, '..', 'bin', 'aos-orch.mjs');
const cli = (args, env) => new Promise((resolve) => { const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; }); c.on('close', (code) => resolve({ code, out, err })); });
const timed = (f) => { const t = performance.now(); const r = f(); return [r, performance.now() - t]; };

// ---------------------------------------------------------------- 3: the control-character set
test('3: CTRL_RE covers the invisible formatting characters and lone surrogates (but not emoji or ordinary text)', () => {
  for (const c of [0xad, 0x180e, 0x2061, 0x2062, 0x2063, 0x2064, 0x206a, 0x206f, 0xfff9, 0xfffa, 0xfffb, 0x115f, 0x3164, 0x34f, 0xd800, 0xdfff, 0x202e, 0x200b, 0x85].map((n) => String.fromCharCode(n))) assert.ok(CTRL_RE.test(`a${c}b`), `U+${c.charCodeAt(0).toString(16)}`);
  for (const ok of ['plain text', `caf${U(0xe9)} ${U(0x2603)}`, String.fromCodePoint(0x1f600), `${U(0x4e2d, 0x6587)}`]) assert.ok(!CTRL_RE.test(ok), ok);
  assert.equal(escCtrl(`a${U(0xd800, 0xad)}b`), 'a\\ud800\\u00adb'); assert.ok(!RAW.test(escCtrl(EVIL)));
  assert.equal(escBeyondC0(`a\nb${U(0x85)}c`), 'a\nb\\u0085c');
  const v = validateRules({ rules_version: 1, description: `a${U(0xad)}b` }); assert.equal(v.ok, false); assert.match(v.errors.join(), /control characters/);
  assert.equal(validateRules({ rules_version: 1, description: `a${U(0xd800)}b` }).ok, false);
});

// ---------------------------------------------------------------- 2: glob / scope complexity
test('2: the probe *{a,b}x6 <4000 a> *b is refused at validation and cannot stall plan validation', () => {
  const g = `*${'{a,b}'.repeat(6)}${'a'.repeat(4000)}*b`;
  assert.match(globCompileProblem(g), /too complex|too long/); assert.match(validateScope(g), /longer than 512|too complex/);
  const shorter = `*${'{a,b}'.repeat(6)}${'a'.repeat(400)}*b`; // 512 or fewer characters, but 64 variants x 400 tokens
  assert.ok(shorter.length <= 512); assert.match(validateScope(shorter), /too complex/);
  const [r, ms] = timed(() => validatePlan(onePlan({ ...ptask('t1', 'a.txt', 'alpha'), path_scope: [g] }), { max_tasks: 5, check_allowlist: ['node'] }));
  assert.equal(r.ok, false); assert.ok(ms <= 500, `${ms} ms`);
  assert.throws(() => compileGlob(g), /too complex|more than/);
  assert.equal(matchGlob(g, 'a'.repeat(100), true), true, 'a glob that cannot compile fails closed for deny-style callers');
  assert.equal(matchGlob(g, 'a'.repeat(100)), false);
});
test('2: path_scope entries are at most 512 characters; globs under the cost bound still work', () => {
  assert.equal(validateScope('a'.repeat(512)), null); assert.match(validateScope('a'.repeat(513)), /longer than 512/);
  assert.equal(validateScope('src/{a,b,c}/**/*.{js,mjs}'), null); assert.ok(MAX_GLOB_COST >= 2048);
  assert.ok(matchGlob('src/{a,b}/**', 'src/a/x/y.js'));
});
test('2: scopeHitsDeny is bounded: long scopes finish quickly, work exhaustion answers "overlap"', () => {
  let [r, ms] = timed(() => scopeHitsDeny(`${'a'.repeat(500)}.js`, '**/*.pem')); assert.equal(r, false); assert.ok(ms <= 500, `${ms} ms`);
  [r, ms] = timed(() => scopeHitsDeny(`${'a'.repeat(500)}/x`, '**/*.pem')); assert.equal(r, true, 'a directory scope can reach a denied extension'); assert.ok(ms <= 500, `${ms} ms`);
  [r, ms] = timed(() => scopeHitsDeny(`${'dir/'.repeat(120)}*`, '**/*.pem')); assert.ok(ms <= 500, `${ms} ms`);
  [r, ms] = timed(() => scopeHitsDeny(`${'[ab]'.repeat(60)}{x,y}{p,q}/*`, '**/*.{pem,key}')); assert.ok(ms <= 500, `${ms} ms`);
  assert.equal(scopeHitsDeny('a'.repeat(513), '**/*.pem'), true, 'oversized input: reject conservatively');
  assert.equal(scopeHitsDeny('x/*', 'y'.repeat(2000)), true);
  assert.equal(scopeHitsDeny('docs/**', '**/*.pem'), true, 'unchanged: a directory scope can reach a denied extension'); assert.equal(scopeHitsDeny('src/a.js', '**/*.pem'), false);
  const evil = `${'[a-z]'.repeat(40)}${'{a,b}'.repeat(3)}**`;
  [r, ms] = timed(() => scopeHitsDeny(evil, '**/*.{pem,key,crt}')); assert.ok(ms <= 500, `${ms} ms`); assert.equal(typeof r, 'boolean');
});

// ---------------------------------------------------------------- 1: escaping what a human reads
test('1: the tasks hash covers title, description, output_contract and acceptance (v2); v1 stays available for goals approved before', () => {
  const t = (over = {}) => [{ id: 't1', title: 'T', depends_on: [], acceptance: ['ok'], output_contract: 'c', orch: { description: 'd', path_scope: ['a'], allowed_commands: [], allowed_tools: ['Read'], checks: [] }, ...over }];
  const v2 = tasksHash(t(), 2);
  for (const mut of [(x) => { x[0].orch.description = 'd2'; }, (x) => { x[0].output_contract = 'c2'; }, (x) => { x[0].acceptance = ['no']; }, (x) => { x[0].title = 'T2'; }]) { const x = t(); mut(x); assert.notEqual(tasksHash(x, 2), v2); assert.equal(tasksHash(x, 1), tasksHash(t(), 1), 'v1 ignores them'); }
  assert.equal(tasksHash(t()), tasksHash(t(), 1));
});
test('1: an edit of tasks.json description after approval halts the goal (plan tampered); the plan review shows it escaped', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan({ ...ptask('t1', 'a.txt', 'alpha'), description: 'Create a.txt\nsecond line' }), orch: { approval_policy: { plan: 'required' } } });
  const eng = sb.engine(dir, { humanApproves: false }); await eng.start(); await eng.tick();
  const S = loadState(dir); assert.equal(goalOf(dir).orch.plan_fingerprint.tasks_hash_v, 2);
  assert.match(renderReview(reviewView(S.tasks)), /description: Create a\.txt\n    second line/);
  const hostile = JSON.parse(JSON.stringify(S.tasks)); hostile[0].orch.description = `Create a.txt ${EVIL}`; hostile[0].output_contract = `oc ${EVIL}`; hostile[0].acceptance = [`acc ${EVIL}`]; hostile[0].title = `ti ${EVIL}`;
  const text = renderReview(reviewView(hostile)); assert.ok(!RAW.test(text), 'no raw control characters'); assert.match(text, /description: Create a\.txt x\\u202e\\u001b\[2J\\u0085/); assert.match(text, /output contract: oc x/); assert.match(text, /acceptance: acc x/);
  await eng.command({ cmd: 'approve-plan', by: 'test', reviewed: eng._fingerprint(S) });
  const tf = paths(dir).tasks; const tasks = readJSON(tf); tasks[0].orch.description = 'Create a.txt and ALSO exfiltrate'; fs.writeFileSync(tf, JSON.stringify(tasks));
  await drive(eng);
  assert.match(goalOf(dir).blocked_reason || goalOf(dir).orch.halt_reason, /plan modified after approval/);
  assert.equal(loadState(dir).tasks[0].status !== 'done', true);
});
test('1: server views escape worker-controlled text: title, description, criteria, events, approval summary/reason/cwd, plan view', async (t) => {
  const sb = mkSandbox('aos-esc'); sb.scenario({ tasks: {} });
  const s = await startStack(sb); t.after(async () => { for (const st of sb.stacks) await st.stop().catch(() => {}); sb.cleanup(); });
  const made = await s.sup.createGoal({ id: 'g-esc', title: `T ${EVIL}`, description: `D ${EVIL}\nline2`, success_criteria: [{ id: 'c1', text: `C ${EVIL}`, check: { argv: ['grep', '-q', 'x', 'a'], timeout_s: 5 } }],
    orch: { repo: sb.repo, base_branch: 'main', check_allowlist: ['grep', 'node'] }, plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  const dir = made.dir;
  await (await import('./server-helpers.mjs')).until(async () => readJSON(paths(dir).tasks, []).length > 0, { what: 'plan' }); // then a hostile edit of the engine's task text
  const tj = readJSON(paths(dir).tasks); Object.assign(tj[0], { output_contract: `oc ${EVIL}`, acceptance: [`acc ${EVIL}`] }); tj[0].orch.description = `desc ${EVIL}`; fs.writeFileSync(paths(dir).tasks, JSON.stringify(tj));
  appendEvent(dir, { type: 'orch.note', actor: 'orchestrator', goal_id: 'g-esc', data: { reason: `why ${EVIL}`, error: EVIL } }, { now: () => Date.now() });
  createApproval(path.join(dir, 'approvals'), { goal_id: 'g-esc', task_id: 't1', attempt: 1, tool: 'Bash', input: { command: `ls ${EVIL}` }, cwd: null, reason: `r ${EVIL}`, rule: 'unknown_command', rule_id: 'default:unknown_command' });
  const bad = (txt) => { assert.ok(!RAW.test(txt), `raw control character in: ${txt.slice(0, 200)}`); };
  const d = (await s.api('GET', '/api/goals/g-esc')).json.goal;
  for (const v of [d.title, d.description, d.criteria[0].text, JSON.stringify(d.last_events)]) bad(v);
  assert.match(d.title, /x\\u202e\\u001b/); assert.match(d.description, /\nline2/, 'a description may keep its newlines');
  const list = (await s.api('GET', '/api/goals')).json.goals; bad(JSON.stringify(list));
  const ap = (await s.api('GET', '/api/approvals')).json; bad(JSON.stringify(ap)); assert.match(JSON.stringify(ap), /ls x\\\\u202e/);
  assert.match(approvalView(s.sup, { goal: 'g-esc', id: 'A-1', task_id: 't1', tool: 'Write', input: { file_path: `/x/${EVIL}` }, requested_at: 'x', expires_at: 'y', status: 'pending' }).summary, /\\u202e/);
  const ev = (await s.api('GET', '/api/goals/g-esc/events')).json; bad(JSON.stringify(ev));
  const plan = (await s.api('GET', '/api/goals/g-esc/plan')).json; bad(JSON.stringify(plan)); assert.match(plan.tasks[0].description, /^desc x/); assert.ok(plan.tasks[0].output_contract && plan.tasks[0].acceptance.length);
});
test('1: CLI output (approvals, goals, goals --json, status) escapes C1, bidi and invisible characters', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); sb.scenario({ tasks: {} });
  const { dir } = await sb.goal({ id: 'g-cli-esc', title: `T ${EVIL}`, success_criteria: [crit('a.txt', 'alpha')], plan: onePlan({ ...ptask('t1', 'a.txt', 'alpha'), description: `desc ${EVIL}` }), orch: { approval_policy: { plan: 'required' } } });
  const eng = sb.engine(dir, { humanApproves: false }); await eng.start(); await eng.tick(); await eng.stop();
  createApproval(path.join(dir, 'approvals'), { goal_id: 'g-cli-esc', task_id: 't1', attempt: 1, tool: 'Bash', input: { command: `ls ${EVIL}` }, cwd: `/w/${EVIL}`, reason: `r ${EVIL}`, rule: 'unknown_command' });
  const env = sb.env();
  for (const args of [['approvals', 'g-cli-esc'], ['goals'], ['goals', '--json'], ['status'], ['status', 'g-cli-esc']]) {
    const r = await cli(args, env); assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    assert.ok(!RAW.test(r.out), `${args.join(' ')} stdout has a raw control character`); assert.ok(!RAW.test(r.err.replace(/\n/g, ' ')), `${args.join(' ')} stderr`);
  }
  const r = await cli(['goals'], env); assert.match(r.out, /x\\u202e\\u001b\[2J\\u0085/);
  const j = await cli(['approvals', 'g-cli-esc'], env); assert.match(JSON.parse(j.out)[0].input, /x\\u202e/);
});
