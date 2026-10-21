// Worker self-check (rules key worker.self_check; docs/security.md protection 6). A worker may ask the ENGINE to run one of its
// own task's approved checks, exactly as the hashed plan has it, and read the output. The worker never runs it:
//   1. the policy hook (lib/policy-hook.mjs, inside the worker's process tree) sees a Bash call whose command is EXACTLY one of the
//      task's approved check argv (matchSelfCheck: one plain command, no shell syntax at all, token-for-token equal), from the
//      worktree root. It DENIES the call (the raw command never runs) and drops a request {id, index} into the attempt's
//      self-check inbox (a directory the engine wrote into the policy file).
//      Channels: requests go into the INBOX (worker-writable, in its tmp dir); responses come back through res_dir, an engine-owned
//      directory the worker sandbox may READ but not write (so a swapped/symlinked inbox can never make the engine create files
//      elsewhere). The engine reads requests with O_NOFOLLOW|O_NONBLOCK, <= 4 KB, at most 64 names per scan, and gives up on an
//      attempt that floods it.
//   2. the engine (its own process: outside any worker sandbox) picks the request up, takes the argv from ITS copy of the plan
//      (never from the request), counts it against worker.self_checks_max and runs it through runChecks: the same OS check
//      sandbox (sandbox-exec / bwrap), env, allowlist, timeout and output cap as the authoritative checks. It writes a response.
//   3. the hook returns the response as the deny reason, the check output fenced as UNTRUSTED. The model sees it (probed).
// Self-checks are informational only: the engine still runs every check itself after the attempt, then the anti-cheat layer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseShell } from './shell.mjs';
import { untrustedBlocks } from './untrusted.mjs';

export const SELF_CHECKS_MAX_DEFAULT = 5;
/** One self-check run never runs longer than this (the policy hook blocks the worker while it waits). */
export const SELF_CHECK_MAX_S = 300;
/** The PreToolUse hook timeout registered in settings.json: the longest self-check plus margin. Approval waits stay capped at MAX_HOOK_WAIT_S. */
export const HOOK_TIMEOUT_S = SELF_CHECK_MAX_S + 60;
/** How much of the (64 KB capped) output goes back to the model: the end, where test runners print their summary. */
export const OUTPUT_TAIL = 6000;
export const INBOX_NAME = '.aos-selfcheck';
const ID_RE = /^[0-9a-f]{16}$/;
// Anything a shell would interpret (operators, redirects, substitution, expansion, escapes, comments, history, newlines): never part
// of a self-check command. Quotes, `*`, `?` and `[]` are allowed (they can only group or spell an approved token; nothing is run by a shell).
const SHELL_META = /[;&|<>()`$\\\n\r{}#~!\0]/;

/** Index of the approved check whose argv the Bash command spells exactly (token for token, nothing added), else -1. Pure. */
export function matchSelfCheck(command, checks) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4096 || SHELL_META.test(command) || !Array.isArray(checks)) return -1;
  const p = parseShell(command);
  if (p.commands.length !== 1 || Object.values(p.flags).some(Boolean)) return -1;
  const c = p.commands[0];
  if (c.redirects.length || c.ops || !c.argv.length) return -1;
  return checks.findIndex((k) => Array.isArray(k?.argv) && k.argv.length === c.argv.length && k.argv.every((a, i) => a === c.argv[i]));
}

/** Is a permission denial from the result stream one the self-check hook produced (an approved check argv)? */
export const isSelfCheckDenial = (d, checks) => d?.tool_name === 'Bash' && matchSelfCheck(String(d.tool_input?.command ?? ''), checks) >= 0;

const writeAtomic = (file, obj) => { const t = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`; fs.writeFileSync(t, JSON.stringify(obj), { mode: 0o600 }); fs.renameSync(t, file); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hook side. `sc` = the policy file's ctx.self_check {dir, checks[{argv, timeout_s}], max, wait_ms}; `idx` from matchSelfCheck.
 * Files the request, waits for the engine's response, returns the deny reason text (the model reads it).
 */
export async function requestSelfCheck(sc, idx, { pollMs = 100 } = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const check = sc.checks[idx];
  if (typeof sc.res_dir !== 'string' || !sc.res_dir) return 'AOS self-check: no response channel is configured; not run. Finish your work: the engine runs the checks after you finish.';
  const argv = check.argv.join(' ');
  try { fs.mkdirSync(sc.dir, { recursive: true, mode: 0o700 }); writeAtomic(path.join(sc.dir, `${id}.req.json`), { id, index: idx }); } catch (e) {
    return `AOS self-check: could not file the request (${String(e.code || e.message).slice(0, 60)}); not run. Finish your work: the engine runs the checks after you finish.`;
  }
  const res = path.join(sc.res_dir, `${id}.res.json`);
  const waitMs = Math.max(1000, Number(sc.wait_ms) || (Math.min(Number(check.timeout_s) || SELF_CHECK_MAX_S, SELF_CHECK_MAX_S) + 20) * 1000);
  const end = Date.now() + waitMs;
  let r = null;
  while (Date.now() < end) {
    try { r = JSON.parse(fs.readFileSync(res, 'utf8')); break; } catch { await sleep(pollMs); }
  }
  try { fs.rmSync(res, { force: true }); } catch { /* best effort */ }
  return formatResponse(r, argv, sc.max);
}

/** The deny reason for one response (null = the engine never answered). Check output is fenced as UNTRUSTED. */
export function formatResponse(r, argv, max, { nonce } = {}) {
  const head = 'AOS self-check: the engine ran your task\'s approved check `' + argv + '` for you in its check sandbox (you did not run it). '
    + 'This is information, not the verdict: after you finish, the engine runs every check again itself.';
  if (!r || typeof r !== 'object') return `AOS self-check: the engine did not answer in time; \`${argv}\` was not run. Do not retry it; finish your work: the engine runs the checks after you finish.`;
  if (r.capped) return `AOS self-check: limit reached (${Number(r.max ?? max) || 0} self-checks per attempt); \`${argv}\` was not run. Finish your work: the engine runs the checks after you finish.`;
  if (r.error) return `AOS self-check: \`${argv}\` was not run: ${String(r.error).slice(0, 200)}. Finish your work: the engine runs the checks after you finish.`;
  const U = untrustedBlocks([{ label: `self-check output of ${argv}`.slice(0, 120), text: String(r.output ?? ''), max: OUTPUT_TAIL + 200 }], nonce ? { nonce } : {});
  const status = r.timed_out ? `TIMED OUT after ${r.duration_ms} ms` : `exit code ${r.exit_code ?? 'none'} (${r.ok ? 'passed' : 'FAILED'}) in ${r.duration_ms} ms`;
  return `${head}\nResult: ${status}; self-check ${Number(r.run) || 0} of ${Number(r.max ?? max) || 0} for this attempt${r.truncated ? '; output shortened to its last part' : ''}.\n${U.notice}\n${U.blocks[0]}`;
}

export const REQ_MAX_BYTES = 4096;
/** At most this many request names are looked at per scan (sorted by name): a flooded inbox costs the engine a bounded amount per tick. */
export const SCAN_MAX = 64;
/** Directory entries examined per scan (matching or not): bounds the cost of a directory stuffed with junk names. */
const SCAN_ENTRIES_MAX = 1024;
/** Bad requests tolerated on top of the attempt's cap before the engine stops servicing the attempt's inbox. */
export const BAD_EXTRA = 16;
const O_SAFE = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/** One request file, read defensively (the worker controls the directory): never follows a symlink, never blocks on a FIFO/device,
 *  never reads more than REQ_MAX_BYTES + 1. Any anomaly (not a regular file, too big, unreadable, bad JSON) -> {req: null}. */
function readRequestFile(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, O_SAFE); // O_NOFOLLOW: a symlink (e.g. to /dev/zero) is ELOOP; O_NONBLOCK: a FIFO opens instead of hanging the engine
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > REQ_MAX_BYTES) return { req: null, mtime: st.mtimeMs };
    const buf = Buffer.alloc(REQ_MAX_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, REQ_MAX_BYTES + 1, 0);
    if (n > REQ_MAX_BYTES) return { req: null, mtime: st.mtimeMs };
    return { req: JSON.parse(buf.toString('utf8', 0, n)), mtime: st.mtimeMs };
  } catch { return { req: null, mtime: 0 }; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* gone */ } } }
}

