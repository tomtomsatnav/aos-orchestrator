// Control server end to end: goals created over HTTP run through the supervisor with the fake claude in throwaway repos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkSandbox, git, ptask, edit, fakeCalls, procsAlive, sleep, types } from './helpers.mjs';
import { startStack, until, goalBody, createAndPlan, approve, detail, waitStatus } from './server-helpers.mjs';
import { readEvents, readJSON, goalDirOf, paths } from '../lib/state.mjs';

const plan3 = () => ({ tasks: [ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta', { deps: ['t1'] }), ptask('t3', 'c.txt', 'gamma', { deps: ['t2'] })], risks: [] });
const small = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

async function setup(t, scenario, o = {}) {
  const sb = mkSandbox('aos-srv'); sb.scenario(scenario);
  const s = await startStack(sb, o);
  t.after(async () => { for (const st of sb.stacks) await st.stop().catch(() => {}); sb.cleanup(); });
  return { sb, s };
}
const noPaths = (s, sb) => {
  for (const b of s.bodies) for (const bad of ['/Users/', sb.root, os.tmpdir(), fs.realpathSync(os.tmpdir())]) assert.ok(!b.includes(bad), `response leaks "${bad}": ${b.slice(0, 200)}`);
};

test('e2e: create over HTTP -> plan -> review -> approve -> runs to completion; detail reflects tasks and tokens; audit trail; no paths leak', async (t) => {
  const { sb, s } = await setup(t, { planner: { behavior: 'success', plan: plan3() }, tasks: { t1: edit('a.txt', 'alpha'), t2: edit('b.txt', 'beta'), t3: edit('c.txt', 'gamma') } });
  const { id, plan } = await createAndPlan(s, sb.repo);
  assert.equal(plan.plan_state, 'awaiting_approval'); assert.match(plan.plan_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(plan.tasks.map((x) => x.id), ['t1', 't2', 't3']);
  assert.deepEqual(Object.keys(plan.tasks[1]).sort(), ['acceptance', 'allowed_commands', 'allowed_tools', 'beyond_paths', 'beyond_prompt', 'checks', 'depends_on', 'description', 'id', 'output_contract', 'path_scope', 'tier', 'title']);
  assert.match(plan.tasks[0].checks[0].cmd, /^node -e /); assert.equal(plan.tasks[0].checks[0].timeout_s, 30); assert.deepEqual(plan.tasks[1].depends_on, ['t1']);
  let d = await detail(s, id);
  assert.equal(d.status, 'draft'); assert.equal(d.repo_name, 'repo'); assert.equal(d.tasks_total, 3); assert.equal(d.approvals_pending, 0);
  assert.equal((await s.api('POST', `/api/goals/${id}/plan/approve`, { plan_hash: 'a'.repeat(64) })).status, 409, 'a wrong hash is refused');
  assert.equal((await s.api('POST', `/api/goals/${id}/plan/approve`, {})).status, 400);
  assert.equal((await approve(s, id)).status, 200);
  d = await waitStatus(s, id, 'achieved');
  assert.deepEqual(d.tasks.map((x) => x.status), ['done', 'done', 'done']);
  assert.equal(d.tasks_done, 3); assert.equal(d.tasks_failed, 0); assert.ok(d.budget.used_new_tokens > 4000); assert.ok(d.tasks.every((x) => x.new_tokens > 0 && x.check_summary === 'checks passed' && x.attempts === 1 && x.tier === 'haiku'));
  assert.deepEqual(d.criteria.map((c) => c.met), [true]); assert.ok(d.last_events.length > 0 && d.last_events.length <= 25);
  assert.deepEqual(Object.keys(d.budget).sort(), ['max_attempts', 'max_new_tokens', 'max_parallel', 'max_wall_s', 'running', 'used_new_tokens', 'used_wall_s']);
  const list = (await s.api('GET', '/api/goals')).json.goals;
  assert.equal(list.length, 1); assert.equal(list[0].id, id); assert.equal(list[0].status, 'achieved');
  assert.equal(git(sb.repo, 'show', `aos/${id}/integration:c.txt`), 'gamma');
  assert.equal(procsAlive(goalDirOf(sb.orch, id)).length, 0);
  // events paging
  const p1 = (await s.api('GET', `/api/goals/${id}/events?after=0&limit=5`)).json;
  assert.equal(p1.events.length, 5); assert.equal(p1.has_more, true); assert.equal(p1.next_after, p1.events[4].seq);
  const p2 = (await s.api('GET', `/api/goals/${id}/events?after=${p1.next_after}&limit=500`)).json;
  assert.ok(p2.events[0].seq === p1.next_after + 1 && p2.has_more === false);
  assert.equal((await s.api('GET', `/api/goals/${id}/events?limit=0`)).status, 400);
  assert.equal((await s.api('GET', `/api/goals/${id}/events?after=-1`)).status, 400);
  // audit trail: human.note by actor control with a session hash, never a token
  const audit = readEvents(goalDirOf(sb.orch, id)).filter((e) => e.actor === 'control');
  assert.deepEqual(audit.map((e) => e.data.action), ['goal.create', 'plan.approve', 'plan.approve'], 'attempts are audited too (the refused wrong-hash call included)');
  assert.ok(audit.every((e) => e.type === 'human.note' && e.data.audit === true && e.data.session === 'cli'));
  assert.ok(!fs.readFileSync(paths(goalDirOf(sb.orch, id)).events, 'utf8').includes(s.token));
  assert.equal((await s.api('POST', `/api/goals/${id}/pause`)).status, 409, 'terminal goals cannot be paused');
  noPaths(s, sb);
});

test('create validation: strict fields, repo checks (missing, not git, inside the orchestrator dir), repo-config refusal is 422, plan_approval is human only', async (t) => {
  const { sb, s } = await setup(t, {});
  const post = (b) => s.api('POST', '/api/goals', b);
  const ok = goalBody(sb.repo);
  for (const [name, b] of Object.entries({ extra: { ...ok, evil: 1 }, noTitle: { ...ok, title: '' }, relRepo: { ...ok, repo: 'repo' }, noCrit: { ...ok, success_criteria: [] }, critExtra: { ...ok, success_criteria: [{ text: 'x', check: {} }] },
    budgets: { ...ok, budgets: { max_parallel: 99 } }, budgetsExtra: { ...ok, budgets: { max_usd: 1 } }, auto: { ...ok, plan_approval: 'auto' }, branch: { ...ok, base_branch: '--evil' }, trust: { ...ok, trust_repo_config: 'yes' }, arr: [], allow: { ...ok, check_allowlist: [1] } })) {
    const r = await post(b); assert.equal(r.status, 400, `${name}: ${r.text}`); assert.match(r.json.error.code, /^invalid_/);
  }
  assert.equal((await post({ ...ok, repo: path.join(sb.root, 'missing') })).status, 422);
  fs.mkdirSync(path.join(sb.root, 'plain')); assert.equal((await post({ ...ok, repo: path.join(sb.root, 'plain') })).status, 422);
  const inner = path.join(sb.orch, 'inner'); fs.mkdirSync(inner); git(inner, 'init', '-q', '-b', 'main'); git(inner, 'config', 'user.email', 't@x.invalid'); git(inner, 'config', 'user.name', 't'); fs.writeFileSync(path.join(inner, 'f'), 'x'); git(inner, 'add', '-A'); git(inner, 'commit', '-q', '-m', 'i');
  const forb = await post({ ...ok, repo: inner }); assert.equal(forb.status, 422); assert.equal(forb.json.error.code, 'forbidden_repo');
  const srcDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  assert.equal((await post({ ...ok, repo: srcDir })).json.error.code, 'forbidden_repo');
  fs.mkdirSync(path.join(sb.repo, '.claude')); fs.writeFileSync(path.join(sb.repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-q', '-m', 'hostile');
  const ref = await post(ok); assert.equal(ref.status, 422); assert.equal(ref.json.error.code, 'goal_refused'); assert.match(ref.json.error.message, /refusing repo repo/);
  assert.ok(!ref.text.includes(sb.root));
  assert.equal((await s.api('GET', '/api/goals')).json.goals.length, 0, 'nothing was created');
  noPaths(s, sb);
});

test('approvals over HTTP: worker "ask" -> pending -> approve (scope task) -> task proceeds; deny works; ids are goal-qualified', async (t) => {
  const askPlan = { tasks: [{ ...ptask('t1', 'a.txt', 'alpha'), checks: ptask('t1', 'z.txt', 'zed').checks }], risks: [] };
  const { sb, s } = await setup(t, { planner: { behavior: 'success', plan: askPlan }, tasks: { t1: [{ behavior: 'success', delay_ms: 100, edits: [{ path: 'z.txt', content: 'zed\n' }] }] } });
  const { id } = await createAndPlan(s, sb.repo);
  await approve(s, id);
  const pend = await until(async () => { const l = (await s.api('GET', '/api/approvals')).json.approvals; return l.length ? l : null; }, { what: 'pending approval' });
  const a = pend[0];
  assert.equal(a.goal_id, id); assert.equal(a.task_id, 't1'); assert.equal(a.kind, 'write'); assert.equal(a.status, 'pending'); assert.equal(a.id, `${id}~A-1`);
  assert.match(a.summary, /z\.txt/); assert.ok(!a.summary.includes(sb.root)); assert.ok(a.expires_at > a.created_at);
  assert.ok(a.cwd === '.' || !a.cwd.startsWith('/'), `cwd ${a.cwd}`);
  assert.equal((await detail(s, id)).approvals_pending, 1);
  assert.equal((await s.api('POST', `/api/approvals/${a.id}/approve`, { scope: 'forever' })).status, 400);
  assert.equal((await s.api('POST', `/api/approvals/nope/approve`, {})).status, 400);
  assert.equal((await s.api('POST', `/api/approvals/${id}~A-99/approve`, {})).status, 404);
  const r = await s.api('POST', `/api/approvals/${a.id}/approve`, { scope: 'task' });
  assert.equal(r.status, 200); assert.equal(r.json.approval.status, 'approved');
  assert.equal((await s.api('POST', `/api/approvals/${a.id}/deny`, {})).status, 409, 'already decided');
  const d = await waitStatus(s, id, 'achieved');
  assert.equal(d.tasks[0].attempts, 1); assert.equal(git(sb.repo, 'show', `aos/${id}/integration:z.txt`), 'zed');
  assert.equal((await s.api('GET', '/api/approvals')).json.approvals.length, 0);
  assert.equal((await s.api('GET', '/api/approvals?status=approved')).json.approvals.length, 1);
  assert.equal((await s.api('GET', '/api/approvals?status=bogus')).status, 400);
  const ev = readEvents(goalDirOf(sb.orch, id));
  assert.ok(ev.some((e) => e.type === 'human.approve' && e.task_id === 't1'));
  assert.ok(ev.some((e) => e.actor === 'control' && e.data.action === 'approval.approve' && e.data.scope === 'task'));
  // deny path on a second goal: the worker is told no, the write never lands
  const g2 = await createAndPlan(s, sb.repo);
  await approve(s, g2.id);
  const p2 = await until(async () => (await s.api('GET', '/api/approvals')).json.approvals.find((x) => x.goal_id === g2.id), { what: 'second approval' });
  const dn = await s.api('POST', `/api/approvals/${p2.id}/deny`, {});
  assert.equal(dn.json.approval.status, 'denied');
  await s.api('POST', `/api/goals/${g2.id}/cancel`, {});
  assert.equal(git(sb.repo, 'ls-tree', '--name-only', `aos/${g2.id}/integration`).includes('z.txt'), false);
  noPaths(s, sb);
});

test('pause stops dispatch, resume continues; cancel and kill leave no processes; kill needs confirm', async (t) => {
  const { sb, s } = await setup(t, { planner: { behavior: 'success', plan: plan3() }, tasks: { t1: edit('a.txt', 'alpha'), t2: edit('b.txt', 'beta'), t3: edit('c.txt', 'gamma') } }, { sup: { maxWorkers: 4 } });
  const a = await createAndPlan(s, sb.repo);
  const p = await s.api('POST', `/api/goals/${a.id}/pause`);
  assert.equal(p.status, 200); assert.equal(p.json.goal.paused_reason, 'paused by a human'); assert.equal(p.json.applied, true);
  await approve(s, a.id); await sleep(700);
  assert.equal(fakeCalls(sb, 't1').length, 0, 'paused: nothing dispatched'); assert.equal((await detail(s, a.id)).tasks[0].status, 'ready');
  assert.equal((await s.api('POST', `/api/goals/${a.id}/resume`)).status, 200);
  await waitStatus(s, a.id, 'achieved');
  // hanging workers: cancel one goal, kill the other
  sb.scenario({ planner: { behavior: 'success', plan: { tasks: [ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta')], risks: [] } }, default: { behavior: 'hang', ignore_sigterm: true } });
  const g1 = await createAndPlan(s, sb.repo); const g2 = await createAndPlan(s, sb.repo);
  await approve(s, g1.id); await approve(s, g2.id);
  const running = (id) => until(async () => { const d = await detail(s, id); return d.tasks.filter((x) => x.status === 'running').length === 2 ? d : null; }, { what: `${id} running` });
  await running(g1.id); await running(g2.id);
  assert.equal(procsAlive(goalDirOf(sb.orch, g1.id)).length, 2);
  const c = await s.api('POST', `/api/goals/${g1.id}/cancel`);
  assert.equal(c.status, 200); assert.equal(c.json.goal.status, 'cancelled'); assert.equal(procsAlive(goalDirOf(sb.orch, g1.id)).length, 0);
  assert.equal((await s.api('POST', `/api/goals/${g2.id}/kill`, {})).status, 400, 'confirm required');
  assert.equal((await s.api('POST', `/api/goals/${g2.id}/kill`, { confirm: 'yes' })).status, 400);
  assert.equal(procsAlive(goalDirOf(sb.orch, g2.id)).length, 2, 'still running after the refused kill');
  const k = await s.api('POST', `/api/goals/${g2.id}/kill`, { confirm: true });
  assert.equal(k.json.goal.status, 'cancelled'); assert.equal(procsAlive(goalDirOf(sb.orch, g2.id)).length, 0);
  assert.deepEqual((await detail(s, g2.id)).tasks.map((x) => x.status), ['cancelled', 'cancelled']);
  assert.equal(s.sup.workerCount(), 0);
  assert.equal((await s.api('POST', `/api/goals/${g2.id}/cancel`)).status, 409);
  noPaths(s, sb);
});

test('budget exhaustion blocks the goal; resume is refused until PATCH budgets raises the cap; then it completes', async (t) => {
  const { sb, s } = await setup(t, { planner: { behavior: 'success', usage: small, plan: plan3() }, tasks: { t1: edit('a.txt', 'alpha'), t2: edit('b.txt', 'beta'), t3: edit('c.txt', 'gamma') } });
  const { id } = await createAndPlan(s, sb.repo, { budgets: { max_new_tokens: 8000, max_wall_s: 3600, max_parallel: 3, max_attempts: 3 } });
  await approve(s, id);
  const b = await waitStatus(s, id, 'blocked');
  assert.match(b.blocked_reason, /new-token cap reached/); assert.ok(b.budget.used_new_tokens >= 8000); assert.deepEqual(b.tasks.map((x) => x.status), ['done', 'done', 'ready']);
  const early = await s.api('POST', `/api/goals/${id}/resume`);
  assert.equal(early.status, 409); assert.equal(early.json.error.code, 'budget_exceeded');
  for (const bad of [{}, { max_new_tokens: 'lots' }, { max_new_tokens: 0 }, { max_parallel: 100 }, { evil: 1 }, { max_new_tokens: 1.5 }]) assert.equal((await s.api('PATCH', `/api/goals/${id}/budgets`, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await s.api('PATCH', `/api/goals/${id}/budgets`, [1])).status, 400);
  const pr = await s.api('PATCH', `/api/goals/${id}/budgets`, { max_new_tokens: 1000000, max_wall_s: 7200 });
  assert.equal(pr.status, 200); assert.equal(pr.json.goal.budget.max_new_tokens, 1000000); assert.equal(pr.json.goal.budget.max_wall_s, 7200); assert.equal(pr.json.goal.status, 'blocked');
  const rs = await s.api('POST', `/api/goals/${id}/resume`);
  assert.equal(rs.status, 200);
  const d = await waitStatus(s, id, 'achieved');
  assert.deepEqual(d.tasks.map((x) => x.status), ['done', 'done', 'done']); assert.equal(fakeCalls(sb, 't3').length, 1);
  const tys = types(goalDirOf(sb.orch, id));
  assert.ok(tys.includes('orch.budgets.updated') && tys.includes('orch.goal.unblocked') && tys.includes('budget.exceeded'));
  assert.equal(git(sb.repo, 'show', `aos/${id}/integration:c.txt`), 'gamma');
  // a goal blocked by something else (a failed task) is not resumable
  noPaths(s, sb);
});

for (const mode of ['crash', 'graceful-kill']) {
  test(`restart recovery (${mode}): a new server re-adopts the goal and it finishes exactly once`, async (t) => {
    const plan = { tasks: [ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta', { deps: ['t1'] })], risks: [] };
    const { sb, s } = await setup(t, { planner: { behavior: 'success', plan }, tasks: { t1: { behavior: 'success', delay_ms: 1200, edits: [{ path: 'a.txt', content: 'alpha\n' }] }, t2: edit('b.txt', 'beta') } }, { sup: { pid: 2147480101 } });
    const { id } = await createAndPlan(s, sb.repo);
    await approve(s, id);
    await until(async () => (await detail(s, id)).tasks[0].status === 'running', { what: 't1 running' });
    const oldToken = s.token;
    if (mode === 'crash') { await s.srv.close(); s.sup.crash(); } else await s.stop({ workers: 'kill' });
    const s2 = await startStack(sb);
    assert.equal(s2.token, oldToken, 'the CLI token persists across restarts');
    assert.equal((await s2.req({ path: '/api/goals', headers: { Authorization: `Bearer ${'0'.repeat(64)}` } })).status, 401);
    const d = await waitStatus(s2, id, 'achieved');
    assert.deepEqual(d.tasks.map((x) => [x.status, x.attempts]), [['done', 1], ['done', 1]]);
    const started = readEvents(goalDirOf(sb.orch, id)).filter((e) => e.type === 'task.started' && e.task_id === 't1').length;
    assert.equal(started, mode === 'crash' ? 1 : 2, mode === 'crash' ? 're-adopted, never dispatched twice' : 'killed worker was requeued once, uncounted');
    assert.equal(fakeCalls(sb, 't2').length, 1);
    const ev = types(goalDirOf(sb.orch, id));
    assert.equal(ev.filter((x) => x === 'orch.integrate.merged').length, 2);
    assert.ok(ev.includes(mode === 'crash' ? 'orch.worker.adopted' : 'orch.worker.lost'));
    assert.equal(git(sb.repo, 'log', '--merges', '--oneline', `aos/${id}/integration`).split('\n').length, 2);
  });
}

test('SSE stream: header auth only, delivers goal events as they happen', async (t) => {
  const { sb, s } = await setup(t, { planner: { behavior: 'success', plan: plan3() } }, { srv: { sseIntervalMs: 50 } });
  const { id } = await createAndPlan(s, sb.repo);
  assert.equal((await s.req({ path: '/api/stream' })).status, 401);
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${s.port}/api/stream?goal=${id}`, { headers: { Authorization: `Bearer ${s.token}` }, signal: ctl.signal });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader(); let text = '';
  const pump = (async () => { for (;;) { const { value, done } = await reader.read().catch(() => ({ done: true })); if (done) return; text += Buffer.from(value).toString(); } })();
  await s.api('POST', `/api/goals/${id}/pause`);
  await until(() => text.includes('human.pause'), { what: 'pause event on the stream' });
  assert.match(text, /event: goal_event/); assert.ok(!text.includes(sb.root)); assert.ok(!text.includes(s.token));
  ctl.abort(); await pump.catch(() => {});
});
