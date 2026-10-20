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
  let r = await run(['run', gf, '--no-wait', '--poll-ms', '50', '--interval-s', '0.2'], env);
  assert.equal(r.code, 4, r.err); assert.equal(JSON.parse(r.out).plan_state, 'awaiting_approval');
  r = await run(['approve-plan', 'g-cli'], env); assert.match(r.out, /queued/);
  r = await run(['run', 'g-cli', '--no-wait', '--poll-ms', '50', '--interval-s', '0.2'], env);
  assert.equal(r.code, 0, r.err + r.out);
  const done = JSON.parse(r.out); assert.equal(done.status, 'achieved'); assert.ok(fs.existsSync(done.report));
  r = await run(['status', 'g-cli'], env); const st = JSON.parse(r.out);
  assert.equal(st.status, 'achieved'); assert.deepEqual(st.tasks, { done: 1 }); assert.equal(st.engine_running, false);
  r = await run(['status'], env); assert.deepEqual(JSON.parse(r.out).map((g) => [g.id, g.status]), [['g-cli', 'achieved']]);
  r = await run(['pause', 'g-cli'], env); assert.match(r.out, /no engine is running/);
  assert.equal(fs.readdirSync(paths(path.join(sb.orch, 'goals', 'g-cli')).commands).length, 1);
  r = await run(['status', 'nope'], env); assert.equal(r.code, 1); assert.match(r.err, /no such goal/);
  r = await run(['bogus'], env); assert.equal(r.code, 2);
});

test('cli: --auto-approve runs plan-to-report without a gate; cancel from another process stops a running goal', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  // --auto-approve only applies to plans without commands: a read-only grep check is on the engine's vetted list (node/make are not)
  const safe = { ...ptask('t1', 'a.txt', 'alpha'), checks: [{ argv: ['grep', '-qx', 'alpha', 'a.txt'], timeout_s: 30 }] };
  sb.scenario({ planner: { behavior: 'success', plan: { tasks: [safe] } }, tasks: { t1: [{ behavior: 'hang' }] } });
  const spec = { id: 'g-cli2', title: 'CLI goal 2', success_criteria: [crit('a.txt', 'alpha')], orch: { repo: sb.repo, check_allowlist: ['grep'] } };
  const gf = path.join(sb.root, 'goal.json'); fs.writeFileSync(gf, JSON.stringify(spec));
  const env = sb.env();
  const running = run(['run', gf, '--auto-approve', '--poll-ms', '50', '--interval-s', '0.2'], env);
  const dir = path.join(sb.orch, 'goals', 'g-cli2');
  for (let i = 0; i < 200; i++) { const ts = readJSON(paths(dir).tasks, []); if (ts[0]?.status === 'running') break; await new Promise((r) => setTimeout(r, 50)); }
  const c = await run(['kill', 'g-cli2'], env); assert.match(c.out, /queued; the attached run \(pid \d+\) will apply it/);
  const r = await running;
  assert.equal(r.code, 3, r.err); assert.equal(JSON.parse(r.out).status, 'cancelled');
  const pf = readJSON(path.join(dir, 'workers', 't1.1.pid.json')); assert.throws(() => process.kill(-pf.pgid, 0), /ESRCH/);
});