/**
 * Engine side: the pending requests in an inbox as {id, index, file, mtime}, oldest first; anomalies and malformed files come back
 * with index -1 (the engine deletes them). Only the first SCAN_MAX request names (sorted) are read. `.junk` = other entry names
 * seen (not requests; the engine unlinks them).
 */
export function readRequests(dir) {
  const out = []; out.junk = [];
  // the inbox lives in the worker's writable tmp dir: never follow a symlink the worker put in its place
  try { if (!fs.lstatSync(dir).isDirectory()) return out; } catch { return out; }
  const names = [];
  let d = null;
  try {
    d = fs.opendirSync(dir);
    for (let i = 0, e; i < SCAN_ENTRIES_MAX && (e = d.readSync()); i++) (/^[0-9a-f]{16}\.req\.json$/.test(e.name) ? names : out.junk).push(e.name);
  } catch { /* unreadable: whatever was seen */ } finally { if (d) { try { d.closeSync(); } catch { /* closed */ } } }
  names.sort();
  for (const n of names.slice(0, SCAN_MAX)) {
    const file = path.join(dir, n);
    const { req, mtime } = readRequestFile(file);
    out.push({ id: n.slice(0, 16), index: Number.isInteger(req?.index) ? req.index : -1, file, mtime });
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

/** Engine side: write a response into `dir`, the engine-OWNED response directory (the worker sandbox can read it, never write it). */
export function writeResponse(dir, id, obj) {
  if (!ID_RE.test(id)) return;
  try { if (!fs.lstatSync(dir).isDirectory()) return; } catch { return; }
  try { writeAtomic(path.join(dir, `${id}.res.json`), { id, ...obj }); } catch { /* disk full / dir removed: the hook times out */ }
}
