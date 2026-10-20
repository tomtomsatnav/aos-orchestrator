// Supervisor: global worker semaphore + fairness across goals, shared governor, budget patches, graceful drain, CLI wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkSandbox, ptask, crit, edit, fakeCalls, sleep, procsAlive, HERE } from './helpers.mjs';
import { until, request } from './server-helpers.mjs';
import { Supervisor } from '../lib/supervisor.mjs';
import { validateBudgetPatch, applyBudgetPatch, goalDirOf, readJSON, loadState, loadHeartbeat, paths, enqueueCommand, lockStatus, describeOwner, DEFAULT_BUDGETS } from '../lib/state.mjs';
import { readCliToken } from '../server/auth.mjs';

const runCli = (args, env) => new Promise((resolve) => { const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; }); c.on('close', (code) => resolve({ code, out, err })); });
const mk = (t, scenario) => { const sb = mkSandbox('aos-sup'); sb.scenario(scenario); t.after(async () => { for (const s of sb.sups || []) await s.stop({ workers: 'kill' }).catch(() => {}); sb.cleanup(); }); return sb; };
const sup = (sb, o = {}) => { const s = new Supervisor({ orchDir: sb.orch, env: sb.env(), pollMs: 40, intervalMs: 200, scanMs: 60000, engineOpts: { killGraceMs: 300, budgetGraceMs: 400 }, ...o }); (sb.sups ||= []).push(s); return s; };
const plan3 = () => ({ tasks: [ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta'), ptask('t3', 'c.txt', 'gamma')], risks: [] });
const crit3 = { id: 'c1', text: 'all', check: { argv: ['node', '-e', "const f=require('fs');for(const [n,w] of [['a.txt','alpha'],['b.txt','beta'],['c.txt','gamma']])if(f.readFileSync(n,'utf8').trim()!==w)process.exit(1)"], timeout_s: 30 } };
const approveWhenReady = async (s, id) => { await until(() => s.state(id).S.goal.orch.plan_state === 'awaiting_approval', { what: `${id} plan` }); await s.approvePlan(id, s.reviewHash(id).combined, 'test'); };

test('global worker cap is never exceeded and two goals both progress (fair round-robin)', async (t) => {
  const slow = (f, w) => ({ behavior: 'success', delay_ms: 500, edits: [{ path: f, content: `${w}\n` }] });
  const sb = mk(t, { tasks: { t1: slow('a.txt', 'alpha'), t2: slow('b.txt', 'beta'), t3: slow('c.txt', 'gamma') } });
  await sb.goal({ id: 'g-a', success_criteria: [crit3], plan: plan3() }); await sb.goal({ id: 'g-b', success_criteria: [crit3], plan: plan3() });
  const s = sup(sb, { maxWorkers: 2 });
  await s.start();
  let max = 0; let both = 0; const perGoalMax = { 'g-a': 0, 'g-b': 0 };
  const sampler = setInterval(() => {
    max = Math.max(max, s.workerCount());
    const r = ['g-a', 'g-b'].map((id) => s.handles.get(id)?.engine.workers.size || 0);
    r.forEach((n, i) => { perGoalMax[['g-a', 'g-b'][i]] = Math.max(perGoalMax[['g-a', 'g-b'][i]], n); });
    if (r[0] > 0 && r[1] > 0) both++;
  }, 10);
  t.after(() => clearInterval(sampler));
  await approveWhenReady(s, 'g-a'); await approveWhenReady(s, 'g-b');
  await until(() => ['g-a', 'g-b'].every((id) => s.state(id).S.goal.status === 'achieved'), { timeoutMs: 90000, what: 'both goals achieved' });
  assert.ok(max <= 2, `global cap exceeded: ${max}`); assert.equal(max, 2, 'the cap was actually used');
  assert.ok(both >= 5, `both goals must run concurrently (fair share), saw ${both} samples`);
  assert.ok(perGoalMax['g-a'] >= 1 && perGoalMax['g-b'] >= 1, JSON.stringify(perGoalMax));
  assert.equal(s.workerCount(), 0);
});

test('the shared governor holds every goal (7-day rule: no dispatch until a human resumes), health shows it', async (t) => {
  const sb = mk(t, { tasks: { t1: edit('a.txt', 'alpha') } });
  const { dir } = await sb.goal({ id: 'g-a', success_criteria: [crit3.check ? { id: 'c1', text: 'a', check: { argv: ['grep', '-qx', 'alpha', 'a.txt'], timeout_s: 30 } } : crit3], plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] } });
  fs.writeFileSync(path.join(sb.orch, 'governor.json'), JSON.stringify({ five_hour: null, seven_day: { utilization: 0.95, resets_at_ms: Date.now() + 3600e3 }, pause: null, backoff_level: 0 }));
  const s = sup(sb); await s.start();
  await approveWhenReady(s, 'g-a'); await sleep(800);
  assert.equal(fakeCalls(sb, 't1').length, 0, 'nothing dispatched under the 7-day hold');
  assert.equal(s.governorState().dispatch, false);
  assert.match(readJSON(path.join(dir, 'goal.json')).orch.paused_reason, /seven-day/);
  await s.resume('g-a', 'test');
  await until(() => s.state('g-a').S.goal.status === 'achieved', { what: 'achieved after the human resume' });
});

test('five-hour reserve: no new work, workers already running are untouched', async (t) => {
  const sb = mk(t, { tasks: { t1: edit('a.txt', 'alpha') } });
  await sb.goal({ id: 'g-a', success_criteria: [{ id: 'c1', text: 'a', check: { argv: ['grep', '-qx', 'alpha', 'a.txt'], timeout_s: 30 } }], plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] } });
  fs.writeFileSync(path.join(sb.orch, 'governor.json'), JSON.stringify({ five_hour: { utilization: 0.85, resets_at_ms: Date.now() + 3600e3 }, seven_day: null, pause: null, backoff_level: 0 }));
  const s = sup(sb); await s.start();
  await approveWhenReady(s, 'g-a'); await sleep(600);
  assert.equal(fakeCalls(sb, 't1').length, 0);
  assert.equal(s.workerCount(), 0);
});

