// `aos-orch doctor`: preflight checks with PASS/WARN/FAIL lines. No model call unless --live (one tiny Haiku probe).
// Every effect goes through `deps` (exec, which, httpGet, portFree, fs, ...) so tests run with stubs and no real claude.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { wrapCommand, wrapWorkerCommand, sandboxAvailable, SANDBOX_EXEC } from './sandbox.mjs';

/** claude versions the flag set and stream-json shapes were verified on (orchestrator/spike/README.md). Oldest entry = minimum. */
export const KNOWN_GOOD = [
  { version: '2.1.303', verified: 'spike: flags, stream-json, rate_limit_event' },
  { version: '2.1.304', verified: 'worker sandbox profile, claude auth status' },
];
export const MIN_NODE = 18;
export const MIN_GIT = [2, 5, 0]; // `git worktree` arrived in 2.5
export const REQUIRED_FLAGS = ['-p', '--output-format', 'stream-json', '--verbose', '--settings', '--tools', '--allowedTools', '--session-id',
  '--max-budget-usd', '--no-session-persistence', '--setting-sources', '--strict-mcp-config'];
export const LIVE_ARGS = ['-p', '--model', 'haiku', '--max-turns', '1', '--output-format', 'stream-json', '--verbose', 'reply ok'];

export const parseVer = (s) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s)); return m ? [+m[1], +m[2], +m[3]] : null; };
export const cmpVer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };

const r = (status, name, detail = '') => ({ status, name, detail });
export const PASS = 'PASS', WARN = 'WARN', FAIL = 'FAIL';

export function realDeps() {
  return {
    platform: process.platform, nodeVersion: process.versions.node, env: process.env, fs, os,
    exec: (bin, args, { timeoutMs = 15000, env } = {}) => new Promise((resolve) => {
      execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 << 20, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '', stderr: stderr || '', error: err && typeof err.code !== 'number' ? err.code || err.message : null });
      });
    }),
    which: (name) => { for (const d of String(process.env.PATH || '').split(path.delimiter)) { if (!d) continue; const f = path.join(d, name); try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ } } return null; },
    portFree: (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? false : null)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); }),
    httpGet: (port, p) => new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, (res) => { let b = ''; res.on('data', (c) => { if (b.length < 65536) b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
      req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    }),
  };
}

export function checkNode(d) {
  const v = parseVer(d.nodeVersion);
  return v && v[0] >= MIN_NODE ? r(PASS, 'node', `v${d.nodeVersion}`) : r(FAIL, 'node', `v${d.nodeVersion}: need >= ${MIN_NODE}`);
}

export async function checkGit(d) {
  const x = await d.exec('git', ['--version']);
  if (x.code !== 0) return [r(FAIL, 'git', 'git not found or not runnable')];
  const v = parseVer(x.stdout);
  if (!v) return [r(WARN, 'git', `cannot parse "${x.stdout.trim()}"`)];
  if (cmpVer(v, MIN_GIT) < 0) return [r(FAIL, 'git', `${v.join('.')}: git worktree needs >= ${MIN_GIT.join('.')}`)];
  const usage = await d.exec('git', ['worktree', '-h']);
  const text = `${usage.stdout}${usage.stderr}`;
  return [r(PASS, 'git', v.join('.')), /worktree/.test(text) && /add/.test(text) ? r(PASS, 'git worktree', 'supported') : r(FAIL, 'git worktree', '`git worktree` subcommand not available')];
}

export function classifyClaude(version) {
  const v = parseVer(version);
  if (!v) return r(WARN, 'claude version', `cannot parse "${String(version).trim()}"`);
  const min = parseVer(KNOWN_GOOD[0].version); const max = parseVer(KNOWN_GOOD[KNOWN_GOOD.length - 1].version);
  const known = KNOWN_GOOD.map((k) => k.version).join(', ');
  if (cmpVer(v, min) < 0) return r(FAIL, 'claude version', `${v.join('.')} is older than the minimum ${KNOWN_GOOD[0].version}; verified on: ${known}`);
  if (cmpVer(v, max) > 0) return r(WARN, 'claude version', `${v.join('.')} is newer than the newest verified (${KNOWN_GOOD[KNOWN_GOOD.length - 1].version}); flag/stream shapes unverified (try --live)`);
  return KNOWN_GOOD.some((k) => cmpVer(parseVer(k.version), v) === 0) ? r(PASS, 'claude version', `${v.join('.')} (verified)`) : r(WARN, 'claude version', `${v.join('.')} is between verified versions (${known}) but not itself verified`);
}

