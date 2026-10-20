import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkSandbox, drive, git, types, goalOf, tasksOf, assertValidState, sleep, procsAlive, FAKE, HERE } from './helpers.mjs';
import { readEvents, paths, readJSON } from '../lib/state.mjs';

const SCEN = (f) => JSON.parse(fs.readFileSync(path.join(HERE, 'scenarios', f), 'utf8'));
// criteria: all three files hold their words (checked on the integration branch)
const ALL3 = { id: 'c1', text: 'a, b and c present', check: { argv: ['node', '-e', "const f=require('fs');for(const [n,w] of [['a.txt','alpha'],['b.txt','beta'],['c.txt','gamma']])if(f.readFileSync(n,'utf8').trim()!==w)process.exit(1)"], timeout_s: 30 } };

test('happy path: 3-task DAG, merged into the integration branch, report, base branch untouched', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario(SCEN('all-success-3-tasks.json'));
  const baseBefore = git(sb.repo, 'rev-parse', 'main');
  const { dir } = await sb.goal({ success_criteria: [ALL3] });
  const eng = sb.engine(dir);
  await eng.start();
  await drive(eng);
  const g = goalOf(dir);
  assert.equal(g.status, 'achieved', JSON.stringify(g.blocked_reason));
  assert.deepEqual(tasksOf(dir).map((x) => x.status), ['done', 'done', 'done']);
  // base branch untouched, integration holds all three files, merged with --no-ff
  assert.equal(git(sb.repo, 'rev-parse', 'main'), baseBefore);
  assert.equal(git(sb.repo, 'status', '--porcelain'), '');
  const integ = 'aos/g-test/integration';
  assert.equal(git(sb.repo, 'show', `${integ}:a.txt`), 'alpha');
  assert.equal(git(sb.repo, 'show', `${integ}:c.txt`), 'gamma');
  assert.equal(git(sb.repo, 'log', '--merges', '--oneline', integ).split('\n').length, 3);
  // t3 started only after t1 and t2 were merged (dependency order)
  const ev = readEvents(dir);
  const idx = (type, task) => ev.findIndex((e) => e.type === type && e.task_id === task);
  assert.ok(idx('orch.integrate.merged', 't1') < idx('task.started', 't3') && idx('orch.integrate.merged', 't2') < idx('task.started', 't3'));
  // worktrees cleaned, report written with usage
  assert.equal(git(sb.repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  const report = fs.readFileSync(paths(dir).report, 'utf8');
  assert.match(report, /status: \*\*achieved\*\*/); assert.match(report, /new tokens: [1-9]/); assert.match(report, /git .*merge --no-ff aos\/g-test\/integration/);
  assert.ok(g.orch.usage.new_tokens > 0);
  assert.equal(procsAlive(dir).length, 0);
  assertValidState(assert, dir);
});

// ---------------------------------------------------------------------------------------------------------------
import { chk, ptask, crit, edit, fakeCalls, worktreesOf, fakeClock, allowAllHook } from './helpers.mjs';
import { listApprovals, decide } from '../lib/approvals.mjs';
import { acquireLock, releaseLock } from '../lib/state.mjs';
import { Engine } from '../lib/engine.mjs';

const onePlan = (...tasks) => ({ tasks, risks: [] });

test('retry on failed checks, escalate to the next tier, check output goes into the next prompt', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ behavior: 'fail_checks', edits: [{ path: 'a.txt', content: 'WRONG\n' }] }, edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  await drive(sb.engine(dir));
  const g = goalOf(dir); const [t1] = tasksOf(dir);
  assert.equal(g.status, 'achieved');
  assert.equal(t1.attempts, 2);
  assert.deepEqual(t1.orch.attempt_log.map((a) => [a.tier, a.outcome]), [['haiku', 'check_failed'], ['sonnet', 'success']]);
  assert.ok(t1.orch.attempt_log.every((a) => typeof a.notional_usd === 'number' && a.notional_usd >= 0), 'per-attempt cost is recorded for the outcome summary');
  assert.ok(Math.abs(t1.orch.attempt_log.reduce((x, a) => x + a.notional_usd, 0) - g.orch.usage.notional_usd) < 1e-6, 'attempt costs add up to the goal total');
  assert.match(fs.readFileSync(path.join(dir, 'workers', 't1.2.prompt.txt'), 'utf8'), /CHECKFAIL a\.txt has "WRONG"/);
  assert.equal(git(sb.repo, 'show', 'aos/g-test/integration:a.txt'), 'alpha');
  assert.deepEqual(fakeCalls(sb, 't1').map((c) => c.model), ['haiku', 'sonnet']);
  assert.equal(procsAlive(dir).length, 0);
  assertValidState(assert, dir);
});

