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
import { matchSelfCheck, requestSelfCheck } from './selfcheck.mjs';

/** Where an unresolvable path (symlink loop) is reported: outside every worktree, so it is always denied. */
export const UNRESOLVABLE = '/dev/null/aos-unresolvable-path';

/**
 * realpath of the deepest existing ancestor, so symlinks cannot escape and not-yet-created files resolve.
 * A DANGLING symlink is followed too: writing to it creates its target, which may lie outside the worktree.
 */
export function realpathDeepest(abs, depth = 0) {
  if (depth > 40) return UNRESOLVABLE;
  for (let d = abs; ; d = path.dirname(d)) {
    try { return path.join(fs.realpathSync(d), path.relative(d, abs)); } catch { /* missing, dangling or looping */ }
    let link = null;
    try { if (fs.lstatSync(d).isSymbolicLink()) link = fs.readlinkSync(d); } catch { /* does not exist */ }
    if (link !== null) {
      const target = path.resolve(realpathDeepest(path.dirname(d), depth + 1), link);
      return realpathDeepest(path.join(target, path.relative(d, abs)), depth + 1);
    }
    if (d === path.dirname(d)) return abs;
  }
}

/** The hook is registered with a 30 s timeout (worker.buildSettings); waiting longer gets it killed mid-wait. */
export const MAX_HOOK_WAIT_S = 25;
/** The wait left once `elapsedMs` of the hook's 30 s have been used (evaluation, regexes): never negative. */
export const remainingWaitMs = (policy, elapsedMs) => Math.max(0, hookWaitMs(policy) - Math.max(0, elapsedMs));
export const hookWaitMs = (policy) => Math.max(0, Math.min(Number(policy?.approval?.wait_in_hook_s ?? 20) || 0, MAX_HOOK_WAIT_S)) * 1000;

export function shapeOutput(event, decision, reason) {
  if (event === 'PermissionRequest') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: reason } } };
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } };
}

/** rule_id / rule_layer / rules_hash (12 chars, when the policy file carries one) for a decision-log record. All safe to log: never free text. */
const ids = (v, cfg) => ({ rule_id: v.rule_id, rule_layer: v.layer, rules_hash: typeof cfg?.rules_hash === 'string' ? cfg.rules_hash.slice(0, 12) : null });

function logDecision(env, rec) {
  if (!env.AOS_DECISION_LOG) return;
  try { fs.appendFileSync(env.AOS_DECISION_LOG, `${JSON.stringify({ ts: new Date().toISOString(), task_id: env.AOS_TASK_ID || null, attempt: Number(env.AOS_ATTEMPT) || null, ...rec })}\n`); } catch { /* best effort */ }
}