/** -> {results, bin, help} */
export async function checkClaude(d) {
  const bin = d.env.AOS_CLAUDE_BIN || d.which('claude');
  if (!bin) return { results: [r(FAIL, 'claude on PATH', 'not found; install Claude Code or set AOS_CLAUDE_BIN')], bin: null, help: '' };
  const results = [r(PASS, 'claude on PATH', bin)];
  const v = await d.exec(bin, ['--version']);
  if (v.code !== 0) results.push(r(FAIL, 'claude version', `\`claude --version\` failed (exit ${v.code})`));
  else results.push(classifyClaude(v.stdout));
  const h = await d.exec(bin, ['--help']);
  const help = `${h.stdout}\n${h.stderr}`;
  if (h.code !== 0) results.push(r(FAIL, 'claude flags', `\`claude --help\` failed (exit ${h.code})`));
  else {
    const missing = REQUIRED_FLAGS.filter((f) => f === 'stream-json' ? !help.includes(f) : f === '-p' ? !/(^|\s)-p,\s*--print\b/m.test(help) && !/(^|\s)-p\b/m.test(help) : !new RegExp(`(^|[\\s,])${f.replace(/[-]/g, '\\-')}(?![\\w-])`, 'm').test(help));
    results.push(missing.length ? r(FAIL, 'claude flags', `missing from --help: ${missing.join(' ')}`) : r(PASS, 'claude flags', `${REQUIRED_FLAGS.length} required flags present`));
  }
  return { results, bin, help };
}

export async function checkAuth(d, bin, help) {
  if (!bin) return r(WARN, 'claude login', 'skipped (no claude)');
  const sub = await d.exec(bin, ['auth', '--help']);
  if (sub.code !== 0 || !/\bstatus\b/.test(sub.stdout)) return r(WARN, 'claude login', 'cannot tell without a model call (`claude auth status` not available)');
  const s = await d.exec(bin, ['auth', 'status', '--json']);
  let j = null; try { j = JSON.parse(s.stdout); } catch { /* below */ }
  if (j && typeof j.loggedIn === 'boolean') return j.loggedIn ? r(PASS, 'claude login', `logged in (${j.authMethod || 'unknown method'}${j.subscriptionType ? `, ${j.subscriptionType}` : ''})`) : r(FAIL, 'claude login', 'not logged in: run `claude auth login`');
  return r(WARN, 'claude login', `unrecognised \`claude auth status\` output (exit ${s.code})`);
}