test('escalation haiku -> sonnet -> opus, then the task fails and the goal is blocked (dependants stay pending)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const wrong = (n) => ({ behavior: 'fail_checks', edits: [{ path: 'a.txt', content: `wrong ${n}\n` }] });
  sb.scenario({ tasks: { t1: [wrong(1), wrong(2), wrong(3)] } });
  const { dir } = await sb.goal({ success_criteria: [crit('b.txt', 'beta')], plan: onePlan(ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta', { deps: ['t1'] })) });
  await drive(sb.engine(dir));
  const g = goalOf(dir); const [t1, t2] = tasksOf(dir);
  assert.equal(g.status, 'blocked'); assert.match(g.blocked_reason, /task t1 failed after 3 attempt/);
  assert.equal(t1.status, 'failed'); assert.equal(t1.attempts, 3);
  assert.deepEqual(t1.orch.attempt_log.map((a) => a.tier), ['haiku', 'sonnet', 'opus']);
  assert.equal(t2.status, 'pending'); assert.equal(fakeCalls(sb, 't2').length, 0);
  assert.ok(types(dir).includes('goal.blocked'));
  assert.equal(git(sb.repo, 'show', 'aos/g-test/integration:README.md'), '# fixture'); // nothing merged
  assert.match(fs.readFileSync(paths(dir).report, 'utf8'), /status: \*\*blocked\*\*/);
  assert.equal(worktreesOf(sb.repo).length, 1);
  assertValidState(assert, dir);
});

test('planner output (fenced or wrapped in prose) is parsed; invalid plans are rejected before any worker runs', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: { behavior: 'success', plan_format: 'prose', plan: onePlan(ptask('t1', 'a.txt', 'alpha')) }, tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')] });
  await drive(sb.engine(dir));
  assert.equal(goalOf(dir).status, 'achieved');
    const planner = fs.readFileSync(path.join(sb.fakeState, 'invocations.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((i) => i.planner);
  assert.equal(planner.length, 1); assert.match(planner[0].prompt, /AOS_PLANNER/); assert.equal(planner[0].model, 'opus');
  assert.ok(planner[0].argv.includes('Read,Glob,Grep'));

  // cyclic plan from the planner
  const sb2 = mkSandbox(); t.after(() => sb2.cleanup());
  sb2.scenario({ planner: { behavior: 'success', plan: onePlan(ptask('t1', 'a.txt', 'alpha', { deps: ['t2'] }), ptask('t2', 'b.txt', 'beta', { deps: ['t1'] })) } });
  const g2 = await sb2.goal({ success_criteria: [crit('a.txt', 'alpha')] });
  await drive(sb2.engine(g2.dir));
  assert.equal(goalOf(g2.dir).status, 'blocked'); assert.match(goalOf(g2.dir).blocked_reason, /dependency cycle/);
  assert.ok(types(g2.dir).includes('orch.plan.rejected')); assert.equal(fakeCalls(sb2, 't1').length, 0);

  // unsafe plan supplied directly: path escape + a check that is not on the allowlist
  const sb3 = mkSandbox(); t.after(() => sb3.cleanup());
  sb3.scenario({});
  const bad = ptask('t1', 'a.txt', 'alpha', { scope: ['../outside/**'] }); bad.checks = [{ argv: ['curl', 'http://x'], timeout_s: 5 }];
  const g3 = await sb3.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(bad) });
  await drive(sb3.engine(g3.dir));
  assert.equal(goalOf(g3.dir).status, 'blocked'); assert.match(goalOf(g3.dir).blocked_reason, /escapes the repo/);
  assert.equal(tasksOf(g3.dir).length, 0);
});

test('plan approval: required plans wait for a human; the tick is idempotent while waiting', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), orch: { approval_policy: { plan: 'required' } } });
  const eng = sb.engine(dir); await eng.start();
  await eng.tick();
  assert.equal(goalOf(dir).status, 'draft'); assert.equal(goalOf(dir).orch.plan_state, 'awaiting_approval'); assert.equal(eng.isDone(), true);
  assert.ok(Math.abs(goalOf(dir).orch.plan_awaiting_since_ms - Date.now()) < 60000, 'the moment the plan started waiting is recorded');
  const strip = (o) => JSON.stringify(o, (k, v) => (k === 'updated_at' ? undefined : v));
  const snap1 = strip(loadStateOf(dir)); const n1 = readEvents(dir).length;
  await eng.tick(); await eng.tick();
  assert.equal(strip(loadStateOf(dir)), snap1); // idempotent: same state
  assert.deepEqual(readEvents(dir).slice(n1).map((e) => e.type), ['heartbeat.tick', 'heartbeat.tick']); // and only the beat event
  assert.equal(fakeCalls(sb, 't1').length, 0);
  await eng.command({ cmd: 'approve-plan', by: 'test' });
  await drive(eng);
  assert.equal(goalOf(dir).status, 'achieved');
  assert.ok(types(dir).includes('human.approve'));
  assertValidState(assert, dir);
});
import { loadState as loadStateOf } from '../lib/state.mjs';

