#!/usr/bin/env node
// PreToolUse / PermissionRequest hook the engine registers via --settings (design sections 6 and 7).
// stdin: Claude Code hook payload. env: AOS_POLICY_FILE (effective policy + task context), AOS_APPROVALS_DIR,
// AOS_GOAL_ID, AOS_TASK_ID, AOS_ATTEMPT. stdout: the verified JSON decision shape. Always exits 0 (JSON deny, not
// exit 2, because exit 2 leaks the hook command line to the model). Fails closed on any problem.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, callSummary, safeLabel } from './policy.mjs';
import { createApproval, waitForDecision } from './approvals.mjs';

/** realpath of the deepest existing ancestor, so symlinks cannot escape and not-yet-created files resolve. */
export function realpathDeepest(abs) {
  for (let d = abs; ; d = path.dirname(d)) {
    try { return path.join(fs.realpathSync(d), path.relative(d, abs)); } catch { /* try parent */ }
    if (d === path.dirname(d)) return abs;
  }
}

export function shapeOutput(event, decision, reason) {
  if (event === 'PermissionRequest') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: reason } } };
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } };
}

function logDecision(env, rec) {
  if (!env.AOS_DECISION_LOG) return;
  try { fs.appendFileSync(env.AOS_DECISION_LOG, `${JSON.stringify({ ts: new Date().toISOString(), task_id: env.AOS_TASK_ID || null, attempt: Number(env.AOS_ATTEMPT) || null, ...rec })}\n`); } catch { /* best effort */ }
}

/** Core: returns {decision, reason, ...}. Exported for the unit tests (no stdin/stdout). */
export async function decideForPayload(payload, env = process.env) {
  const event = payload.hook_event_name || 'PreToolUse';
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(env.AOS_POLICY_FILE, 'utf8')); } catch { return { event, decision: 'deny', reason: 'AOS policy: policy file unreadable (fail closed)', rule: 'policy_error' }; }
  const ctx = { ...cfg.ctx, home: cfg.ctx?.home || process.env.HOME, realpath: realpathDeepest };
  const call = { tool_name: payload.tool_name, tool_input: payload.tool_input, cwd: payload.cwd };
  const v = evaluate(cfg.policy, call, ctx);
  if (v.decision !== 'ask') {
    logDecision(env, { event, decision: v.decision, rule: v.rule, label: safeLabel(call) });
    return { event, decision: v.decision, reason: v.decision === 'allow' ? 'AOS policy: allowed' : `AOS policy: ${v.reason}`, rule: v.rule };
  }
  // ask: file an approval request, wait up to wait_in_hook_s, then deny
  const ap = cfg.policy?.approval || {};
  const dir = env.AOS_APPROVALS_DIR;
  if (!dir) return { event, decision: 'deny', reason: 'AOS policy: approval needed but no inbox configured', rule: 'policy_error' };
  const rec = createApproval(dir, { goal_id: env.AOS_GOAL_ID || null, task_id: env.AOS_TASK_ID || null, attempt: Number(env.AOS_ATTEMPT) || 0,
    tool: call.tool_name, input: call.tool_input, reason: v.reason, rule: v.rule }, { ttl_s: ap.ttl_s || 86400 });
  const pollMs = Number(env.AOS_APPROVAL_POLL_MS) || 100;
  const done = rec.status !== 'pending' ? rec : await waitForDecision(dir, rec.id, { timeoutMs: (ap.wait_in_hook_s ?? 20) * 1000, pollMs });
  if (done && done.status === 'approved') {
    logDecision(env, { event, decision: 'allow', rule: 'approved', approval: rec.id, label: safeLabel(call) });
    return { event, decision: 'allow', reason: `AOS policy: approved (${rec.id})`, rule: 'approved', approval: rec.id };
  }
  const why = done && done.status === 'denied' ? `approval ${rec.id} was denied` : `approval ${rec.id} pending; do not retry; finish and report what you needed`;
  logDecision(env, { event, decision: 'deny', rule: 'ask_unresolved', approval: rec.id, label: safeLabel(call) });
  return { event, decision: 'deny', reason: `AOS policy: ${why}`, rule: 'ask_unresolved', approval: rec.id };
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* fail closed below */ }
  const event = payload.hook_event_name || 'PreToolUse';
  let out;
  try {
    const r = payload.tool_name ? await decideForPayload(payload) : { decision: 'deny', reason: 'AOS policy: unparseable payload (fail closed)' };
    out = shapeOutput(event, r.decision, r.reason);
  } catch (e) {
    out = shapeOutput(event, 'deny', `AOS policy: internal error (fail closed)`);
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
