#!/usr/bin/env node
// SWE-bench Verified mini-benchmark for the AOS guard. See evals/swebench/README.md.
//   node evals/swebench/run.mjs --arm bare-haiku|bare-sonnet|guarded|guarded-cascade|guarded-best-of-3[,...] [--instance id,id] [--k 1]
//        [--timeout-s 1200] [--label name] [--keep]
// Per trial: a fresh repo holding ONLY the base commit's tree (one commit, no history, so the fix cannot be read from git), the problem statement as the
// prompt (+ one fixed line), `claude -p` session(s), the guard (pyguard.mjs) for guarded arms, then real grading of every produced patch with the
// swebench Docker harness (hidden FAIL_TO_PASS + PASS_TO_PASS). Guarded arms record `raw_resolved` (the session's patch graded even when the guard
// rejected it) and `resolved` (what the arm ships: the accepted patch, or nothing).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimedSuccess, escalationPrompt, CASCADE } from '../run.mjs';
import { CAPABILITY_KINDS } from '../../orchestrator/lib/guard.mjs';
import { guardTree, treeDiff, dockerEnv, DOCKER_HOST, attemptParts, reproMatrix, selectByRepro } from './pyguard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.SWEBENCH_DATA || path.join(os.homedir(), 'aos-split', '.swebench-data');
const VENV = process.env.SWEBENCH_VENV || path.join(os.homedir(), 'aos-split', '.swebench-venv');
const INSTR = 'Fix this issue in the repository. Do not modify existing tests.';
// best-of-3 only (the same sentence for every attempt): a reproduction test the guard can run against every attempt
const REPRO = 'First write a small reproduction test for the issue in a NEW test file next to the existing tests; it must fail on the original code and pass after your fix.';
export const ARMS = ['bare-haiku', 'bare-sonnet', 'guarded', 'guarded-cascade', 'guarded-best-of-3'];

function parseFlags(argv) {
  const f = { arm: 'bare-haiku', instance: null, k: 1, 'timeout-s': 2400, label: null, keep: false, prune: false, summarize: null, resume: null, out: path.join(HERE, '..', 'results', 'swebench') };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (name === 'keep' || name === 'prune') { f[name] = true; continue; }
    if (!(name in f)) throw new Error(`unknown flag ${argv[i]}`);
    f[name] = argv[++i];
  }
  f.arms = String(f.arm).split(','); for (const a of f.arms) if (!ARMS.includes(a)) throw new Error(`--arm must be in ${ARMS.join(', ')}`);
  f.k = Number(f.k); f['timeout-s'] = Number(f['timeout-s']);
  return f;
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** A bare mirror of the instance's GitHub repo (cached), then a fresh one-commit repo holding the base tree. -> seed sha */
function seedRepo(inst, dir) {
  const mirror = path.join(DATA, 'mirrors', `${inst.repo.replace('/', '__')}.git`);
  if (!fs.existsSync(mirror)) { fs.mkdirSync(path.dirname(mirror), { recursive: true }); execFileSync('git', ['clone', '-q', '--mirror', `https://github.com/${inst.repo}.git`, mirror], { stdio: 'inherit' }); }
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('sh', ['-c', 'git -C "$0" archive "$1" | tar -x -C "$2"', mirror, inst.base_commit, dir]);
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.name', 'eval'); git(dir, 'config', 'user.email', 'eval@example.invalid'); git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A', '-f'); git(dir, 'commit', '-q', '-m', 'base');
  return git(dir, 'rev-parse', 'HEAD');
}

