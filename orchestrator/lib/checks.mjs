// Run a task's (or the goal's) acceptance checks: argv only (no shell), cwd = worktree, minimal env, own timeout,
// output capped. Commands must match the approved allowlist (the planner cannot add new check commands).
// Checks execute worker-written code, so by default every check runs under sandbox-exec (macOS) or bubblewrap (Linux) (lib/sandbox.mjs): no network,
// writes only to the worktree and a private TMPDIR, no reads of secrets or engine state. If the sandbox is unavailable the
// check is REFUSED unless the caller passes unsandboxed:true (the goal field orch.unsandboxed_checks).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tokenize } from './shell.mjs';
import { sandboxAvailable, wrapCommand, DEFAULT_SANDBOX_BIN } from './sandbox.mjs';
import { forceTapArgv } from './anticheat.mjs';
import * as HG from './harness-guard.mjs';

export const OUTPUT_CAP = 64 * 1024;
const TAIL_CAP = 8 * 1024;

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

let defaultProfileDir = null;
const profileDirDefault = () => (defaultProfileDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sandbox-')));

/**
 * opts: {cwd, env, signalGroupKill?, sandbox?: {worktree?, tmpDir?, goalDir?, orchDir?, home?, ports?, profileDir?}, sandboxBin?, unsandboxed?}
 * Default = sandboxed with worktree = cwd. Result has `sandboxed: boolean`; `rejected: true` when refused.
 */
export function runCheck(check, opts) {
  const { cwd, signalGroupKill = true } = opts;
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = ''; let truncated = false; let timedOut = false; let settled = false; let tailBuf = '';
    let child; let bin = check.argv[0]; let args = check.argv.slice(1); let env = opts.env; let ownTmp = null;
    const sandboxed = !opts.unsandboxed;
    // every engine-run `node --test` gets the engine-owned preload (lib/harness-guard.mjs): assert / node:test cannot be neutered, tamper -> harness_tamper
    let guard = null; let runArgv = check.argv; const guardOn = opts.harnessGuard !== false && HG.isNodeTest(check.argv);
    if (guardOn) runArgv = HG.expandTestGlobs(check.argv, cwd);
    if (sandboxed) {
      const av = sandboxAvailable({ bin: opts.sandboxBin || DEFAULT_SANDBOX_BIN });
      if (!av.ok) return resolve({ argv: check.argv, ok: false, exit_code: null, timed_out: false, rejected: true, sandboxed: false, duration_ms: 0,
        output: `sandbox unavailable (${av.reason}): refusing to run a check that executes worker-written code unsandboxed; set orch.unsandboxed_checks=true to override` });
      try {
        const cfg = { ...(opts.sandbox || {}) };
        cfg.worktree ||= cwd;
        if (!cfg.tmpDir) { cfg.tmpDir = ownTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-chk-')); }
        cfg.profileDir ||= profileDirDefault();
        let genv = {};
        if (guardOn) { guard = HG.prepare(runArgv, { tmpBase: cfg.tmpDir }); if (guard) { runArgv = guard.argv; genv = guard.env; cfg.extraRead = guard.extraRead; } }
        const w = wrapCommand(runArgv, { ...cfg, env: { ...opts.env, TMPDIR: cfg.tmpDir, ...genv }, bin: opts.sandboxBin || DEFAULT_SANDBOX_BIN });
        bin = w.bin; args = w.args; env = { ...opts.env, TMPDIR: cfg.tmpDir, ...genv };
      } catch (e) { return resolve({ argv: check.argv, ok: false, exit_code: null, timed_out: false, rejected: true, sandboxed: true, output: `sandbox setup failed: ${e.message}`, duration_ms: 0 }); }
    }
    if (!sandboxed && guardOn) {
      try { guard = HG.prepare(runArgv, { tmpBase: opts.env?.TMPDIR || os.tmpdir() }); } catch (e) { return resolve({ argv: check.argv, ok: false, exit_code: null, timed_out: false, rejected: true, sandboxed, output: `harness guard setup failed: ${e.message}`, duration_ms: 0 }); }
      if (guard) { bin = guard.argv[0]; args = guard.argv.slice(1); env = { ...opts.env, ...guard.env }; } else { bin = runArgv[0]; args = runArgv.slice(1); }
    }
    try { child = spawn(bin, args, { cwd, env, detached: signalGroupKill, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) {
      return resolve({ argv: check.argv, ok: false, exit_code: null, timed_out: false, output: `spawn failed: ${e.message}`, duration_ms: 0, sandboxed });
    }
    const add = (d) => { if (out.length < OUTPUT_CAP) out += d; else truncated = true; tailBuf = (tailBuf + d).slice(-TAIL_CAP); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const killTree = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    if (typeof opts.registerKill === 'function') opts.registerKill(killTree); // the engine can stop an in-flight (self-)check when its attempt ends
    const timer = setTimeout(() => { timedOut = true; killTree('SIGTERM'); setTimeout(() => killTree('SIGKILL'), 2000).unref(); }, Math.max(1, check.timeout_s * 1000));
    const finish = (code, sig, err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      killTree('SIGKILL'); // reap stragglers of the check's own group
      let hv = null;
      if (guard) { hv = HG.collect(guard, cwd, { passed: code === 0 && !timedOut && !err }); /* a missing marker only matters for a check that would otherwise PASS; forged / not-ok markers always count */ try { fs.rmSync(guard.markerDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      if (ownTmp) { try { fs.rmSync(ownTmp, { recursive: true, force: true }); } catch { /* best effort */ } }
      let ok = code === 0 && !timedOut && !err; let note = '';
      if (hv && !hv.ok) { // missing / forged / not-ok verification markers: the test process cannot be trusted. checks.harness_tamper: warn only records it.
        note = `ANTI-CHEAT harness_tamper: ${hv.problems.slice(0, 3).join(' | ')}\n`;
        if (opts.harnessMode !== 'warn') ok = false;
      }
      resolve({ argv: check.argv, ok, ...(hv && !hv.ok ? { harness_tamper: opts.harnessMode !== 'warn', harness_problems: hv.problems } : {}), ...(hv ? { harness: { processes: hv.processes, checked: hv.checked }, test_files: hv.files } : {}), exit_code: code, signal: sig || null, timed_out: timedOut, sandboxed,
        output: note + (err ? `spawn error: ${err}\n` : '') + out.slice(0, OUTPUT_CAP) + (truncated ? '\n[output truncated]' : ''), duration_ms: Date.now() - t0,
        summary_text: truncated ? tailBuf : out }); // what anticheat parses for the test summary (the END of the output when it was truncated)
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
    let o = opts; let perCheck = null;
    if (opts.sandbox?.tmpDir && !opts.unsandboxed) { // a private TMPDIR per check, removed afterwards
      perCheck = path.join(opts.sandbox.tmpDir, `check-${results.length}`);
      fs.mkdirSync(perCheck, { recursive: true, mode: 0o700 });
      o = { ...opts, sandbox: { ...opts.sandbox, tmpDir: perCheck } };
    }
    // node --test checks run with the TAP reporter so the engine can count tests (anticheat); the approved argv is never rewritten
    const r = await runCheck(opts.forceTap === false ? c : { ...c, argv: forceTapArgv(c.argv) }, o);
    r.argv = c.argv;
    if (perCheck) { try { fs.rmSync(perCheck, { recursive: true, force: true }); } catch { /* best effort */ } }
    results.push(r);
    if (!r.ok) return { ok: false, results };
  }
  return { ok: true, results };
}

export const tail = (s, n = 4096) => (s.length > n ? s.slice(-n) : s);
