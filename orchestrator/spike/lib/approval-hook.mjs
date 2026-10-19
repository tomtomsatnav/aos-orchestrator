#!/usr/bin/env node
// Spike: can a PreToolUse hook hold a worker while a human decides, and what happens on hook timeout?
// Registered with "timeout": 10 (seconds).
//   Bash `touch a.txt` -> wait 8 s (inside the timeout), then permissionDecision "allow"
//                         (touch is NOT in --allowedTools, so this also tests whether a hook "allow" skips the prompt)
//   Bash `touch b.txt` -> wait 30 s (exceeds the timeout): observe what Claude Code does
//   anything else      -> no decision
import fs from 'node:fs';
const LOG = process.env.AOS_SPIKE_LOG;
let p = {}; try { p = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
const cmd = String(p.tool_input?.command || '').trim();
const log = (x) => LOG && fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ev: p.hook_event_name, cmd, ...x }) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (p.hook_event_name === 'PreToolUse' && cmd === 'touch a.txt') {
  log({ phase: 'waiting 8s' }); await wait(8000); log({ phase: 'allow' });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'approved by human (spike)' } }));
} else if (p.hook_event_name === 'PreToolUse' && cmd === 'touch b.txt') {
  log({ phase: 'waiting 30s (timeout is 10s)' }); await wait(30000); log({ phase: 'still alive after 30s, emitting allow' });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }));
} else log({ phase: 'no decision' });
process.exit(0);
