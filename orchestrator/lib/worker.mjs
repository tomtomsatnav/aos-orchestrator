// Worker runner (design section 5): command line, minimised env, detached process group, stream-json parsing.
// Only flags that the spike VERIFIED are used. The binary is AOS_CLAUDE_BIN when set (tests), else `claude`.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { parseRateLimitEvent, usageOf } from './governor.mjs';

export const WORKER_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash';
export const READ_ONLY_TOOLS = 'Read,Glob,Grep';
export const PLANNER_MARKER = 'AOS_PLANNER';

export const FILE_WRITE_RULE = 'Create and modify files ONLY with the Write and Edit tools (they are checked against your path scope), never with shell redirects, tee, printf, echo or sed -i. '
  + 'Bash is for read-only inspection of the listed commands only; verify by reading the file with Read. The engine runs the real checks.';

export const WORKER_RULES = FILE_WRITE_RULE + ' Do not commit, push, install packages or use the network. If a tool call is denied, do not try to work around it: '
  + 'finish and state what you needed. End with a 3-line summary: changed files, how you checked, open issues.';

export function claudeBin(env = process.env) { return env.AOS_CLAUDE_BIN || 'claude'; }

/** Exact argv (after the binary) per the design. Every flag is spike-verified (rows 1a-1d, 8e). */
export function buildArgs({ prompt, tier, sessionId, maxTurns = 30, maxBudgetUsd = 2, tools = WORKER_TOOLS, allowedTools = READ_ONLY_TOOLS,
  appendSystemPrompt = WORKER_RULES, settingsFile }) {
  return ['-p', prompt, '--model', tier, '--output-format', 'stream-json', '--verbose', '--session-id', sessionId,
    '--max-turns', String(maxTurns), '--max-budget-usd', String(maxBudgetUsd), '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', tools, '--allowedTools', allowedTools,
    '--append-system-prompt', appendSystemPrompt, '--settings', settingsFile];
}

/** Environment built from scratch (design section 5). `extra` carries AOS_* values; secrets are never inherited. */
export function buildEnv({ base = process.env, goalId, taskId, attempt, worktree, policyFile, approvalsDir, tmpDir, decisionLog, bin, nodePath = process.execPath, extra = {} }) {
  const dirs = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', path.dirname(nodePath)];
  if (bin && path.isAbsolute(bin)) dirs.push(path.dirname(bin));
  else if (!bin) { /* claude resolved through PATH below */ }
  const env = { PATH: [...new Set(dirs)].join(':'), TERM: 'dumb' };
  for (const k of ['HOME', 'USER', 'LOGNAME', 'LANG']) if (base[k]) env[k] = base[k];
  if (!bin || !path.isAbsolute(bin)) { // find `claude` on the caller's PATH and expose only its directory
    for (const d of String(base.PATH || '').split(':')) { try { if (d && fs.statSync(path.join(d, bin || 'claude')).isFile()) { env.PATH += `:${d}`; break; } } catch { /* next */ } }
  }
  if (tmpDir) env.TMPDIR = tmpDir;
  Object.assign(env, { AOS_GOAL_ID: goalId, AOS_TASK_ID: taskId, AOS_ATTEMPT: String(attempt), AOS_WORKTREE: worktree,
    AOS_POLICY_FILE: policyFile, AOS_APPROVALS_DIR: approvalsDir });
  if (decisionLog) env.AOS_DECISION_LOG = decisionLog;
  if (base.AOS_APPROVAL_POLL_MS) env.AOS_APPROVAL_POLL_MS = base.AOS_APPROVAL_POLL_MS;
  if (base.AOS_CLAUDE_BIN) { // test mode: the scripted fake needs its own scenario variables
    env.AOS_CLAUDE_BIN = base.AOS_CLAUDE_BIN;
    for (const k of Object.keys(base)) if (k.startsWith('AOS_FAKE_')) env[k] = base[k];
  }
  return { ...env, ...extra };
}

/** Settings file registering exactly the policy hook (telemetry hook arrives in phase 2). */
export function buildSettings(hookScript, nodePath = process.execPath) {
  const cmd = `${JSON.stringify(nodePath)} ${JSON.stringify(hookScript)}`;
  const entry = [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 30 }] }];
  return { hooks: { PreToolUse: entry, PermissionRequest: entry } };
}

