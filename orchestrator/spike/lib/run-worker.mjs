#!/usr/bin/env node
// Spike runner: launches one headless `claude -p` worker the way the engine would, and records everything.
// Usage: node run-worker.mjs <name> <cwd> [--kill-after <s>] [--env K=V ...] -- <claude args...>
// - own process group (detached) so the whole tree can be signalled
// - hard timeout 120 s (SIGTERM to the group, SIGKILL 5 s later)
// - writes out/<name>.{stdout,stderr,meta.json}
// - if stdout/stderr mention a rate/usage limit, writes out/STOP so later experiments refuse to run
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'out');
fs.mkdirSync(OUT, { recursive: true });
if (fs.existsSync(path.join(OUT, 'STOP'))) { console.error('STOP file present (rate limit seen earlier): refusing to run'); process.exit(3); }

const argv = process.argv.slice(2);
const name = argv.shift(); const cwd = argv.shift();
let killAfter = 0; const env = { ...process.env };
while (argv.length && argv[0] !== '--') {
  const a = argv.shift();
  if (a === '--kill-after') killAfter = Number(argv.shift());
  else if (a === '--env') { const [k, ...v] = argv.shift().split('='); env[k] = v.join('='); }
  else if (a === '--unset') delete env[argv.shift()];
}
argv.shift(); // '--'
const HARD_TIMEOUT_MS = 120_000;
const t0 = Date.now();
const child = spawn('claude', argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let so = '', se = '';
child.stdout.on('data', (d) => { so += d; });
child.stderr.on('data', (d) => { se += d; });
const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* gone */ } };
const timers = [];
let killedBy = null;
if (killAfter > 0) timers.push(setTimeout(() => { killedBy = 'SIGTERM(test)'; killGroup('SIGTERM'); }, killAfter * 1000));
timers.push(setTimeout(() => { killedBy = killedBy || 'SIGTERM(timeout)'; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 5000); }, HARD_TIMEOUT_MS));
child.on('close', (code, signal) => {
  timers.forEach(clearTimeout);
  const meta = { name, cwd, args: argv, pid: child.pid, exit_code: code, signal, killed_by: killedBy, wall_ms: Date.now() - t0,
    env_passed: Object.keys(env).filter((k) => k.startsWith('AOS_')).reduce((o, k) => ({ ...o, [k]: env[k] }), {}) };
  // is anything from the process group still alive after exit?
  try { process.kill(-child.pid, 0); meta.group_alive_after_exit = true; } catch { meta.group_alive_after_exit = false; }
  fs.writeFileSync(path.join(OUT, `${name}.stdout`), so);
  fs.writeFileSync(path.join(OUT, `${name}.stderr`), se);
  fs.writeFileSync(path.join(OUT, `${name}.meta.json`), JSON.stringify(meta, null, 2) + '\n');
  // stream-json emits {"type":"rate_limit_event","rate_limit_info":{"status":"allowed"|"allowed_warning"|...}} on
  // every run (first version of this regex tripped on it). Only a non-"allowed*" status, a 429, or limit text
  // in the result / stderr counts as a real limit error.
  const statuses = [...(so).matchAll(/"rate_limit_info":\{"status":"([a-z_]+)"/g)].map((m) => m[1]);
  meta.rate_limit_statuses = [...new Set(statuses)];
  fs.writeFileSync(path.join(OUT, `${name}.meta.json`), JSON.stringify(meta, null, 2) + '\n');
  const resultText = so.split('\n').filter((l) => l.includes('"type":"result"')).join('\n') + se;
  if (statuses.some((s) => !s.startsWith('allowed')) || /"api_error_status":429|usage limit|limit reached|rate.?limit(ed)? (error|exceeded)/i.test(resultText)) {
    fs.writeFileSync(path.join(OUT, 'STOP'), `rate/usage limit text seen in ${name}\n`);
    console.error('RATE/USAGE LIMIT TEXT DETECTED: wrote out/STOP');
  }
  console.log(JSON.stringify(meta));
});
