// The aos-orch CLI end to end against the fake claude: run a goal headless, read status, queue commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkSandbox, ptask, crit, edit, HERE } from './helpers.mjs';
import { paths, readJSON } from '../lib/state.mjs';

const CLI = path.join(HERE, '..', 'bin', 'aos-orch.mjs');
const run = (args, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => resolve({ code, out, err }));
});

test('cli: run <goal.json> to completion, then status / queued commands operate on the on-disk state', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: { behavior: 'success', plan: { tasks: [ptask('t1', 'a.txt', 'alpha')] } }, tasks: { t1: [edit('a.txt', 'alpha')] } });
  const spec = { id: 'g-cli', title: 'CLI goal', success_criteria: [crit('a.txt', 'alpha')], budget: { max_ticks: 1000, max_usd: 5, max_wall_clock_s: 600 },
    orch: { repo: sb.repo, base_branch: 'main', check_allowlist: ['node'] } };
  const gf = path.join(sb.root, 'goal.json'); fs.writeFileSync(gf, JSON.stringify(spec));
  const env = sb.env();

  // plan approval is required by default: the run stops cleanly at the approval gate (exit 4)
  let r = await run(['run', gf, '--poll-ms', '50', '--interval-s', '0.2'], env);
  assert.equal(r.code, 4, r.err); assert.equal(JSON.parse(r.out).plan_state, 'awaiting_approval');
  r = await run(['approve-plan', 'g-cli'], env); assert.match(r.out, /queued/);
  r = await run(['run', 'g-cli', '--poll-ms', '50', '--interval-s', '0.2'], env);
  assert.equal(r.code, 0, r.err + r.out);
  const done = JSON.parse(r.out); assert.equal(done.status, 'achieved'); assert.ok(fs.existsSync(done.report));
  r = await run(['status', 'g-cli'], env); const st = JSON.parse(r.out);
  assert.equal(st.status, 'achieved'); assert.deepEqual(st.tasks, { done: 1 }); assert.equal(st.engine_running, false);
  r = await run(['status'], env); assert.deepEqual(JSON.parse(r.out).map((g) => [g.id, g.status]), [['g-cli', 'achieved']]);
  r = await run(['pause', 'g-cli'], env); assert.match(r.out, /no engine is running/);
  assert.equal(fs.readdirSync(paths(path.join(sb.orch, 'goals', 'g-cli')).commands).length, 1);
  r = await run(['status', 'nope'], env); assert.equal(r.code, 1); assert.match(r.err, /no such goal/);
  r = await run(['bogus'], env); assert.equal(r.code, 64);
});

test('cli: --auto-approve runs plan-to-report without a gate; cancel from another process stops a running goal', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: { behavior: 'success', plan: { tasks: [ptask('t1', 'a.txt', 'alpha')] } }, tasks: { t1: [{ behavior: 'hang' }] } });
  const spec = { id: 'g-cli2', title: 'CLI goal 2', success_criteria: [crit('a.txt', 'alpha')], orch: { repo: sb.repo, check_allowlist: ['node'] } };
  const gf = path.join(sb.root, 'goal.json'); fs.writeFileSync(gf, JSON.stringify(spec));
  const env = sb.env();
  const running = run(['run', gf, '--auto-approve', '--poll-ms', '50', '--interval-s', '0.2'], env);
  const dir = path.join(sb.orch, 'goals', 'g-cli2');
  for (let i = 0; i < 200; i++) { const ts = readJSON(paths(dir).tasks, []); if (ts[0]?.status === 'running') break; await new Promise((r) => setTimeout(r, 50)); }
  const c = await run(['kill', 'g-cli2'], env); assert.match(c.out, /queued; the running engine applies it/);
  const r = await running;
  assert.equal(r.code, 3, r.err); assert.equal(JSON.parse(r.out).status, 'cancelled');
  const pf = readJSON(path.join(dir, 'workers', 't1.1.pid.json')); assert.throws(() => process.kill(-pf.pgid, 0), /ESRCH/);
});