test('rate limit midway: governor pauses, writes the resume time, resumes at the (fake) reset; attempt not counted', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const clock = fakeClock();
  const reset = Math.floor((clock.t + 30 * 60000) / 1000);
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')], t2: [
    { behavior: 'rate_limit', message: '5-hour limit reached ∙ resets 3pm', rate_limit: { five_hour_utilization: 1.0, seven_day_utilization: 0.5, five_hour_resets_at: reset } },
    edit('b.txt', 'beta')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('b.txt', 'beta')], plan: onePlan(ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta', { deps: ['t1'] })) });
  const eng = sb.engine(dir, { clock }); await eng.start();
  await drive(eng, { until: () => goalOf(dir).orch.paused_reason && !eng.workers.size });
  const g = goalOf(dir);
  assert.match(g.orch.paused_reason, /plan limit/);
  assert.equal(g.orch.resume_at, new Date(reset * 1000 + 60000).toISOString()); // reset + 60 s jitter
  const gov = readJSON(path.join(sb.orch, 'governor.json'));
  assert.equal(gov.pause.until_ms, reset * 1000 + 60000);
  const t2 = tasksOf(dir)[1];
  assert.equal(t2.status, 'ready'); assert.equal(t2.attempts, 0); assert.equal(t2.orch.attempt_log[0].outcome, 'rate_limited'); assert.equal(t2.orch.attempt_log[0].counted, false);
  // no new dispatch while paused, however many ticks happen
  for (let i = 0; i < 4; i++) await eng.tick();
  assert.equal(fakeCalls(sb, 't2').length, 1);
  // time passes: the reset arrives (and the jitter)
  clock.advance(30 * 60000 + 61000);
  await drive(eng);
  const fin = goalOf(dir);
  assert.equal(fin.status, 'achieved'); assert.equal(fin.orch.paused_reason, null);
  assert.deepEqual(tasksOf(dir)[1].orch.attempt_log.map((a) => a.outcome), ['rate_limited', 'success']);
  assert.equal(tasksOf(dir)[1].attempts, 1);
  const ty = types(dir); assert.ok(ty.includes('orch.governor.paused') && ty.includes('orch.governor.resumed'));
  assertValidState(assert, dir);
});

test('utilisation reserve: >= 80% of the 5h window stops new dispatch (running work continues); 7d >= 90% needs a manual resume', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const clock = fakeClock();
  const reset5 = Math.floor((clock.t + 3600000) / 1000);
  sb.scenario({ tasks: { t1: [{ ...edit('a.txt', 'alpha'), rate_limit: { five_hour_utilization: 0.85, seven_day_utilization: 0.4, five_hour_resets_at: reset5 } }],
    t2: [{ ...edit('b.txt', 'beta'), rate_limit: { five_hour_utilization: 0.2, seven_day_utilization: 0.95, seven_day_resets_at: reset5 + 7200 } }], t3: [edit('c.txt', 'gamma')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('c.txt', 'gamma')], budget: { max_ticks: 100000, max_usd: 50, max_wall_clock_s: 10 * 3600 }, plan: onePlan(ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta', { deps: ['t1'] }), ptask('t3', 'c.txt', 'gamma', { deps: ['t2'] })) });
  const eng = sb.engine(dir, { clock }); await eng.start();
  await drive(eng, { until: () => tasksOf(dir)[0].status === 'done' && !eng.workers.size });
  for (let i = 0; i < 3; i++) await eng.tick();
  assert.equal(fakeCalls(sb, 't2').length, 0, 'no dispatch inside the reserve');
  assert.match(goalOf(dir).orch.paused_reason, /five-hour utilisation 85%/);
  clock.advance(3600000 + 1000); // window resets
  await drive(eng, { until: () => tasksOf(dir)[1].status === 'done' && !eng.workers.size });
  for (let i = 0; i < 3; i++) await eng.tick();
  assert.equal(fakeCalls(sb, 't3').length, 0, 'seven-day hold: manual resume only');
  assert.match(goalOf(dir).orch.paused_reason, /manual resume only/);
  clock.advance(3 * 3600000); // even after the five-hour window passes, the hold stays until a human resumes
  await eng.tick(); assert.equal(fakeCalls(sb, 't3').length, 0);
  await eng.command({ cmd: 'resume', by: 'test' });
  await drive(eng);
  assert.equal(goalOf(dir).status, 'achieved');
});

test('budget: the new-token cap stops new dispatch and ends the goal blocked with the reason', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')], t2: [edit('b.txt', 'beta')], t3: [edit('c.txt', 'gamma')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('c.txt', 'gamma')], orch: { budgets: { max_new_tokens: 1000 } },
    plan: onePlan(ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta', { deps: ['t1'] }), ptask('t3', 'c.txt', 'gamma', { deps: ['t2'] })) });
  await drive(sb.engine(dir));
  const g = goalOf(dir);
  assert.equal(g.status, 'blocked'); assert.match(g.blocked_reason, /^budget: new-token cap reached/);
  assert.deepEqual(tasksOf(dir).map((x) => x.status), ['done', 'ready', 'pending']);
  assert.equal(fakeCalls(sb, 't2').length, 0);
  const ev = readEvents(dir).filter((e) => e.type === 'budget.exceeded'); assert.equal(ev.length, 1);
  assert.match(fs.readFileSync(paths(dir).report, 'utf8'), /budget: new-token cap/);
  assertValidState(assert, dir);
});

test('budget: a running worker over the cap is killed after the grace period and its attempt is not counted', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ behavior: 'hang', ignore_sigterm: true }] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], orch: { budgets: { max_new_tokens: 1000 } }, plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  await drive(sb.engine(dir));
  const g = goalOf(dir); const t1 = tasksOf(dir)[0];
  assert.equal(g.status, 'blocked'); assert.match(g.blocked_reason, /new-token cap/);
  assert.equal(t1.attempts, 0); assert.equal(t1.orch.attempt_log[0].outcome, 'killed_budget'); assert.equal(t1.status, 'ready');
  assert.equal(procsAlive(dir).length, 0);
});