test('slot gate: reservations count, closing the gate stops dispatch, fairness prefers the goal with fewer workers', () => {
  const s = new Supervisor({ orchDir: fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'aos-gate-')), maxWorkers: 3 });
  const fakeEng = (n) => ({ engine: { workers: { size: n } } });
  s.handles.set('a', fakeEng(2)); s.handles.set('b', fakeEng(0));
  const tb = s.gate.acquire('b');
  assert.ok(tb, 'b takes the third slot');
  assert.equal(s.gate.acquire('a'), null, 'cap 3 reached (2 running + 1 reserved)');
  assert.equal(s.gate.acquire('b'), null, 'cap reached: b is denied and now counts as waiting');
  s.gate.release(tb);
  assert.equal(s.gate.acquire('a'), null, 'a (2 workers) yields the free slot to the waiting b (0 workers)');
  assert.ok(s.gate.acquire('b'));
  s.gate.closed = true; assert.equal(s.gate.acquire('b'), null);
  fs.rmSync(s.orchDir, { recursive: true, force: true });
});

test('budget patch validation and application; defaults are what the API documents', () => {
  assert.equal(validateBudgetPatch({}).ok, false);
  assert.equal(validateBudgetPatch({ max_new_tokens: 5, extra: 1 }).ok, false);
  assert.equal(validateBudgetPatch({ max_new_tokens: 1.5 }).ok, false);
  assert.equal(validateBudgetPatch({ max_usd: 0.5 }).ok, true);
  assert.equal(validateBudgetPatch(null).ok, false);
  const goal = { orch: { budgets: { ...DEFAULT_BUDGETS } }, budget: { max_ticks: 5, max_usd: 5, max_wall_clock_s: 10 } };
  const tasks = [{ status: 'ready', max_attempts: 3 }, { status: 'done', max_attempts: 3 }];
  applyBudgetPatch(goal, tasks, { max_new_tokens: 9, max_wall_s: 99, max_attempts: 5, max_parallel: 2 });
  assert.deepEqual([goal.orch.budgets.max_new_tokens, goal.budget.max_wall_clock_s, goal.orch.budgets.max_parallel, tasks[0].max_attempts, tasks[1].max_attempts], [9, 99, 2, 5, 3]);
});