const LIMIT_RE = /hit your .{0,40}limit|usage limit|session limit/i;
/** A trial in which any session was refused by the plan's usage limit: it is discarded and re-run after the quota resets. */
const limitHit = (r) => [r.session, ...(r.steps || []), ...(r.candidates || [])].some((x) => x?.limit_hit);
/** Wait until a tiny probe session is no longer refused (polls every 10 min). */
async function waitForQuota() {
  for (;;) {
    await new Promise((r) => setTimeout(r, 10 * 60 * 1000));
    const s = await session('Reply with the single word OK.', 'haiku', os.tmpdir(), 120000);
    if (!s.limit_hit) return;
    console.error(`${new Date().toISOString()} still at the usage limit: ${s.final_message.slice(0, 120)}`);
  }
}
/** One `claude -p` session, the same command line as evals/run.mjs's bare/guarded arms. */
function session(prompt, model, repo, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const c = spawn('claude', ['-p', prompt, '--model', model, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash Edit Write MultiEdit Read Glob Grep'],
      { cwd: repo, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let timedOut = false;
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', () => {});
    const t = setTimeout(() => { timedOut = true; try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    c.on('close', (code) => {
      clearTimeout(t); let j = {}; try { j = JSON.parse(stdout); } catch { /* none */ }
      const u = j.usage || {};
      resolve({ model, new_tokens: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0), cache_read_tokens: u.cache_read_input_tokens || 0,
        notional_usd: Number(j.total_cost_usd) || 0, num_turns: j.num_turns ?? null, status: timedOut ? 'timeout' : j.is_error ? 'error' : code === 0 ? 'finished' : `exit ${code}`,
        claimed_success: !timedOut && !j.is_error && code === 0 && claimedSuccess(j.result), limit_hit: !!j.is_error && LIMIT_RE.test(String(j.result || '')), final_message: String(j.result || '').slice(-400), wall_s: Math.round((Date.now() - t0) / 100) / 10 });
    });
  });
}

// ---------------------------------------------------------------- serialisation of Docker work (guard runs, grading) to keep the engine's load bounded
let lane = Promise.resolve();
const serial = (fn) => { const p = lane.then(fn, fn); lane = p.catch(() => {}); return p; };

/** Grade one patch with the swebench harness (hidden tests). -> {resolved, f2p, p2p, error?} */
async function grade(inst, patch, tag) {
  if (!patch || !patch.trim()) return { resolved: false, empty_patch: true };
  return serial(async () => {
    const work = path.join(DATA, 'work'); fs.mkdirSync(work, { recursive: true });
    const runId = `${tag}-${Date.now()}`.replace(/[^A-Za-z0-9_.-]/g, '_'); const model = 'aos-swebench';
    const preds = path.join(work, `${runId}.jsonl`);
    fs.writeFileSync(preds, `${JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: model, model_patch: patch })}\n`);
    const t0 = Date.now();
    const r = await new Promise((resolve) => {
      const c = spawn(path.join(VENV, 'bin', 'swebench'), ['eval', 'verified', '-p', preds, '-i', inst.instance_id, '--run-id', runId, '-j', '1', '-t', '1800', '--report-dir', path.join(work, 'reports')],
        { cwd: work, env: dockerEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
      c.on('close', (code) => resolve({ code, out }));
    });
    const rep = path.join(work, 'logs', 'run_evaluation', runId, model, inst.instance_id, 'report.json');
    let j = null; try { j = JSON.parse(fs.readFileSync(rep, 'utf8'))[inst.instance_id]; } catch { /* no report */ }
    const wall_s = Math.round((Date.now() - t0) / 100) / 10;
    if (!j) return { resolved: false, error: `no report (exit ${r.code}): ${r.out.slice(-300)}`, run_id: runId, wall_s };
    const n = (k) => ({ pass: j.tests_status?.[k]?.success?.length ?? 0, fail: j.tests_status?.[k]?.failure?.length ?? 0 });
    return { resolved: !!j.resolved, applied: j.patch_successfully_applied, f2p: n('FAIL_TO_PASS'), p2p: n('PASS_TO_PASS'), infra_failure: !!j.infra_failure, run_id: runId, wall_s };
  });
}

const sumOf = (xs, k) => Math.round(xs.reduce((a, x) => a + (x[k] || 0), 0) * 1e6) / 1e6;
const brief = (g) => ({ accepted: g.accepted, integrity: g.integrity, reasons: g.reasons.slice(0, 6), files: g.files, static_warnings: g.static.warnings, orig_tests: g.py?.orig_tests ?? null,
  orig_selection: g.py?.orig_selection ?? null, agent_tests: g.py?.agent_tests ?? null, protected: g.protected ? { ok: g.protected.ok, baseline_passed: g.protected.baseline_passed, now_passed: g.protected.now_passed, note: g.protected.note } : null,
  checks: g.checks.map((c) => ({ argv: c.argv, ok: c.ok })), duration_s: g.duration_s });

async function trial(inst, arm, n, flags) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `swe-${inst.instance_id}-`)));
  const prompt = `${inst.problem_statement}\n\n${INSTR}`;
  const t0 = Date.now(); const left = () => Math.max(1000, flags['timeout-s'] * 1000 - (Date.now() - t0));
  const res = { instance: inst.instance_id, arm, trial: n, resolved: false };
  try {
    if (arm === 'bare-haiku' || arm === 'bare-sonnet' || arm === 'guarded') {
      const repo = path.join(root, 'repo'); const seed = seedRepo(inst, repo);
      const s = await session(prompt, arm === 'bare-sonnet' ? 'sonnet' : 'haiku', repo, left());
      Object.assign(res, { model: s.model, session: s });
      const { patch, files } = treeDiff(repo, seed); res.files = files.map((f) => `${f.status} ${f.path}`);
      if (arm === 'guarded') { const g = await serial(() => guardTree(inst, repo, seed)); res.guard = brief(g); res.guard_full_reasons = g.reasons; }
      res.grade = await grade(inst, patch, `${inst.instance_id}-${arm}-${n}`);
      res.raw_resolved = res.grade.resolved; res.resolved = res.raw_resolved && (arm !== 'guarded' || res.guard.accepted);
      res.new_tokens = s.new_tokens; res.notional_usd = s.notional_usd;
    } else if (arm === 'guarded-cascade') {
      const repo = path.join(root, 'repo'); const seed = seedRepo(inst, repo);
      res.steps = []; let p = prompt; let g = null;
      for (let i = 0; i < CASCADE.length; i++) {
        const s = await session(p, CASCADE[i], repo, left());
        g = await serial(() => guardTree(inst, repo, seed));
        res.steps.push({ ...s, final_message: undefined, guard: brief(g) });
        if (g.accepted) { res.stop_reason = 'accepted'; break; }
        if (g.integrity) { res.stop_reason = 'integrity'; break; }
        if (!g.rejections.every((r) => CAPABILITY_KINDS.has(r.kind))) { res.stop_reason = 'guard_error'; break; }
        if (i === CASCADE.length - 1) { res.stop_reason = 'ladder_exhausted'; break; }
        if (left() <= 1000) { res.stop_reason = 'timeout'; break; }
        p = escalationPrompt(prompt, g);
      }
      const { patch, files } = treeDiff(repo, seed); res.files = files.map((f) => `${f.status} ${f.path}`);
      res.models_used = res.steps.map((s) => s.model); res.grade = await grade(inst, patch, `${inst.instance_id}-${arm}-${n}`);
      res.raw_resolved = res.grade.resolved; res.resolved = res.raw_resolved && g.accepted;
      res.new_tokens = sumOf(res.steps, 'new_tokens'); res.notional_usd = sumOf(res.steps, 'notional_usd');
    } else if (arm === 'guarded-best-of-3') {
      // three independent haiku sessions in separate copies, in parallel, each asked (same sentence) to write a reproduction test first; each is guarded
      // as it finishes (guards serialised, in completion order). Then the repro cross-check matrix and TWO selections from the same three attempts:
      //   first: the first guard-accepted attempt in completion order (naive);  repro: selectByRepro (most valid repros passed, then agreement, then order)
      let order = 0;
      const repos = [];
      res.candidates = await Promise.all([0, 1, 2].map(async (i) => {
        const repo = path.join(root, `repo${i}`); const seed = seedRepo(inst, repo); repos[i] = { repo, seed };
        const s = await session(`${prompt} ${REPRO}`, 'haiku', repo, left());
        const g = await serial(() => guardTree(inst, repo, seed));
        return { copy: i, finished_order: order++, ...s, final_message: undefined, guard: brief(g), guarded_at_s: Math.round((Date.now() - t0) / 100) / 10 };
      }));
      const parts = repos.map((r) => attemptParts(r.repo, r.seed));
      res.matrix = await serial(() => reproMatrix(inst, parts));
      const sel = selectByRepro(res.candidates, parts, res.matrix);
      for (const c of res.candidates) { const { patch } = treeDiff(repos[c.copy].repo, repos[c.copy].seed); c.grade = await grade(inst, patch, `${inst.instance_id}-${arm}-${n}-c${c.copy}`); c.patch_bytes = patch.length; c.repro_files = parts[c.copy].repro.map((f) => f.path); }
      const first = [...res.candidates].sort((a, b) => a.finished_order - b.finished_order).find((c) => c.guard.accepted);
      const pick = (copy) => res.candidates.find((c) => c.copy === copy);
      res.selections = {
        first: { chosen: first ? first.copy : null, resolved: !!first?.grade.resolved, wall_to_choice_s: first ? first.guarded_at_s : null },
        repro: { chosen: sel.chosen, resolved: sel.chosen !== null && !!pick(sel.chosen).grade.resolved, fallback: sel.fallback, why: sel.why, ranking: sel.ranking },
      };
      res.raw_resolved_any = res.candidates.some((c) => c.grade.resolved);
      res.resolved = res.selections.repro.resolved; res.resolved_first = res.selections.first.resolved;
      res.new_tokens = sumOf(res.candidates, 'new_tokens'); res.notional_usd = sumOf(res.candidates, 'notional_usd');
    }
  } catch (e) { res.error = String(e.stack || e.message).slice(0, 600); } finally {
    res.wall_s = Math.round((Date.now() - t0) / 100) / 10; // includes guard and grading time
    if (flags.keep) res.kept = root; else fs.rmSync(root, { recursive: true, force: true });
  }
  return res;
}

