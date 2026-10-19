// Run a task's (or the goal's) acceptance checks: argv only (no shell), cwd = worktree, minimal env, own timeout,
// output capped. Commands must match the approved allowlist (the planner cannot add new check commands).
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tokenize } from './shell.mjs';

export const OUTPUT_CAP = 64 * 1024;

export function checkEnv({ base = process.env, tmpDir } = {}) {
  const env = { PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', path.dirname(process.execPath)].join(':'), TERM: 'dumb', CI: '1' };
  for (const k of ['HOME', 'USER', 'LOGNAME', 'LANG']) if (base[k]) env[k] = base[k];
  if (tmpDir) env.TMPDIR = tmpDir;
  return env;
}

/** argv matches an allowlist entry ("make test", "node --test") by argv prefix. null/empty allowlist = nothing allowed. */
export function commandAllowed(argv, allowlist) {
  if (!Array.isArray(argv) || !argv.length || !Array.isArray(allowlist)) return false;
  return allowlist.some((e) => {
    const t = Array.isArray(e) ? e : tokenize(e);
    return t.length > 0 && t.length <= argv.length && t.every((x, i) => (i === 0 ? path.basename(argv[0]) === path.basename(x) : argv[i] === x));
  });
}

export function runCheck(check, { cwd, env, signalGroupKill = true }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = ''; let truncated = false; let timedOut = false; let settled = false;
    let child;
    try { child = spawn(check.argv[0], check.argv.slice(1), { cwd, env, detached: signalGroupKill, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) {
      return resolve({ argv: check.argv, ok: false, exit_code: null, timed_out: false, output: `spawn failed: ${e.message}`, duration_ms: 0 });
    }
    const add = (d) => { if (out.length < OUTPUT_CAP) out += d; else truncated = true; };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const killTree = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const timer = setTimeout(() => { timedOut = true; killTree('SIGTERM'); setTimeout(() => killTree('SIGKILL'), 2000).unref(); }, Math.max(1, check.timeout_s * 1000));
    const finish = (code, sig, err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      killTree('SIGKILL'); // reap stragglers of the check's own group
      resolve({ argv: check.argv, ok: code === 0 && !timedOut && !err, exit_code: code, signal: sig || null, timed_out: timedOut,
        output: (err ? `spawn error: ${err}\n` : '') + out.slice(0, OUTPUT_CAP) + (truncated ? '\n[output truncated]' : ''), duration_ms: Date.now() - t0 });
    };
    child.on('error', (e) => finish(null, null, e.message));
    child.on('close', (code, sig) => finish(code, sig));
  });
}

/** Run checks sequentially; stops at the first failure. -> {ok, results[]} */
export async function runChecks(checks, opts) {
  const results = [];
  for (const c of checks || []) {
    if (opts.allowlist && !commandAllowed(c.argv, opts.allowlist)) {
      results.push({ argv: c.argv, ok: false, exit_code: null, timed_out: false, output: 'check command is not on the approved allowlist', duration_ms: 0, rejected: true });
      return { ok: false, results };
    }
    const r = await runCheck(c, opts);
    results.push(r);
    if (!r.ok) return { ok: false, results };
  }
  return { ok: true, results };
}

export const tail = (s, n = 4096) => (s.length > n ? s.slice(-n) : s);