test('wall-clock per attempt: SIGTERM then SIGKILL of the process group, counted attempt, escalation', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ behavior: 'hang', ignore_sigterm: true }, edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], orch: { budgets: { task_wall_clock_s: 1 } }, plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  await drive(sb.engine(dir));
  const t1 = tasksOf(dir)[0];
  assert.equal(goalOf(dir).status, 'achieved');
  assert.deepEqual(t1.orch.attempt_log.map((a) => [a.tier, a.outcome]), [['haiku', 'wall_clock'], ['sonnet', 'success']]);
  assert.ok(readEvents(dir).some((e) => e.type === 'orch.worker.killed' && e.data.reason === 'wall_clock'));
  assert.equal(procsAlive(dir).length, 0);
});

test('parallelism cap is respected and reached; DAG order holds', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const slow = (f, w) => ({ ...edit(f, w), delay_ms: 600 });
  sb.scenario({ tasks: { t1: [slow('a.txt', 'alpha')], t2: [slow('b.txt', 'beta')], t3: [slow('c.txt', 'gamma')], t4: [slow('d.txt', 'delta')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('d.txt', 'delta')], orch: { budgets: { max_parallel: 2 } },
    plan: onePlan(ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta'), ptask('t3', 'c.txt', 'gamma'), ptask('t4', 'd.txt', 'delta', { deps: ['t1'] })) });
  let max = 0; const eng = sb.engine(dir);
  await drive(eng, { until: () => { max = Math.max(max, tasksOf(dir).filter((x) => x.status === 'running').length); return eng.isDone(); } });
  assert.equal(max, 2);
  assert.equal(goalOf(dir).status, 'achieved');
  assertValidState(assert, dir);
});

test('overlapping path scopes never run at the same time (SPEC section 6)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const slow = (f, w) => ({ ...edit(f, w), delay_ms: 500 });
  sb.scenario({ tasks: { t1: [slow('src/a.txt', 'alpha')], t2: [slow('src/b.txt', 'beta')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('src/b.txt', 'beta')],
    plan: onePlan(ptask('t1', 'src/a.txt', 'alpha', { scope: ['src/**'] }), ptask('t2', 'src/b.txt', 'beta', { scope: ['src/*.txt'] })) });
  let max = 0; const eng = sb.engine(dir);
  await drive(eng, { until: () => { max = Math.max(max, tasksOf(dir).filter((x) => x.status === 'running').length); return eng.isDone(); } });
  assert.equal(max, 1); assert.equal(goalOf(dir).status, 'achieved');
});

test('crash/resume: a fresh engine re-adopts the live worker and finishes exactly once (no double dispatch)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ ...edit('a.txt', 'alpha'), delay_ms: 1500 }] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  const e1 = sb.engine(dir, { pid: 2147480001 }); // a pid that is not alive once we "crash"
  await e1.start();
  await drive(e1, { until: () => tasksOf(dir)[0].status === 'running' });
  const pf = readJSON(path.join(dir, 'workers', 't1.1.pid.json'));
  e1.crash(); // loop stops, lock + worker + files stay as they are
  assert.equal(process.kill(pf.pid, 0), true);
  const e2 = sb.engine(dir);
  await drive(e2);
  assert.equal(goalOf(dir).status, 'achieved');
  assert.equal(fakeCalls(sb, 't1').length, 1, 'exactly one worker was ever started');
  const ty = types(dir);
  assert.ok(ty.includes('orch.lock.broken') && ty.includes('orch.worker.adopted'));
  assert.equal(ty.filter((x) => x === 'task.completed').length, 1);
  assert.equal(tasksOf(dir)[0].attempts, 1);
  assert.equal(procsAlive(dir).length, 0);
  assertValidState(assert, dir);
});

test('crash/resume: a dead or never-started worker is marked lost and requeued without counting the attempt', async (t) => {
  for (const flavor of ['killed', 'no-pid-file']) {
    const sb = mkSandbox(); t.after(() => sb.cleanup());
    sb.scenario({ tasks: { t1: [{ behavior: 'hang' }, edit('a.txt', 'alpha')] } });
    const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
    const e1 = sb.engine(dir, { pid: 2147480002 });
    await e1.start();
    await drive(e1, { until: () => tasksOf(dir)[0].status === 'running' && (e1.workers.get('t1')?.tail.update(), e1.workers.get('t1')?.tail.init) });
    const pf = path.join(dir, 'workers', 't1.1.pid.json');
    const { pgid } = readJSON(pf);
    e1.crash();
    process.kill(-pgid, 'SIGKILL'); await sleep(150);
    if (flavor === 'no-pid-file') fs.unlinkSync(pf);
    await drive(sb.engine(dir));
    const t1 = tasksOf(dir)[0];
    assert.equal(goalOf(dir).status, 'achieved', flavor);
    assert.deepEqual(t1.orch.attempt_log.map((a) => a.outcome), ['lost', 'success'], flavor);
    assert.equal(t1.attempts, 1, flavor); assert.equal(t1.orch.model_tier, 'haiku', 'requeued on the same tier');
    assert.ok(types(dir).includes('orch.worker.lost'));
  }
});

test('cancel / kill switch: process groups are gone, tasks cancelled, worktrees cleaned, report written', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ default: { behavior: 'hang', ignore_sigterm: true } });
  const { dir } = await sb.goal({ success_criteria: [crit('c.txt', 'gamma')], plan: onePlan(ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta'), ptask('t3', 'c.txt', 'gamma', { deps: ['t1'] })) });
  const eng = sb.engine(dir); await eng.start();
  await drive(eng, { until: () => tasksOf(dir).filter((x) => x.status === 'running').length === 2 });
  const pids = ['t1', 't2'].map((id) => readJSON(path.join(dir, 'workers', `${id}.1.pid.json`)));
  assert.equal(procsAlive(dir).length, 2);
  await eng.command({ cmd: 'kill', by: 'test' });
  for (const p of pids) assert.throws(() => process.kill(-p.pgid, 0), /ESRCH/);
  assert.equal(procsAlive(dir).length, 0);
  assert.equal(goalOf(dir).status, 'cancelled');
  assert.deepEqual(tasksOf(dir).map((x) => x.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(worktreesOf(sb.repo).length, 1);
  assert.ok(fs.existsSync(paths(dir).report));
  assert.ok(['human.cancel', 'goal.cancelled'].every((x) => types(dir).includes(x)));
  assert.equal(git(sb.repo, 'rev-parse', 'main'), git(sb.repo, 'rev-parse', 'main'));
  const n = readEvents(dir).length; await eng.tick(); assert.equal(readEvents(dir).length, n, 'a cancelled goal does nothing more');
  assertValidState(assert, dir);
});

test('pause stops dispatch at the tick boundary and resume continues', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  const eng = sb.engine(dir); await eng.start();
  await eng.command({ cmd: 'pause', by: 'test' }); await eng.tick(); await eng.tick();
  assert.equal(fakeCalls(sb, 't1').length, 0); assert.equal(readJSON(paths(dir).hb).status, 'paused');
  await eng.command({ cmd: 'resume', by: 'test' }); await drive(eng);
  assert.equal(goalOf(dir).status, 'achieved'); assert.ok(types(dir).includes('human.pause') && types(dir).includes('human.resume'));
});

test('locking: a second engine cannot take a goal; a stale lock (dead pid) is taken over', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({});
  const { dir } = await sb.goal({ plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  const a = sb.engine(dir); await a.start();
  const b = sb.engine(dir);
  await assert.rejects(() => b.start(), /already owned by engine pid/);
  await a.stop();
  await b.start(); await b.stop();
  // dead holder
  fs.writeFileSync(paths(dir).lock, JSON.stringify({ pid: 2147480003, ts: Date.now() }));
  const c = sb.engine(dir); await c.start(); assert.equal(readJSON(paths(dir).lock).pid, process.pid); await c.stop();
  // live holder but not refreshed for longer than the ttl
  fs.writeFileSync(paths(dir).lock, JSON.stringify({ pid: process.ppid, ts: Date.now() - 10 * 60000 }));
  assert.equal(acquireLock(dir, { pid: 4242, ttlMs: 60000 }).ok, true); releaseLock(dir, { pid: 4242 });
  // live and fresh: refused
  fs.writeFileSync(paths(dir).lock, JSON.stringify({ pid: process.ppid, ts: Date.now() }));
  assert.equal(acquireLock(dir, { pid: 4242, ttlMs: 60000 }).ok, false);
  fs.unlinkSync(paths(dir).lock);
});

test('policy hook in a real run: a write outside the worktree is denied (no file), permission_denials make the attempt fail but checks still run', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario(SCEN('denied-write-outside-worktree.json').tasks ? { tasks: { t1: [SCEN('denied-write-outside-worktree.json').tasks.t1[0], edit('a.txt', 'alpha')] } } : {});
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  await drive(sb.engine(dir));
  const t1 = tasksOf(dir)[0];
  const a1 = t1.orch.attempt_log[0];
  assert.equal(a1.outcome, 'denied'); assert.equal(a1.denials, 2); assert.equal(a1.checks_ok, true, 'task still evaluated by the checks');
  assert.equal(a1.tier, 'haiku'); assert.equal(t1.orch.attempt_log[1].tier, 'haiku', 'denials retry the same tier once');
  assert.equal(t1.status, 'done'); assert.equal(t1.attempts, 2);
  assert.equal(fs.existsSync(path.join(sb.root, 'repo-aos-worktrees', 'g-test', 'escape.txt')), false);
  assert.equal(fs.existsSync(path.join(sb.root, 'repo-aos-worktrees', 'escape.txt')), false);
  assert.ok(readEvents(dir).some((e) => e.type === 'orch.policy.denied'));
  assert.match(fs.readFileSync(path.join(dir, 'workers', 't1.2.prompt.txt'), 'utf8'), /previous attempt had denied tool calls/);
  const decisions = fs.readFileSync(path.join(dir, 'workers', 'decisions.ndjson'), 'utf8');
  assert.match(decisions, /"rule":"outside_worktree"/); assert.match(decisions, /"rule":"dangerous"/);
  assert.match(fs.readFileSync(paths(dir).report, 'utf8'), /Policy denials[\s\S]*outside_worktree/);
});

test('a denial that repeats on every tier ends as a failed task', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ behavior: 'denied_tool', edits: [{ path: '../escape.txt', content: 'x\n' }, { path: 'a.txt', content: 'alpha\n' }] }] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  await drive(sb.engine(dir));
  const t1 = tasksOf(dir)[0];
  assert.equal(t1.status, 'failed'); assert.equal(goalOf(dir).status, 'blocked');
  assert.deepEqual(t1.orch.attempt_log.map((a) => [a.tier, a.outcome]), [['haiku', 'denied'], ['haiku', 'denied'], ['sonnet', 'denied']]);
});