function table(results) {
  const L = ['| instance | arm | resolved | raw resolved (unguarded patch) | guard | new tokens | notional $ | wall s (incl. guard+grading) |', '|---|---|---|---|---|---|---|---|'];
  for (const r0 of results) for (const r of (r0.selections ? ['first', 'repro'].map((k) => ({ ...r0, arm: `${r0.arm}-${k}`, resolved: r0.selections[k].resolved, chosen: r0.selections[k].chosen })) : [r0])) {
    const guard = r.guard ? (r.guard.accepted ? 'accepted' : `REJECTED: ${(r.guard.reasons[0] || '').slice(0, 80)}`) : r.steps ? `${r.models_used.join('>')} ${r.stop_reason}` : r.candidates ? `chosen ${r.chosen ?? 'none'}; accepted ${r.candidates.filter((c) => c.guard.accepted).length}/3; valid repros ${(r.selections.repro.ranking || []).filter((x) => x.repro_valid).length}/3` : '-';
    const raw = r.candidates ? r.candidates.map((c) => (c.grade.resolved ? 'y' : 'n')).join('') : r.raw_resolved ? 'yes' : 'no';
    L.push(`| ${r.instance} | ${r.arm} | ${r.resolved ? 'yes' : 'no'} | ${raw} | ${String(guard).replace(/\|/g, '/')} | ${r.new_tokens ?? '-'} | ${r.notional_usd ?? '-'} | ${r.wall_s} |${r.error ? ` ERROR ${r.error.slice(0, 80)}` : ''}`);
  }
  return L.join('\n');
}

