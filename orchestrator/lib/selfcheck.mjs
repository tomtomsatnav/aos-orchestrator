// Worker self-check (rules key worker.self_check; docs/security.md protection 6). A worker may ask the ENGINE to run one of its
// own task's approved checks, exactly as the hashed plan has it, and read the output. The worker never runs it:
//   1. the policy hook (lib/policy-hook.mjs, inside the worker's process tree) sees a Bash call whose command is EXACTLY one of the
//      task's approved check argv (matchSelfCheck: one plain command, no shell syntax at all, token-for-token equal), from the
//      worktree root. It DENIES the call (the raw command never runs) and drops a request {id, index} into the attempt's
//      self-check inbox (a directory the engine wrote into the policy file).
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
  const argv = check.argv.join(' ');
  try { fs.mkdirSync(sc.dir, { recursive: true, mode: 0o700 }); writeAtomic(path.join(sc.dir, `${id}.req.json`), { id, index: idx }); } catch (e) {
    return `AOS self-check: could not file the request (${String(e.code || e.message).slice(0, 60)}); not run. Finish your work: the engine runs the checks after you finish.`;
  }
  const res = path.join(sc.dir, `${id}.res.json`);
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

/** Engine side: the pending requests in an inbox, oldest first, as {id, index, file}. Malformed files are returned with index -1. */
export function readRequests(dir) {
  // the inbox lives in the worker's writable tmp dir: never follow a symlink the worker put in its place
  try { if (!fs.lstatSync(dir).isDirectory()) return []; } catch { return []; }
  let names; try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = /^([0-9a-f]{16})\.req\.json$/.exec(n);
    if (!m) continue;
    const file = path.join(dir, n);
    let req = null; let mtime = 0;
    try { const st = fs.lstatSync(file); mtime = st.mtimeMs; if (st.isFile() && st.size <= 4096) req = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* malformed: answered with an error */ }
    out.push({ id: m[1], index: Number.isInteger(req?.index) ? req.index : -1, file, mtime });
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

export function writeResponse(dir, id, obj) {
  if (!ID_RE.test(id)) return;
  try { if (!fs.lstatSync(dir).isDirectory()) return; } catch { return; }
  writeAtomic(path.join(dir, `${id}.res.json`), { id, ...obj });
}