const asks = (extra = {}) => ({ wait: 0.3, ...extra });
const askPlan = () => onePlan({ ...ptask('t1', 'a.txt', 'alpha'), checks: [chk('z.txt', 'zed')] });

test('ask: approval granted while the hook waits -> the write happens, grant recorded, one counted attempt', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ behavior: 'success', edits: [{ path: 'z.txt', content: 'zed\n' }] }] } });
  const { dir } = await sb.goal({ success_criteria: [crit('z.txt', 'zed')], plan: askPlan(), orch: { policy: { approval: { wait_in_hook_s: 20 } } } });
  const eng = sb.engine(dir); let decided = false;
  await drive(eng, { until: () => {
    const p = listApprovals(paths(dir).approvals, { status: 'pending' })[0];
    if (p && !decided) { decide(paths(dir).approvals, p.id, { decision: 'approve', scope: 'task', by: 'test' }); decided = true; }
    return eng.isDone();
  } });
  assert.equal(decided, true);
  const t1 = tasksOf(dir)[0];
  assert.equal(goalOf(dir).status, 'achieved'); assert.equal(t1.attempts, 1); assert.equal(t1.orch.attempt_log.length, 1);
  assert.deepEqual(t1.orch.grants.map((g) => g.kind), ['path']);
  assert.equal(git(sb.repo, 'show', 'aos/g-test/integration:z.txt'), 'zed');
  const ty = types(dir); assert.ok(['orch.approval.requested', 'orch.approval.decided', 'human.approve'].every((x) => ty.includes(x)));
  assert.match(fs.readFileSync(path.join(sb.orch, 'goals', 'g-test', 'approvals', 'audit.ndjson'), 'utf8'), /"event":"decided"/);
  assertValidState(assert, dir);
});