test('graceful stop drains running workers (they finish and merge), leaves the goal resumable, and releases locks', async (t) => {
  const sb = mk(t, { tasks: { t1: { behavior: 'success', delay_ms: 700, edits: [{ path: 'a.txt', content: 'alpha\n' }] } } });
  const { dir } = await sb.goal({ id: 'g-a', success_criteria: [{ id: 'c1', text: 'a', check: { argv: ['grep', '-qx', 'alpha', 'a.txt'], timeout_s: 30 } }], plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] } });
  const s = sup(sb); await s.start();
  await approveWhenReady(s, 'g-a');
  await until(() => s.workerCount() === 1, { what: 'worker running' });
  await s.stop({ workers: 'drain', drainMs: 20000 });
  assert.equal(procsAlive(dir).length, 0);
  assert.equal(loadState(dir).tasks[0].status, 'done', 'the running worker finished and was merged during the drain');
  assert.equal(fs.existsSync(path.join(dir, '.tick.lock')), false, 'lock released');
  const s2 = sup(sb); await s2.start();
  await until(() => s2.state('g-a').S.goal.status === 'achieved', { what: 'achieved after restart' });
  assert.equal(fakeCalls(sb, 't1').length, 1);
});

// ---------------------------------------------------------------------------------------------- CLI
const CLI = path.join(HERE, '..', 'bin', 'aos-orch.mjs');
const run = (args, env) => new Promise((resolve) => { const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; }); c.on('close', (code) => resolve({ code, out, err })); });

test('cli: token (path unless --show), login-link, goals, serve (SIGTERM exits cleanly), port validation', async (t) => {
  const sb = mk(t, {}); const env = sb.env();
  let r = await run(['token'], env);
  assert.equal(r.code, 0); assert.equal(r.out.trim(), path.join(sb.orch, 'control-token')); assert.ok(!r.out.includes(readCliToken(sb.orch)));
  r = await run(['token', '--show'], env); assert.equal(r.out.trim(), readCliToken(sb.orch));
  r = await run(['login-link', '--port', '4555'], env);
  assert.match(r.out.trim(), /^http:\/\/127\.0\.0\.1:4555\/auth\/login\?code=[0-9a-f]{32}$/); assert.ok(!r.out.includes(readCliToken(sb.orch)));
  assert.equal((await run(['login-link', '--port', '80'], env)).code, 1);
  assert.match((await run(['goals'], env)).out, /no goals/);
  await sb.goal({ id: 'g-a', success_criteria: [crit3], plan: plan3() });
  assert.match((await run(['goals'], env)).out, /g-a  draft\/supplied  tasks 0\/0/);
  assert.equal(JSON.parse((await run(['goals', '--json'], env)).out)[0].id, 'g-a');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const c = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--poll-ms', '50', '--interval-s', '0.2'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((res) => c.on('close', (code, sig) => res({ code, sig })));
  t.after(() => c.kill('SIGKILL'));
  await until(() => /control server on/.test(err), { what: 'serve banner' });
  const tok = readCliToken(sb.orch);
  assert.ok(!err.includes(tok), 'the token is never printed');
  const h = await request(port, { path: '/api/health', headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(h.status, 200); assert.equal(h.json.goals, 1); assert.equal(h.json.workers.max, 3);
  c.kill('SIGTERM');
  const e = await exited; assert.equal(e.code, 0, err);
  assert.ok(!err.includes(tok));
  assert.equal(fs.existsSync(path.join(sb.orch, 'goals', 'g-a', '.tick.lock')), false);
});

// ---- regression: `aos-orch serve` stopped ticking a goal parked at plan approval, so a CLI-queued approve-plan was never consumed
// while the lock stayed held (and `run` was refused with "already owned"). Commands written to commands/ must be applied within a tick.
test('wedge regression: approve-plan queued as a file (CLI path, no wake) is applied by the supervisor engine within a tick', async (t) => {
  const sb = mk(t, { tasks: { t1: edit('a.txt', 'alpha') } });
  const { dir } = await sb.goal({ id: 'g-a', success_criteria: [{ id: 'c1', text: 'a', check: { argv: ['grep', '-qx', 'alpha', 'a.txt'], timeout_s: 30 } }], plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] } });
  const s = sup(sb); await s.start();
  await until(() => s.state('g-a').S.goal.orch.plan_state === 'awaiting_approval', { what: 'plan awaiting approval' });
  await sleep(300); // the engine is parked: idle, lock held
  const seq = loadHeartbeat(dir).seq;
  const r = await runCli(['approve-plan', 'g-a'], sb.env());
  assert.match(r.out, /queued/); assert.match(r.out, /supervisor/, 'says which engine applies it');
  await until(() => s.state('g-a').S.goal.status === 'achieved', { what: 'goal achieved after file-queued approval', timeoutMs: 30000 });
  assert.ok(loadHeartbeat(dir).seq > seq);
});