test('cli rules: show (user layer and a goal), check (valid / invalid / layers), explain (dry run, nothing written)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const env = sb.env();
  // show without a goal: the defaults; an invalid user file is reported (exit 2)
  let r = await run(['rules', 'show'], env); assert.equal(r.code, 0, r.err); assert.match(r.out, /^rules [0-9a-f]{12}\s+profile=strict/); assert.doesNotMatch(r.out, /LOOSENINGS|NOT APPLIED/, 'empty blocks are hidden');
  fs.writeFileSync(path.join(sb.orch, 'rules.json'), JSON.stringify({ rules_version: 1, budgets: { max_usd: 1 } }));
  r = await run(['rules', 'show'], env); assert.match(r.out, /limits: \$1,/);
  fs.writeFileSync(path.join(sb.orch, 'rules.json'), '{ nope');
  r = await run(['rules', 'show'], env); assert.equal(r.code, 2); assert.match(r.out, /INVALID/);
  fs.rmSync(path.join(sb.orch, 'rules.json'));
  // check
  const good = path.join(sb.root, 'good.json'); fs.writeFileSync(good, JSON.stringify({ rules_version: 1, checks: { allowlist: [{ id: 'nt', cmd: 'node --test' }] } }));
  r = await run(['rules', 'check', good], env); assert.equal(r.code, 0, r.err); assert.match(r.out, /^OK as a user layer/); assert.match(r.out, /LOOSENINGS YOU ARE APPROVING \(1\)/);
  r = await run(['rules', 'check', good, '--layer', 'repo'], env); assert.equal(r.code, 0); assert.match(r.out, /NOT APPLIED \(1/);
  const bad = path.join(sb.root, 'bad.json'); fs.writeFileSync(bad, JSON.stringify({ rules_version: 1, worker: { bash: { allow: [{ id: 'x', cmd: 'sh -c' }] } }, bogus: 1 }));
  r = await run(['rules', 'check', bad], env); assert.equal(r.code, 2); assert.match(r.err, /INVALID/); assert.match(r.err, /bogus/);
  r = await run(['rules', 'check', path.join(sb.root, 'missing.json')], env); assert.equal(r.code, 2);
  r = await run(['rules', 'check', good, '--layer', 'bogus'], env); assert.equal(r.code, 2);
  r = await run(['rules', 'bogus'], env); assert.equal(r.code, 64);
  // explain against a parked goal
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ id: 'g-ex', success_criteria: [crit('a.txt', 'alpha')], plan: { tasks: [ptask('t1', 'a.txt', 'alpha', { cmds: ['sort'] })], risks: [] }, orch: { approval_policy: { plan: 'required' } } });
  r = await run(['rules', 'explain', 'g-ex', 't1', '{"tool_name":"Bash","tool_input":{"command":"ls"}}'], env); assert.equal(r.code, 2); assert.match(r.err, /no intact rules snapshot/);
  const { Engine } = await import('../lib/engine.mjs'); const eng = new Engine({ goalDir: dir, orchDir: sb.orch, env, intervalMs: 200 }); await eng.start(); await eng.tick(); await eng.stop();
  const exp = async (call) => (await run(['rules', 'explain', 'g-ex', 't1', JSON.stringify(call)], env));
  r = await exp({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }); assert.equal(r.code, 0, r.err); assert.match(r.out, /^ALLOW\s+rule default:bash_allow/);
  r = await exp({ tool_name: 'Bash', tool_input: { command: 'sort a.txt' } }); assert.match(r.out, /^ALLOW/); // the task's allowed_commands
  r = await exp({ tool_name: 'Bash', tool_input: { command: 'curl http://x' } }); assert.match(r.out, /^DENY\s+rule floor:dangerous/);
  r = await exp({ tool_name: 'Write', tool_input: { file_path: 'a.txt' } }); assert.match(r.out, /^ALLOW\s+rule default:write_in_scope/);
  r = await exp({ tool_name: 'Write', tool_input: { file_path: '.aos/rules.json' } }); assert.match(r.out, /^DENY\s+rule floor:path_denied/);
  r = await exp({ tool_name: 'Write', tool_input: { file_path: 'other.txt' } }); assert.match(r.out, /^ASK\s+rule default:outside_scope/);
  assert.equal(fs.existsSync(paths(dir).approvals) ? fs.readdirSync(paths(dir).approvals).length : 0, 0, 'a dry run creates no approval');
  r = await run(['rules', 'explain', 'g-ex', 'nope', '{"tool_name":"Bash"}'], env); assert.equal(r.code, 2); assert.match(r.err, /no such task/);
  r = await run(['rules', 'explain', 'g-ex', 't1', '{bad'], env); assert.equal(r.code, 2); assert.match(r.err, /does not parse/);
  r = await run(['rules', 'show', 'g-ex'], env); assert.match(r.out, /^rules [0-9a-f]{12}/);
});

test('cli: --help and -h list every command and exit 0; an unknown command exits 2', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup()); const env = sb.env();
  for (const f of ['--help', '-h']) { const r = await run([f], env); assert.equal(r.code, 0); for (const w of ['draft', 'run', 'status', 'plan', 'approve-plan', 'confirm', 'rules', 'serve', '--no-wait']) assert.ok(r.out.includes(w), w); }
  const r = await run(['frobnicate'], env); assert.equal(r.code, 2); assert.match(r.err, /unknown command/);
});