/** Per-arm summary: resolved, tokens, $, wall, guard rejections split by what the hidden tests said (true positive = rejected and unresolved,
 * false rejection = rejected but resolved), escalations, and best-of-3 selection quality. */
export function summarize(results, nInst) {
  const rows = []; const r2 = (x) => Math.round(x * 100) / 100;
  const arms = [...new Set(results.map((r) => r.arm))];
  for (const arm of arms) {
    const rs = results.filter((r) => r.arm === arm);
    const base = { trials: rs.length, new_tokens: rs.reduce((a, r) => a + (r.new_tokens || 0), 0), notional_usd: r2(rs.reduce((a, r) => a + (r.notional_usd || 0), 0)), wall_min: r2(rs.reduce((a, r) => a + (r.wall_s || 0), 0) / 60), errors: rs.filter((r) => r.error).length };
    if (arm === 'guarded-best-of-3') {
      const atts = rs.flatMap((r) => r.candidates || []); const rej = atts.filter((c) => !c.guard.accepted);
      const anyRes = rs.filter((r) => r.raw_resolved_any);
      for (const k of ['first', 'repro']) rows.push({ arm: `${arm}-${k}`, resolved: rs.filter((r) => r.selections?.[k].resolved).length, of: nInst, ...base,
        guard_rejections: `${rej.length}/${atts.length} attempts`, rejected_unresolved: rej.filter((c) => !c.grade.resolved).length, rejected_resolved: rej.filter((c) => c.grade.resolved).length,
        escalations: '-', picked_resolved_when_any: `${anyRes.filter((r) => r.selections[k].resolved).length}/${anyRes.length}`, no_choice: rs.filter((r) => r.selections?.[k].chosen === null).length,
        repro_fallback: k === 'repro' ? rs.filter((r) => r.selections?.repro.fallback).length : '-', valid_repros: k === 'repro' ? `${rs.reduce((a, r) => a + (r.selections?.repro.ranking || []).filter((x) => x.repro_valid).length, 0)}/${atts.length}` : '-',
        attempts_resolved: `${atts.filter((c) => c.grade.resolved).length}/${atts.length}` });
      continue;
    }
    const final = (r) => (r.guard ? r.guard.accepted : r.steps ? r.steps.at(-1).guard.accepted : null);
    const rej = rs.filter((r) => final(r) === false);
    rows.push({ arm, resolved: rs.filter((r) => r.resolved).length, of: nInst, ...base,
      guard_rejections: arm.startsWith('guarded') ? `${rej.length}/${rs.length}` : '-', rejected_unresolved: rej.filter((r) => !r.raw_resolved).length, rejected_resolved: rej.filter((r) => r.raw_resolved).length,
      escalations: arm === 'guarded-cascade' ? rs.reduce((a, r) => a + Math.max(0, (r.steps || []).length - 1), 0) : '-', raw_resolved: rs.filter((r) => r.raw_resolved).length });
  }
  return rows;
}
function summaryTable(rows) {
  const L = ['| arm | resolved | new tokens | notional $ | wall (min, incl. guard+grading) | guard rejections (final) | of which unresolved (true +) | of which resolved (false rejection) | escalations | best-of-3: picked a resolved attempt when >= 1 of 3 resolved | notes |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const x of rows) L.push(`| ${x.arm} | ${x.resolved}/${x.of} | ${x.new_tokens.toLocaleString('en-US')} | ${x.notional_usd} | ${x.wall_min} | ${x.guard_rejections} | ${x.guard_rejections === '-' ? '-' : x.rejected_unresolved} | ${x.guard_rejections === '-' ? '-' : x.rejected_resolved} | ${x.escalations} | ${x.picked_resolved_when_any || '-'} | ${[x.raw_resolved !== undefined && x.arm.startsWith('guarded') ? `unguarded patch resolved ${x.raw_resolved}` : '', x.attempts_resolved ? `attempts resolved ${x.attempts_resolved}` : '', x.valid_repros && x.valid_repros !== '-' ? `valid repros ${x.valid_repros}, fallback ${x.repro_fallback}` : '', x.no_choice ? `no choice ${x.no_choice}` : '', x.errors ? `errors ${x.errors}` : ''].filter(Boolean).join('; ')} |`);
  return L.join('\n');
}

const freeGB = () => Number(execFileSync('df', ['-k', os.homedir()], { encoding: 'utf8' }).trim().split('\n').pop().split(/\s+/)[3]) / 1024 / 1024;
const dockerSync = (...a) => execFileSync('docker', a, { env: dockerEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** Pull the instance image if missing; on a Docker Hub rate limit, wait and retry (up to ~70 min). */
async function ensureImage(image) {
  try { dockerSync('image', 'inspect', image); return; } catch { /* missing */ }
  for (let i = 0; i < 15; i++) {
    try { dockerSync('pull', '--platform', 'linux/amd64', '-q', image); return; } catch (e) {
      const msg = String(e.stderr || e.message); console.error(`pull ${image} failed (${msg.trim().slice(0, 120)}); retry in 5 min`);
      await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
    }
  }
  throw new Error(`could not pull ${image}`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.summarize) { const d = JSON.parse(fs.readFileSync(flags.summarize, 'utf8')); console.log(summaryTable(summarize(d.results, new Set(d.results.map((r) => r.instance)).size))); return; }
  const { instances } = JSON.parse(fs.readFileSync(path.join(HERE, 'subset.json'), 'utf8'));
  const want = flags.instance ? String(flags.instance).split(',') : null;
  const insts = instances.filter((i) => !want || want.includes(i.instance_id));
  if (!insts.length) throw new Error('no such instance');
  console.error(`REAL RUN: ${insts.length} instances x ${flags.arms.join(',')} x k=${flags.k}; Docker at ${DOCKER_HOST}; uses plan quota.`);
  fs.mkdirSync(flags.out, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(flags.out, `swebench-${flags.label ? `${flags.label.replace(/[^A-Za-z0-9_-]/g, '')}-` : ''}${ts}`);
  const results = []; const pruned = []; let stopped = null;
  if (flags.resume) { // keep the finished trials of an earlier run (not those refused by the usage limit), run the rest
    for (const r of JSON.parse(fs.readFileSync(flags.resume, 'utf8')).results) if (!limitHit(r) && !r.error) results.push(r);
    console.error(`resuming: ${results.length} finished trials kept from ${flags.resume}`);
  }
  const done = new Set(results.map((r) => `${r.instance}|${r.arm}|${r.trial}`));
  const save = () => {
    const rows = summarize(results, insts.length);
    fs.writeFileSync(`${base}.json`, `${JSON.stringify({ generated_at: new Date().toISOString(), arms: flags.arms, k: flags.k, instances: insts.map((i) => i.instance_id), stopped, pruned_images: pruned, summary: rows, results }, null, 2)}\n`);
    fs.writeFileSync(`${base}.md`, `${summaryTable(rows)}\n\n${table(results)}\n`);
  };
  outer: for (const inst of insts) {
    if (flags.arms.every((arm) => Array.from({ length: flags.k }, (_, i) => done.has(`${inst.instance_id}|${arm}|${i + 1}`)).every(Boolean))) continue;
    await ensureImage(inst.image);
    for (const arm of flags.arms) for (let n = 1; n <= flags.k; n++) {
      const free = freeGB(); if (free < 10) { stopped = `free disk ${free.toFixed(1)} GB < 10 GB before ${inst.instance_id} ${arm}`; console.error(`STOP: ${stopped}`); break outer; }
      if (done.has(`${inst.instance_id}|${arm}|${n}`)) continue;
      let r = await trial(inst, arm, n, flags);
      while (limitHit(r)) { console.error(`${inst.instance_id} ${arm} #${n}: usage limit hit, waiting for the quota to reset, then re-running the trial`); stopped = 'waiting for usage quota'; save(); await waitForQuota(); stopped = null; r = await trial(inst, arm, n, flags); }
      results.push(r); save();
      console.error(`${inst.instance_id} ${arm} #${n}: resolved=${r.resolved}${r.selections ? ` (first: ${r.resolved_first})` : ''} raw=${r.raw_resolved ?? r.raw_resolved_any} tokens=${r.new_tokens} usd=${r.notional_usd} wall=${r.wall_s}s free=${freeGB().toFixed(1)}GB${r.error ? ` ERROR ${r.error.slice(0, 200)}` : ''}`);
    }
    // prune after each instance: every instance has its own image (env layers are mostly per-version), so keeping only the current one
    // bounds Docker Desktop's disk high-water mark at ~1 image (~4 GB); shared base layers are re-pulled (~1 min)
    if (flags.prune) {
      try { dockerSync('image', 'rm', inst.image); pruned.push(inst.image); } catch { /* not present */ }
      try { dockerSync('image', 'prune', '-f'); } catch { /* best effort */ }
      console.error(`pruned ${inst.image}; free ${freeGB().toFixed(1)} GB`); save();
    }
  }
  save();
  console.log(summaryTable(summarize(results, insts.length))); console.error(`wrote ${base}.json and .md`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`swebench: ${e.stack || e.message}`); process.exit(64); });
