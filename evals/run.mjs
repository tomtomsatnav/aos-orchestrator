#!/usr/bin/env node
// Opt-in model-behaviour evals (alignment doc row 8). NOT part of `npm test`. Runs N tiny tasks x k trials through draft -> plan -> run with
// `--sandbox-workers`, grades each result with a deterministic grader, and reports pass^k, mean tokens and mean wall time as JSON + a markdown table.
//   node evals/run.mjs --k 3 --tier haiku [--task id,id] [--timeout-s 900] [--out evals/results] [--fake]
// Real mode spends subscription quota (planner on opus per the rules, workers from --tier). --fake runs everything against orchestrator/test/fake-claude.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TASKS } from './tasks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'orchestrator', 'bin', 'aos-orch.mjs');
const FAKE = path.join(HERE, '..', 'orchestrator', 'test', 'fake-claude.mjs');
const FAKE_ENV = path.join(HERE, '..', 'orchestrator', 'test', 'enable-fake-env.mjs'); // the engine only forwards the fake's scenario variables when this is preloaded

function parseFlags(argv) {
  const f = { k: 3, tier: 'haiku', 'timeout-s': 900, fake: false, task: null, out: path.join(HERE, 'results') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2); if (name === 'fake') { f.fake = true; continue; }
    if (!(name in f)) throw new Error(`unknown flag ${a}`);
    f[name] = argv[++i]; if (f[name] === undefined) throw new Error(`${a} needs a value`);
  }
  f.k = Number(f.k); f['timeout-s'] = Number(f['timeout-s']);
  if (!Number.isInteger(f.k) || f.k < 1 || f.k > 20) throw new Error('--k must be 1-20');
  if (!['haiku', 'sonnet', 'opus'].includes(f.tier)) throw new Error('--tier must be haiku, sonnet or opus');
  if (!(f['timeout-s'] > 0)) throw new Error('--timeout-s must be > 0');
  return f;
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Runs the CLI; resolves {code, stdout, stderr, timedOut}. The whole process group is killed on timeout. */
function cli(args, { env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { timedOut = true; try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    c.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr, timedOut }); });
  });
}
const jsonOf = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function trial(task, n, flags) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aos-eval-${task.id}-`)));
  const repo = path.join(root, 'repo'); const orch = path.join(root, 'orch'); fs.mkdirSync(repo); fs.mkdirSync(orch);
  const t0 = Date.now(); const res = { task: task.id, trial: n, pass: false, why: '', status: null, new_tokens: 0, notional_usd: 0, wall_s: 0, plan_needed_approval: false, human_confirm: null };
  try {
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'eval'); git(repo, 'config', 'user.email', 'eval@example.invalid'); git(repo, 'config', 'commit.gpgsign', 'false');
    task.seed(repo); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'seed');
    const env = { ...process.env, AOS_ORCH_DIR: orch };
    if (flags.fake) {
      const scen = { draft: { behavior: 'success', plan_format: 'fenced', usage: { input_tokens: 100, output_tokens: 200 }, draft: task.fake.draft },
        planner: { behavior: 'success', usage: { input_tokens: 100, output_tokens: 300 }, plan: task.fake.plan }, default: { behavior: 'success' },
        tasks: { t1: [{ behavior: 'success', edits: task.fake.edits, message: 'Done.', usage: { input_tokens: 100, output_tokens: 200 } }],
          ...(task.fake.accept ? { t0: [{ behavior: 'success', edits: [{ path: 'test/accept.test.js', content: task.fake.accept }], message: 'Done.', usage: { input_tokens: 100, output_tokens: 200 } }] } : {}) } };
      fs.writeFileSync(path.join(root, 'scenario.json'), JSON.stringify(scen)); fs.mkdirSync(path.join(root, 'fake-state'));
      Object.assign(env, { NODE_OPTIONS: `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--import=${FAKE_ENV}`, AOS_CLAUDE_BIN: FAKE, AOS_FAKE_SCENARIO: path.join(root, 'scenario.json'), AOS_FAKE_STATE: path.join(root, 'fake-state') });
    }
    const left = () => Math.max(1000, flags['timeout-s'] * 1000 - (Date.now() - t0));
    const goalFile = path.join(root, 'goal.json');
    const d = await cli(['draft', task.prompt, '--repo', repo, '--out', goalFile, '--profile', task.profile, '--tier', flags.tier], { env, cwd: root, timeoutMs: left() });
    if (d.code !== 0 || !fs.existsSync(goalFile)) { res.why = `draft failed (exit ${d.code}${d.timedOut ? ', timed out' : ''}): ${d.stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`; return res; }
    const flagsFor = () => ['--no-wait', '--poll-ms', flags.fake ? '100' : '2000', '--interval-s', flags.fake ? '1' : '5'];
    const readGoal = (id) => jsonOf(fs.readFileSync(path.join(orch, 'goals', id, 'goal.json'), 'utf8'));
    const usageOf = (id) => { try { const g = readGoal(id); res.new_tokens = g?.orch?.usage?.new_tokens ?? 0; res.notional_usd = g?.orch?.usage?.notional_usd ?? 0; } catch { /* no goal dir yet */ } };
    const checkout = path.join(root, 'result');
    const extract = (id) => { fs.rmSync(checkout, { recursive: true, force: true }); fs.mkdirSync(checkout);
      execFileSync('sh', ['-c', 'git archive "$0" | tar -x -C "$1"', `aos/${id}/integration`, checkout], { cwd: repo, stdio: 'ignore' }); };
    // --no-wait: the eval never stays attached at a human gate; it stands in for the human at each gate and records that it did
    let r = await cli(['run', goalFile, '--auto-approve', '--sandbox-workers', ...flagsFor()], { env, cwd: root, timeoutMs: left() });
    let info = jsonOf(r.stdout);
    if (r.code === 4 && info?.goal) { // the engine will not auto-approve a plan with commands
      res.plan_needed_approval = true;
      await cli(['approve-plan', info.goal], { env, cwd: root, timeoutMs: 60000 });
      r = await cli(['run', info.goal, ...flagsFor()], { env, cwd: root, timeoutMs: left() });
      info = jsonOf(r.stdout);
    }
    const pending = /^awaiting human confirmation: (.+)$/.exec(String(info?.blocked_reason || ''));
    if (!r.timedOut && info?.goal && pending) { // the draft asked for human sign-off: the deterministic grader is the human here. Confirm only if it passes
      res.human_confirm = pending[1].split(',').map((c) => c.trim());
      let v; try { extract(info.goal); v = task.grade(checkout); } catch { v = null; }
      if (v?.ok) {
        for (const c of res.human_confirm) await cli(['confirm', info.goal, c], { env, cwd: root, timeoutMs: 60000 });
        r = await cli(['run', info.goal, ...flagsFor()], { env, cwd: root, timeoutMs: left() });
        info = jsonOf(r.stdout);
      }
    }
    { const ids = (() => { try { return fs.readdirSync(path.join(orch, 'goals')); } catch { return []; } })(); // one goal per trial: its usage is recorded even when the trial times out
      const id = info?.goal || (ids.length === 1 ? ids[0] : null); if (id) { res.goal = id; usageOf(id); } }
    if (r.timedOut) { res.why = 'trial timed out'; res.status = 'timeout'; return res; }
    if (!info?.goal) { res.why = `run produced no result (exit ${r.code})`; return res; }
    res.status = info.status;
    try { extract(info.goal); } catch { res.why = `no integration branch (status ${info.status})`; return res; }
    const v = task.grade(checkout);
    res.pass = v.ok; res.why = v.why;
  } catch (e) { res.why = `harness error: ${String(e.message).slice(0, 200)}`; } finally {
    res.wall_s = Math.round((Date.now() - t0) / 100) / 10;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(`${repo}-aos-worktrees`, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return res;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export function summarize(results, k) {
  const byTask = {};
  for (const r of results) (byTask[r.task] ||= []).push(r);
  const tasks = Object.entries(byTask).map(([id, rs]) => ({ task: id, trials: rs.length, passes: rs.filter((r) => r.pass).length, pass_all_k: rs.length === k && rs.every((r) => r.pass),
    mean_new_tokens: Math.round(mean(rs.map((r) => r.new_tokens))), mean_wall_s: Math.round(mean(rs.map((r) => r.wall_s)) * 10) / 10 }));
  return { k, tasks, pass_hat_k: tasks.length ? tasks.filter((t) => t.pass_all_k).length / tasks.length : 0, pass_rate: results.length ? results.filter((r) => r.pass).length / results.length : 0,
    mean_new_tokens: Math.round(mean(results.map((r) => r.new_tokens))), mean_wall_s: Math.round(mean(results.map((r) => r.wall_s)) * 10) / 10 };
}
export function renderTable(s) {
  const L = [`| task | passes/${s.k} | pass^${s.k} | mean new tokens | mean wall (s) |`, '|---|---|---|---|---|'];
  for (const t of s.tasks) L.push(`| ${t.task} | ${t.passes}/${t.trials} | ${t.pass_all_k ? 'yes' : 'no'} | ${t.mean_new_tokens} | ${t.mean_wall_s} |`);
  L.push(`| **all** | ${(s.pass_rate * 100).toFixed(0)}% | ${(s.pass_hat_k * 100).toFixed(0)}% of tasks | ${s.mean_new_tokens} | ${s.mean_wall_s} |`);
  return L.join('\n');
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const want = flags.task ? String(flags.task).split(',') : null;
  const tasks = TASKS.filter((t) => !want || want.includes(t.id));
  if (!tasks.length) throw new Error(`no such task (have: ${TASKS.map((t) => t.id).join(', ')})`);
  if (!flags.fake) console.error(`REAL RUN: ${tasks.length} tasks x ${flags.k} trials will call the real claude CLI and use plan quota. Ctrl-C now to abort.`);
  const results = [];
  for (const task of tasks) for (let n = 1; n <= flags.k; n++) results.push(await trial(task, n, flags));
  const summary = summarize(results, flags.k);
  const doc = { generated_at: new Date().toISOString(), mode: flags.fake ? 'fake' : 'real', tier: flags.tier, summary, results };
  fs.mkdirSync(flags.out, { recursive: true });
  const base = path.join(flags.out, `eval-${doc.mode}-${doc.generated_at.replace(/[:.]/g, '-')}`);
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(doc, null, 2)}\n`); fs.writeFileSync(`${base}.md`, `${renderTable(summary)}\n`);
  console.log(renderTable(summary)); console.error(`wrote ${base}.json and .md`);
  const bad = results.filter((r) => !r.pass); for (const r of bad) console.error(`FAIL ${r.task}#${r.trial}: ${r.why}`);
  process.exit(bad.length ? 1 : 0);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`evals: ${e.message}`); process.exit(64); });