test('ask: nobody decides in time -> hook denies, task waits in needs_review (slot freed, attempt not counted); a later approval continues it', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ behavior: 'success', edits: [{ path: 'z.txt', content: 'zed\n' }] }] } });
  const { dir } = await sb.goal({ success_criteria: [crit('z.txt', 'zed')], plan: askPlan(), orch: { policy: { approval: { wait_in_hook_s: 0.3 } } } });
  const eng = sb.engine(dir);
  await drive(eng, { until: () => tasksOf(dir)[0].status === 'needs_review' });
  const t1 = tasksOf(dir)[0];
  assert.equal(t1.attempts, 0); assert.equal(t1.orch.attempt_log[0].outcome, 'awaiting_approval'); assert.equal(eng.workers.size, 0);
  const [ap] = listApprovals(paths(dir).approvals, { status: 'pending' });
  assert.ok(ap && ap.tool === 'Write'); assert.equal(fs.existsSync(path.join(sb.root, 'repo-aos-worktrees', 'g-test', 't1', 'z.txt')), false, 'the denied write did not happen');
  await eng.tick(); assert.equal(tasksOf(dir)[0].status, 'needs_review', 'still waiting');
  decide(paths(dir).approvals, ap.id, { decision: 'approve', scope: 'once', by: 'test' });
  await drive(eng);
  const fin = tasksOf(dir)[0];
  assert.equal(goalOf(dir).status, 'achieved'); assert.equal(fin.attempts, 1);
  assert.deepEqual(fin.orch.attempt_log.map((a) => a.outcome), ['awaiting_approval', 'success']);
  assert.equal(fin.orch.model_tier, 'haiku');
  assert.equal(fakeCalls(sb, 't1').length, 2);
  assert.equal(fin.orch.grants.length, 0, 'a once-grant is dropped when the task is done');
});

test('ask: timeout = deny. An approval that expires is a denial: the attempt counts and the task retries without the capability', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ behavior: 'success', edits: [{ path: 'z.txt', content: 'zed\n' }] }, { behavior: 'success', edits: [{ path: 'a.txt', content: 'alpha\n' }] }] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')), orch: { policy: { approval: { wait_in_hook_s: 0.3 } }, budgets: { approval_ttl_s: 1 } } });
  await drive(sb.engine(dir));
  const t1 = tasksOf(dir)[0];
  assert.equal(goalOf(dir).status, 'achieved');
  assert.deepEqual(t1.orch.attempt_log.map((a) => [a.tier, a.outcome]), [['haiku', 'approval_denied'], ['sonnet', 'success']]);
  assert.equal(t1.attempts, 2);
  assert.equal(listApprovals(paths(dir).approvals)[0].status, 'expired');
  assert.ok(types(dir).includes('orch.approval.expired'));
  assert.throws(() => git(sb.repo, 'show', 'aos/g-test/integration:z.txt'));
});