test('wedge regression: `run` against a goal owned by a live supervisor explains who owns it instead of silently failing', async (t) => {
  const sb = mk(t, { tasks: { t1: edit('a.txt', 'alpha') } });
  await sb.goal({ id: 'g-a', success_criteria: [{ id: 'c1', text: 'a', check: { argv: ['grep', '-qx', 'alpha', 'a.txt'], timeout_s: 30 } }], plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] } });
  const s = sup(sb); await s.start();
  await until(() => s.state('g-a').S.goal.orch.plan_state === 'awaiting_approval', { what: 'plan awaiting approval' });
  const r = await runCli(['run', 'g-a'], sb.env());
  assert.equal(r.code, 5); assert.match(r.err, /already owned by engine pid \d+/); assert.match(r.err, /aos-orch serve/); assert.match(r.err, /approve-plan/);
});

test('lockStatus: an alive owner with an unconsumed command older than N ticks (or a stale heartbeat on an active goal) is WEDGED and reported as such', async (t) => {
  const sb = mk(t, { tasks: {} });
  const { dir } = await sb.goal({ id: 'g-a', success_criteria: [crit3], plan: plan3() });
  const P = paths(dir); const now = Date.now();
  fs.writeFileSync(P.lock, JSON.stringify({ pid: process.pid, ts: now, token: 'x', label: 'serve' }));
  fs.writeFileSync(P.hb, JSON.stringify({ seq: 2, ts: new Date(now - 600e3).toISOString(), interval_s: 10, status: 'running' }));
  let st = lockStatus(dir); // draft goal: not awaiting approval yet, heartbeat 600 s old vs 50 s limit
  assert.equal(st.wedged, true); assert.match(describeOwner(st), /WEDGED.*supervisor/);
  fs.writeFileSync(P.hb, JSON.stringify({ seq: 2, ts: new Date(now).toISOString(), interval_s: 10, status: 'running' }));
  assert.equal(lockStatus(dir).wedged, false);
  enqueueCommand(dir, { cmd: 'pause' }); const f = fs.readdirSync(P.commands)[0];
  fs.utimesSync(path.join(P.commands, f), new Date(now - 600e3), new Date(now - 600e3));
  st = lockStatus(dir); assert.equal(st.wedged, true); assert.equal(st.pending_commands, 1);
  const r = await runCli(['pause', 'g-a'], sb.env()); assert.match(r.out, /WEDGED/); assert.match(r.err, /wedged/i);
  fs.writeFileSync(P.lock, JSON.stringify({ pid: 2147480001, ts: now, token: 'x', label: 'serve' }));
  assert.match(describeOwner(lockStatus(dir)), /no longer running/);
  // S3: a live pid on a lock older than its ttl is treated as dead (acquireLock would take it over), never reported as WEDGED
  fs.writeFileSync(P.lock, JSON.stringify({ pid: process.pid, ts: now - 61e3, token: 'x', label: 'serve' }));
  st = lockStatus(dir, { nowMs: now }); assert.equal(st.owner_alive, false); assert.equal(st.wedged, false); assert.doesNotMatch(describeOwner(st), /WEDGED/);
  assert.equal(lockStatus(dir, { nowMs: now, ttlMs: 120e3 }).owner_alive, true);
});