export async function checkSandbox(d) {
  if (d.platform !== 'darwin') return [r(WARN, 'sandbox-exec', `macOS only (platform ${d.platform}); sandboxed checks and --sandbox-workers are unavailable`)];
  if (!d.fs.existsSync(SANDBOX_EXEC)) return [r(WARN, 'sandbox-exec', `${SANDBOX_EXEC} not found; sandboxed checks and --sandbox-workers are unavailable`)];
  const tmp = d.fs.mkdtempSync(path.join(d.os.tmpdir(), 'aos-doctor-'));
  const out = [r(PASS, 'sandbox-exec', SANDBOX_EXEC)];
  try {
    const wt = path.join(tmp, 'wt'); const tt = path.join(tmp, 'tmp'); const pd = path.join(tmp, 'profiles');
    for (const p of [wt, tt]) d.fs.mkdirSync(p, { recursive: true });
    const probe = async (label, w) => {
      const x = await d.exec(w.bin, w.args, { timeoutMs: 10000 });
      out.push(x.code === 0 ? r(PASS, `sandbox probe (${label})`, '`sh -c true` ran') : r(FAIL, `sandbox probe (${label})`, `exit ${x.code} ${(x.stderr || x.error || '').toString().trim().slice(0, 160)}`));
    };
    await probe('check profile', wrapCommand(['/bin/sh', '-c', 'true'], { worktree: wt, tmpDir: tt, profileDir: pd }));
    await probe('worker profile', wrapWorkerCommand(['/bin/sh', '-c', 'true'], { worktree: wt, tmpDir: tt, approvalsDir: path.join(tmp, 'ap'), decisionLog: path.join(tmp, 'dl'),
      policyFile: path.join(tmp, 'pol'), settingsFile: path.join(tmp, 'set'), hookDir: path.join(tmp, 'hk'), profileDir: pd, sessionId: '00000000-0000-4000-8000-000000000000' }));
  } catch (e) { out.push(r(FAIL, 'sandbox probe', String(e.message).slice(0, 160))); } finally { try { d.fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
  return out;
}

export function checkStateDir(d, orch) {
  try {
    d.fs.mkdirSync(orch, { recursive: true, mode: 0o700 });
    const f = path.join(orch, `.doctor-${process.pid}`);
    d.fs.writeFileSync(f, 'ok', { mode: 0o600 }); d.fs.unlinkSync(f);
    const mode = d.fs.statSync(orch).mode & 0o777;
    return mode & 0o077 ? r(WARN, 'state dir', `${orch} writable but mode is ${mode.toString(8)} (want 700): chmod 700 it`) : r(PASS, 'state dir', `${orch} writable, mode ${mode.toString(8)}`);
  } catch (e) { return r(FAIL, 'state dir', `${orch}: ${e.code || e.message}`); }
}

export async function checkPort(d, port) {
  const free = await d.portFree(port);
  if (free === true) return r(PASS, 'control port', `127.0.0.1:${port} free`);
  if (free === null) return r(WARN, 'control port', `127.0.0.1:${port}: cannot test`);
  const h = await d.httpGet(port, '/api/health');
  let j = null; try { j = JSON.parse(h?.body); } catch { /* not ours */ }
  if (j && j.ok === true && 'workers' in j && 'governor' in j) return r(PASS, 'control port', `127.0.0.1:${port} in use by aos-orch serve (v${j.version})`);
  return r(FAIL, 'control port', `127.0.0.1:${port} is in use by something else; use --port N for serve`);
}

/** Validate the stream-json shapes the engine parses against the lines of one real run. Pure. */
export function validateStream(stdout) {
  const lines = []; for (const l of String(stdout).split('\n')) { if (!l.trim()) continue; try { lines.push(JSON.parse(l)); } catch { return [r(FAIL, 'live: stream', `non-JSON line: ${l.slice(0, 80)}`)]; } }
  const out = [];
  const init = lines.find((l) => l.type === 'system' && l.subtype === 'init');
  out.push(init ? r(PASS, 'live: system/init', `model ${init.model}, session ${String(init.session_id).slice(0, 8)}`) : r(FAIL, 'live: system/init', 'no system/init line'));
  const res = lines.filter((l) => l.type === 'result').pop();
  if (!res) return [...out, r(FAIL, 'live: result line', 'no result line')];
  const bad = [];
  if (typeof res.subtype !== 'string') bad.push('subtype');
  if (typeof res.is_error !== 'boolean') bad.push('is_error');
  if (typeof res.session_id !== 'string') bad.push('session_id');
  if (typeof res.result !== 'string') bad.push('result');
  if (typeof res.total_cost_usd !== 'number') bad.push('total_cost_usd');
  if (!Array.isArray(res.permission_denials)) bad.push('permission_denials');
  out.push(bad.length ? r(FAIL, 'live: result line', `missing/mistyped: ${bad.join(', ')}`) : r(res.is_error ? WARN : PASS, 'live: result line', `subtype ${res.subtype}, is_error ${res.is_error}`));
  const u = res.usage || {}; const ub = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].filter((k) => typeof u[k] !== 'number');
  out.push(ub.length ? r(FAIL, 'live: usage fields', `missing: ${ub.join(', ')}`) : r(PASS, 'live: usage fields', `in ${u.input_tokens} out ${u.output_tokens}`));
  const asst = lines.find((l) => l.type === 'assistant');
  out.push(asst && typeof asst.message?.usage?.output_tokens === 'number' ? r(PASS, 'live: assistant usage', 'per-message usage present') : r(WARN, 'live: assistant usage', 'no per-message usage on assistant lines'));
  const rl = lines.find((l) => l.type === 'rate_limit_event');
  if (!rl) out.push(r(PASS, 'live: rate_limit_event', 'not emitted this run (optional)'));
  else { const i = rl.rate_limit_info; out.push(i && typeof i.status === 'string' ? r(PASS, 'live: rate_limit_event', `status ${i.status}${i.rateLimitType ? `, ${i.rateLimitType}` : ''}`) : r(FAIL, 'live: rate_limit_event', 'rate_limit_info.status missing')); }
  return out;
}

export async function checkLive(d, bin) {
  if (!bin) return [r(FAIL, 'live probe', 'no claude to probe')];
  const x = await d.exec(bin, LIVE_ARGS, { timeoutMs: 120000 });
  if (!x.stdout.trim()) return [r(FAIL, 'live probe', `no output (exit ${x.code}) ${(x.stderr || x.error || '').toString().trim().slice(0, 160)}`)];
  return validateStream(x.stdout);
}

export async function runDoctor({ orch, port = 4319, live = false, deps = realDeps() } = {}) {
  const d = deps; const results = [];
  results.push(checkNode(d));
  results.push(...await checkGit(d));
  const c = await checkClaude(d); results.push(...c.results);
  results.push(await checkAuth(d, c.bin, c.help));
  results.push(...await checkSandbox(d));
  results.push(checkStateDir(d, orch));
  results.push(await checkPort(d, port));
  if (live) results.push(...await checkLive(d, c.bin));
  const fails = results.filter((x) => x.status === FAIL).length; const warns = results.filter((x) => x.status === WARN).length;
  return { results, fails, warns, exitCode: fails ? 1 : 0 };
}

export const renderDoctor = (rep) => [...rep.results.map((x) => `${x.status}  ${x.name}${x.detail ? `: ${x.detail}` : ''}`), `${rep.fails} fail, ${rep.warns} warn`].join('\n');