test('scope violation: files changed outside path_scope fail the attempt at the snapshot and nothing is committed', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ behavior: 'success', edits: [{ path: 'a.txt', content: 'alpha\n' }, { path: 'other.txt', content: 'oops\n' }] }, edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  await drive(sb.engine(dir, { hookScript: allowAllHook(sb.root) }));
  const t1 = tasksOf(dir)[0];
  assert.deepEqual(t1.orch.attempt_log.map((a) => a.outcome), ['scope_violation', 'success']);
  assert.throws(() => git(sb.repo, 'show', 'aos/g-test/integration:other.txt'));
  assert.throws(() => git(sb.repo, 'show', 'aos/g-test/t1:other.txt'));
  assert.match(fs.readFileSync(path.join(dir, 'workers', 't1.2.prompt.txt'), 'utf8'), /outside path_scope: other\.txt/);
});

test('merge conflict: the task goes back to ready with rebase context and a fresh worktree (counts as an attempt)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ ...edit('a.txt', 'alpha'), delay_ms: 1200 }, edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  const eng = sb.engine(dir);
  await drive(eng, { until: () => tasksOf(dir)[0].status === 'running' });
  const wt = path.join(sb.root, 'repo-aos-worktrees', 'g-test', 'integration'); // someone lands a conflicting change on the integration branch
  fs.writeFileSync(path.join(wt, 'a.txt'), 'other\n'); git(wt, 'add', '-A'); git(wt, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'conflicting change');
  await drive(eng);
  const t1 = tasksOf(dir)[0];
  assert.equal(goalOf(dir).status, 'achieved');
  assert.deepEqual(t1.orch.attempt_log.map((a) => a.outcome), ['merge_conflict', 'success']);
  assert.equal(t1.attempts, 2); assert.equal(t1.orch.attempt_log[1].tier, 'haiku', 'a conflict does not escalate the tier');
  assert.match(fs.readFileSync(path.join(dir, 'workers', 't1.2.prompt.txt'), 'utf8'), /merge conflict in a\.txt/);
  assert.ok(types(dir).includes('orch.integrate.conflict'));
  assert.equal(git(sb.repo, 'show', 'aos/g-test/integration:a.txt'), 'alpha');
});

test('worker command line and environment follow the design (spike-verified flags only, minimal env, detached)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  const secret = { ANTHROPIC_API_KEY: 'sk-secret', SSH_AUTH_SOCK: '/tmp/agent', GITHUB_TOKEN: 'ghp_x', AWS_ACCESS_KEY_ID: 'AKIA', NPM_TOKEN: 'n' };
  const { spawn } = await import('node:child_process'); const seen = [];
  const spawnFn = (bin, args, opts) => { seen.push({ bin, args, opts }); return spawn(bin, args, opts); };
  await drive(sb.engine(dir, { env: sb.env(secret), spawnFn }));
  const w = seen.find((s) => s.opts.cwd.endsWith('/t1'));
  const a = w.args;
  assert.equal(w.bin, FAKE); assert.equal(w.opts.detached, true); assert.equal(a[0], '-p');
  const flag = (n) => a[a.indexOf(n) + 1];
  assert.equal(flag('--model'), 'haiku'); assert.equal(flag('--output-format'), 'stream-json'); assert.ok(a.includes('--verbose'));
  assert.match(flag('--session-id'), /^[0-9a-f-]{36}$/); assert.equal(flag('--max-turns'), '30'); assert.ok(Number(flag('--max-budget-usd')) > 0);
  assert.equal(flag('--setting-sources'), 'project'); assert.ok(a.includes('--strict-mcp-config')); assert.equal(flag('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(flag('--tools'), 'Read,Edit,Write,Glob,Grep,Bash'); assert.equal(flag('--allowedTools'), 'Read,Glob,Grep');
  assert.ok(flag('--append-system-prompt').includes('Do not commit')); assert.ok(flag('--settings').endsWith('workers/settings.json'));
  const spikeFlags = new Set(['--model', '--output-format', '--verbose', '--session-id', '--max-turns', '--max-budget-usd', '--setting-sources', '--strict-mcp-config', '--mcp-config', '--tools', '--allowedTools', '--append-system-prompt', '--settings']);
  assert.deepEqual(a.filter((x) => /^--[A-Za-z-]+$/.test(x) && !spikeFlags.has(x)), []);
  const env = w.opts.env;
  for (const k of Object.keys(secret)) assert.equal(env[k], undefined, `${k} must not reach the worker`);
  assert.deepEqual(Object.keys(env).filter((k) => !k.startsWith('AOS_') && !['HOME', 'USER', 'LOGNAME', 'LANG', 'PATH', 'TERM', 'TMPDIR'].includes(k)), []);
  assert.equal(env.TERM, 'dumb'); assert.equal(env.AOS_GOAL_ID, 'g-test'); assert.equal(env.AOS_TASK_ID, 't1'); assert.equal(env.AOS_ATTEMPT, '1');
  assert.ok(env.AOS_POLICY_FILE.endsWith('t1.1.policy.json')); assert.ok(env.AOS_WORKTREE.endsWith('/t1')); assert.ok(env.AOS_APPROVALS_DIR.endsWith('/approvals'));
  const hooks = readJSON(path.join(dir, 'workers', 'settings.json')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PermissionRequest', 'PreToolUse']);
});

test('event log: seq strictly increasing from 1, every event valid against the AOS-1 schema (+ orch.* extensions)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ behavior: 'fail_checks', edits: [{ path: 'a.txt', content: 'x\n' }] }, edit('a.txt', 'alpha')], t2: [edit('b.txt', 'beta')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('b.txt', 'beta')], plan: onePlan(ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta', { deps: ['t1'] })) });
  await drive(sb.engine(dir));
  const evs = assertValidState(assert, dir);
  assert.equal(evs[0].seq, 1); assert.ok(evs.length > 20);
  assert.ok(evs.every((e) => e.goal_id === 'g-test'));
  assert.ok(evs.every((e, i) => i === 0 || e.ts >= evs[i - 1].ts));
});