export function buildWorkerPrompt({ goal, task, deps = [], previous = null }) {
  const o = task.orch;
  const lines = [
    `You are AOS worker ${task.id} for goal "${goal.title}". Work only in the current directory.`,
    `TASK: ${task.title} - ${o.description || ''}`,
    `YOU MAY CHANGE ONLY: ${o.path_scope.join(', ')}        COMMANDS YOU MAY RUN: ${(o.allowed_commands || []).join(', ') || '(none)'}`,
    `DONE MEANS: ${task.acceptance.join('; ')}; the engine will run: ${(o.checks || []).map((c) => c.argv.join(' ')).join(' ; ')}`,
  ];
  const ctx = [];
  for (const d of deps) ctx.push(`dependency ${d.id} (${d.title}): ${d.summary || 'done'}`);
  if (previous) {
    if (previous.check_output) ctx.push(`previous attempt failed the engine checks. Last output:\n${previous.check_output}`);
    if (previous.denials?.length) ctx.push(`previous attempt had denied tool calls: ${previous.denials.join(', ')}`);
    if (previous.note) ctx.push(previous.note);
  }
  if (ctx.length) lines.push(`CONTEXT: ${ctx.join('\n')}`);
  lines.push(`RULES: ${FILE_WRITE_RULE} Do not commit, push, install packages or use the network. If a tool call is denied, do not try to work around it: finish and state what you needed. End with a 3-line summary: changed files, how you checked, open issues.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- stream parsing
export class StreamTail {
  constructor(file) {
    this.file = file; this.offset = 0; this.buf = '';
    this.init = null; this.result = null; this.lines = 0;
    this.assistant = new Map(); // message id -> usage (last value wins)
    this.denials = []; this.rateLimits = []; this.apiError = null; this.lastRateLimit = null; this.invalid = 0;
  }
  /** Reads new bytes; returns true when something new was parsed. */
  update() {
    let fd;
    try { fd = fs.openSync(this.file, 'r'); } catch { return false; }
    try {
      const { size } = fs.fstatSync(fd);
      if (size <= this.offset) return false;
      const b = Buffer.alloc(size - this.offset);
      fs.readSync(fd, b, 0, b.length, this.offset);
      this.offset = size;
      this.buf += b.toString('utf8');
    } finally { fs.closeSync(fd); }
    const parts = this.buf.split('\n');
    this.buf = parts.pop();
    for (const l of parts) this._line(l);
    return true;
  }
  _line(l) {
    if (!l.trim()) return;
    let o; try { o = JSON.parse(l); } catch { this.invalid++; return; }
    this.lines++;
    if (o.type === 'system' && o.subtype === 'init') this.init = o;
    else if (o.type === 'system' && o.subtype === 'permission_denied') this.denials.push({ tool_name: o.tool_name, reason: o.message || o.decision_reason, tool_use_id: o.tool_use_id });
    else if (o.type === 'assistant' && (o.isApiErrorMessage || o.apiError || o.error)) {
      // synthetic api-error message (real shape: apiError 'usage_limit_reached', error 'rate_limit', apiErrorStatus 429, apiErrorParams.rate_limit_info)
      this.apiError = { apiError: o.apiError ?? null, error: typeof o.error === 'string' ? o.error : null, apiErrorStatus: o.apiErrorStatus ?? null,
        text: (o.message?.content || []).map((x) => x.text || '').join(' ').slice(0, 300) };
      const r = parseRateLimitEvent(o); if (r) { this.rateLimits.push(r); this.lastRateLimit = r; }
    }
    else if (o.type === 'assistant' && o.message?.usage) this.assistant.set(o.message.id || `n${this.lines}`, o.message.usage);
    else if (o.type === 'rate_limit_event') { const r = parseRateLimitEvent(o); if (r) { this.rateLimits.push(r); this.lastRateLimit = r; } }
    else if (o.type === 'result') this.result = o;
  }
  takeRateLimits() { const r = this.rateLimits; this.rateLimits = []; return r; }
  /** Usage: the result object when present (primary), else the sum of deduped assistant usages (killed worker). */
  usage() {
    if (this.result?.usage) return usageOf(this.result.usage);
    const sum = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    for (const u of this.assistant.values()) for (const k of Object.keys(sum)) sum[k] += u[k] || 0;
    return usageOf(sum);
  }
  notionalUsd() { return Number(this.result?.total_cost_usd) || 0; }
}

// ---------------------------------------------------------------- process control
export const signalGroup = (pgid, sig) => { try { process.kill(-pgid, sig); return true; } catch { return false; } };
export function groupAlive(pgid) { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
export function pidIsAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** SIGTERM the whole group, SIGKILL after graceMs if anything survives. Resolves when the group is empty. */
export async function killGroup(pgid, { graceMs = 10000, pollMs = 25 } = {}) {
  if (!pgid) return true;
  signalGroup(pgid, 'SIGTERM');
  const end = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < end) await new Promise((r) => setTimeout(r, pollMs));
  if (groupAlive(pgid)) {
    signalGroup(pgid, 'SIGKILL');
    const end2 = Date.now() + 5000;
    while (groupAlive(pgid) && Date.now() < end2) await new Promise((r) => setTimeout(r, pollMs));
  }
  return !groupAlive(pgid);
}

/** `ps` view of a pid, used to make sure a recorded pid still belongs to our worker (pid reuse). */
export function processCommand(pid) {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/**
 * Spawn a worker detached (own process group), stdout/stderr to files. Returns {child, pid, pgid, done}.
 * `done` resolves with {exit_code, signal, error} when the process ends (never rejects).
 */
export function startWorker({ bin, args, env, cwd, stdoutFile, stderrFile, spawnFn = nodeSpawn }) {
  const out = fs.openSync(stdoutFile, 'a', 0o600);
  const err = fs.openSync(stderrFile, 'a', 0o600);
  let child;
  try { child = spawnFn(bin, args, { cwd, env, detached: true, stdio: ['ignore', out, err] }); } finally { fs.closeSync(out); fs.closeSync(err); }
  const done = new Promise((resolve) => {
    child.on('error', (e) => resolve({ exit_code: null, signal: null, error: e.message }));
    child.on('close', (code, signal) => resolve({ exit_code: code, signal, error: null }));
  });
  return { child, pid: child.pid, pgid: child.pid, done };
}