/** Core: returns {decision, reason, ...}. Exported for the unit tests (no stdin/stdout). */
export async function decideForPayload(payload, env = process.env) {
  const event = payload.hook_event_name || 'PreToolUse';
  const started = Date.now();
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(env.AOS_POLICY_FILE, 'utf8')); } catch { return { event, decision: 'deny', reason: 'AOS policy: policy file unreadable (fail closed)', rule: 'policy_error', rule_id: 'floor:policy_error' }; }
  if (cfg?.rules_invalid) { // the engine found the goal's rules snapshot tampered or missing: nothing is allowed, and the log says why
    logDecision(env, { event, decision: 'deny', rule: 'rules_snapshot_invalid', rule_id: 'floor:rules_snapshot_invalid', rule_layer: 'floor', rules_hash: typeof cfg.rules_hash === 'string' ? cfg.rules_hash.slice(0, 12) : null, label: safeLabel({ tool_name: payload.tool_name, tool_input: payload.tool_input }) });
    return { event, decision: 'deny', reason: 'AOS policy: the rules snapshot of this goal is invalid (fail closed)', rule: 'rules_snapshot_invalid', rule_id: 'floor:rules_snapshot_invalid' };
  }
  const ctx = { ...cfg.ctx, home: cfg.ctx?.home || process.env.HOME, realpath: realpathDeepest };
  const call = { tool_name: payload.tool_name, tool_input: payload.tool_input, cwd: payload.cwd };
  // worker.self_check: an EXACT approved check argv is never run here; the engine runs it in the check sandbox and the output is the deny reason
  const sc = cfg.ctx?.self_check;
  if (sc && event === 'PreToolUse' && call.tool_name === 'Bash' && Array.isArray(sc.checks) && sc.dir) {
    const idx = matchSelfCheck(call.tool_input?.command, sc.checks);
    if (idx >= 0) {
      const cwdOk = realpathDeepest(path.resolve(String(call.cwd || cfg.ctx.worktree))) === cfg.ctx.worktree;
      const reason = cwdOk ? await requestSelfCheck(sc, idx, { pollMs: Number(env.AOS_APPROVAL_POLL_MS) || 100 })
        : 'AOS self-check: run the check from the task worktree root (the directory you started in), exactly as approved; not run.';
      logDecision(env, { event, decision: 'deny', rule: cwdOk ? 'self_check' : 'self_check_cwd', rule_id: `floor:${cwdOk ? 'self_check' : 'self_check_cwd'}`, rule_layer: 'floor', rules_hash: ids({}, cfg).rules_hash, label: safeLabel(call) });
      return { event, decision: 'deny', reason, rule: 'self_check', rule_id: 'floor:self_check' };
    }
  }
  const v = evaluate(cfg.policy, call, ctx);
  if (v.decision !== 'ask') {
    logDecision(env, { event, decision: v.decision, rule: v.rule, ...ids(v, cfg), label: safeLabel(call) });
    return { event, decision: v.decision, reason: v.decision === 'allow' ? 'AOS policy: allowed' : `AOS policy: ${v.reason}`, rule: v.rule, rule_id: v.rule_id };
  }
  // ask: file an approval request, wait up to wait_in_hook_s, then deny
  const ap = cfg.policy?.approval || {};
  const dir = env.AOS_APPROVALS_DIR;
  if (!dir) return { event, decision: 'deny', reason: 'AOS policy: approval needed but no inbox configured', rule: 'policy_error', rule_id: 'floor:policy_error' };
  const rec = createApproval(dir, { goal_id: env.AOS_GOAL_ID || null, task_id: env.AOS_TASK_ID || null, attempt: Number(env.AOS_ATTEMPT) || 0,
    tool: call.tool_name, input: call.tool_input, cwd: call.cwd || null, reason: v.reason, rule: v.rule, rule_id: v.rule_id }, { ttl_s: ap.ttl_s || 86400 });
  const pollMs = Number(env.AOS_APPROVAL_POLL_MS) || 100;
  const done = rec.status !== 'pending' ? rec : await waitForDecision(dir, rec.id, { timeoutMs: remainingWaitMs(cfg.policy, Date.now() - started), pollMs });
  if (done && done.status === 'approved') {
    logDecision(env, { event, decision: 'allow', rule: 'approved', rule_id: 'grant:approved', rule_layer: 'grant', rules_hash: ids(v, cfg).rules_hash, asked_by: v.rule_id, approval: rec.id, label: safeLabel(call) });
    return { event, decision: 'allow', reason: `AOS policy: approved (${rec.id})`, rule: 'approved', rule_id: 'grant:approved', approval: rec.id };
  }
  const why = done && done.status === 'denied' ? `approval ${rec.id} was denied` : `approval ${rec.id} pending; do not retry; finish and report what you needed`;
  logDecision(env, { event, decision: 'deny', rule: 'ask_unresolved', rule_id: 'floor:ask_unresolved', rule_layer: 'floor', rules_hash: ids(v, cfg).rules_hash, asked_by: v.rule_id, approval: rec.id, label: safeLabel(call) });
  return { event, decision: 'deny', reason: `AOS policy: ${why}`, rule: 'ask_unresolved', rule_id: 'floor:ask_unresolved', approval: rec.id };
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