// ---------------------------------------------------------------------------------------------------------------
// Security review (phase 1)
import { spawn as spawnProc } from 'node:child_process';
const unrelatedGroup = () => { const c = spawnProc('sleep', ['30'], { detached: true, stdio: 'ignore' }); c.unref(); return c.pid; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('review: a worker that rewrites <wt>/.git cannot make the engine commit onto the base branch', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const forge = { command: `printf 'gitdir: %s\\n' ${JSON.stringify(path.join(sb.repo, '.git'))} > .git`, run: true }; // what code run by `node --test` could do
  sb.scenario({ tasks: { t1: [{ behavior: 'success', edits: [{ path: 'a.txt', content: 'alpha\n' }], commands: [forge] }, edit('a.txt', 'alpha')] } });
  const mainBefore = git(sb.repo, 'rev-parse', 'main');
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  await drive(sb.engine(dir, { hookScript: allowAllHook(sb.root) }));
  assert.equal(git(sb.repo, 'rev-parse', 'main'), mainBefore, 'base branch must never move');
  assert.deepEqual(tasksOf(dir)[0].orch.attempt_log.map((a) => a.outcome), ['worktree_tampered', 'success']);
  assert.equal(goalOf(dir).status, 'achieved');
});

test('review: background processes a worker leaves in its process group are stopped when it exits', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ behavior: 'success', edits: [{ path: 'a.txt', content: 'alpha\n' }], commands: [{ command: 'sleep 30 >/dev/null 2>&1 &', run: true }] }] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  await drive(sb.engine(dir, { hookScript: allowAllHook(sb.root) }));
  assert.equal(goalOf(dir).status, 'achieved');
  await sleep(100);
  assert.deepEqual(procsAlive(dir), []);
});

test('review: cancel after a crash never kills a process group whose pid was reused by an unrelated process', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [{ behavior: 'hang' }] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  const e1 = sb.engine(dir, { pid: 2147480011 }); await e1.start();
  await drive(e1, { until: () => tasksOf(dir)[0].status === 'running' });
  const pfFile = path.join(dir, 'workers', 't1.1.pid.json'); const pf = readJSON(pfFile);
  e1.crash(); process.kill(-pf.pgid, 'SIGKILL'); await sleep(150);
  const other = unrelatedGroup(); t.after(() => { try { process.kill(-other, 'SIGKILL'); } catch { /* gone */ } });
  fs.writeFileSync(pfFile, JSON.stringify({ ...pf, pid: other, pgid: other })); // pid reuse after a reboot
  const e2 = sb.engine(dir); await e2.start();
  await e2.command({ cmd: 'cancel', by: 'test' });
  assert.equal(goalOf(dir).status, 'cancelled');
  assert.ok(alive(other), 'unrelated process group must survive');
});

test('review: an orphaned planner pid file from a crash never gets an unrelated process group killed', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: { behavior: 'error' } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')] });
  const other = unrelatedGroup(); t.after(() => { try { process.kill(-other, 'SIGKILL'); } catch { /* gone */ } });
  fs.mkdirSync(path.join(dir, 'workers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workers', 'planner.1.pid.json'), JSON.stringify({ pid: other, pgid: other, session_id: '00000000-0000-4000-8000-000000000000' }));
  await drive(sb.engine(dir));
  assert.equal(goalOf(dir).status, 'blocked');
  assert.ok(alive(other), 'unrelated process group must survive');
});

test('review: a live engine keeps its lock fresh during long ticks, so a second engine cannot take the goal over', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: {} });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: onePlan(ptask('t1', 'a.txt', 'alpha')) });
  const e1 = sb.engine(dir, { lockRefreshMs: 30 }); await e1.start();
  const lock = paths(dir).lock;
  fs.writeFileSync(lock, JSON.stringify({ ...readJSON(lock), ts: 0 })); // as if the last tick began long ago and is still running
  await sleep(200);
  const r = acquireLock(dir, { pid: 2147480012, ttlMs: 60000, now: Date.now() });
  assert.equal(r.ok, false, 'lock was taken over from a live engine');
  await e1.stop();
});

test('review: protected files written outside any tool call (e.g. by test code) are never committed, whatever the scope', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const hooks = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch /tmp/pwned"}]}]}}\n';
  sb.scenario({ tasks: { t1: [{ behavior: 'success', edits: [{ path: 'a.json', content: '1\n' }, { path: '.claude/settings.json', content: hooks }] }, { behavior: 'success', edits: [{ path: 'a.json', content: '1\n' }] }] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.json', '1')], plan: onePlan(ptask('t1', 'a.json', '1', { scope: ['**/*.json'] })) });
  await drive(sb.engine(dir, { hookScript: allowAllHook(sb.root) }));
  assert.deepEqual(tasksOf(dir)[0].orch.attempt_log.map((a) => a.outcome), ['scope_violation', 'success']);
  assert.throws(() => git(sb.repo, 'show', 'aos/g-test/integration:.claude/settings.json'));
});
