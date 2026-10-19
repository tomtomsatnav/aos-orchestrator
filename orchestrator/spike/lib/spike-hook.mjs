#!/usr/bin/env node
// Spike policy hook (prototype of the real policy hook). Registered via --settings for:
// SessionStart, PreToolUse, PermissionRequest, PostToolUse.
// 1. Logs the event + AOS_* env vars it inherited from the launcher (proves env inheritance).
// 2. PreToolUse: Write/Edit outside $AOS_WORKTREE -> JSON permissionDecision "deny";
//                Bash containing `git push` -> exit code 2 with a stderr reason.
// 3. PermissionRequest: Bash `touch <file inside worktree>` -> allow; everything else -> deny.
import fs from 'node:fs';
import path from 'node:path';

const LOG = process.env.AOS_SPIKE_LOG || path.join(process.env.TMPDIR || '/tmp', 'orch-spike-hook.ndjson');
let p = {};
try { p = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* empty */ }
const wt = process.env.AOS_WORKTREE ? fs.realpathSync(process.env.AOS_WORKTREE) : null;
const inside = (f) => {
  if (!wt || typeof f !== 'string') return false;
  const abs = path.resolve(p.cwd || '/', f);
  let real = abs; // resolve the deepest existing ancestor so symlinks cannot escape
  for (let d = abs; ; d = path.dirname(d)) {
    if (fs.existsSync(d)) { real = path.join(fs.realpathSync(d), path.relative(d, abs)); break; }
    if (d === path.dirname(d)) break;
  }
  return real === wt || real.startsWith(wt + path.sep);
};
const ti = p.tool_input || {};
const log = (decision) => fs.appendFileSync(LOG, JSON.stringify({
  ts: new Date().toISOString(), ev: p.hook_event_name, sid: p.session_id, cwd: p.cwd, tool: p.tool_name,
  input: ti.command ?? ti.file_path, permission_mode: p.permission_mode, decision,
  env: { AOS_GOAL_ID: process.env.AOS_GOAL_ID ?? null, AOS_TASK_ID: process.env.AOS_TASK_ID ?? null,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA ?? null },
  payload_keys: Object.keys(p),
}) + '\n');

const ev = p.hook_event_name;
if (ev === 'PreToolUse') {
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(p.tool_name) && !inside(ti.file_path)) {
    log('deny:json');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: `AOS policy: writes are confined to the task worktree (${wt}).` } }));
    process.exit(0);
  }
  if (p.tool_name === 'Bash' && /\bgit\s+push\b/.test(String(ti.command))) {
    log('deny:exit2');
    process.stderr.write('AOS policy: git push is never allowed for workers.');
    process.exit(2);
  }
  log('pass'); process.exit(0);
}
if (ev === 'PermissionRequest') {
  const m = /^touch\s+(\S+)$/.exec(String(ti.command || '').trim());
  if (p.tool_name === 'Bash' && m && inside(m[1])) {
    log('allow');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));
  } else {
    log('deny');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: 'AOS policy: not in the task allowlist; approval required.' } } }));
  }
  process.exit(0);
}
log('observe');
process.exit(0);
