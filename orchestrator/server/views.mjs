// Response shaping for the control API: GoalSummary / GoalDetail / plan / approvals / events. Nothing here returns a full
// filesystem path: repo is a basename, free text from the engine is scrubbed, approval cwd is shown relative to the worktree.
import path from 'node:path';
import { loadState, loadHeartbeat, readEvents, paths, goalDirOf } from '../lib/state.mjs';
import { listApprovals } from '../lib/approvals.mjs';
import { renderRulesSummary } from '../lib/rules.mjs';
import { readRulesSummary } from '../lib/rules-store.mjs';
import { escCtrl } from '../lib/ctrl.mjs';

// absolute-path-looking token (leading slash, at least one more segment) -> its basename
const PATH_RE = /(?<![\w.:/~-])\/(?:[^\s/"'`<>|;,()\\]+\/)+[^\s/"'`<>|;,()\\]*/g;
export function scrub(s) {
  if (typeof s !== 'string') return s;
  return s.replace(PATH_RE, (m) => path.basename(m) || '<path>');
}
export function scrubDeep(v, depth = 0) {
  if (typeof v === 'string') return scrub(v);
  if (depth > 8) return null;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = scrubDeep(x, depth + 1); return o; }
  return v;
}

const cmdText = (argv) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');

export function eventView(e) { return { ts: e.ts, seq: e.seq, type: e.type, actor: e.actor, goal_id: e.goal_id, task_id: e.task_id, data: scrubDeep(e.data || {}) }; }

function pendingCount(dir) { return listApprovals(paths(dir).approvals, { status: 'pending' }).length; }

export function goalSummary(sup, id) {
  const dir = goalDirOf(sup.orchDir, id);
  const { goal, tasks } = loadState(dir); const hb = loadHeartbeat(dir);
  const o = goal.orch; const now = sup.clock.now();
  const endMs = ['achieved', 'failed', 'cancelled', 'blocked'].includes(goal.status) && !sup.handles.get(id)?.engine.workers.size ? Date.parse(goal.updated_at) : now;
  const used_wall_s = o.started_ms ? Math.max(0, Math.round(((endMs || now) - o.started_ms) / 1000)) : 0;
  const paused = hb.status === 'paused';
  return {
    id: goal.id, title: goal.title, status: goal.status, repo_name: path.basename(o.repo || ''), created_at: goal.created_at, updated_at: goal.updated_at,
    plan_state: o.plan_state, paused_reason: o.paused_reason || (paused ? 'paused by a human' : null), resume_at: o.resume_at || null,
    budget: { max_new_tokens: o.budgets.max_new_tokens, used_new_tokens: o.usage.new_tokens, max_wall_s: goal.budget.max_wall_clock_s, used_wall_s,
      max_parallel: o.budgets.max_parallel, running: tasks.filter((t) => t.status === 'running').length, max_attempts: o.budgets.max_attempts },
    tasks_total: tasks.length, tasks_done: tasks.filter((t) => t.status === 'done').length, tasks_failed: tasks.filter((t) => t.status === 'failed').length,
    approvals_pending: pendingCount(dir),
    paused, blocked_reason: scrub(goal.blocked_reason || null),
  };
}

export function goalDetail(sup, id) {
  const dir = goalDirOf(sup.orchDir, id);
  const { goal, tasks } = loadState(dir);
  const now = sup.clock.now();
  const pend = listApprovals(paths(dir).approvals, { status: 'pending' });
  const evs = readEvents(dir, { limit: 25 });
  return {
    ...goalSummary(sup, id), description: goal.description || '',
    criteria: goal.success_criteria.map((c) => ({ id: c.id, text: c.text, met: !!c.met })),
    tasks: tasks.map((t) => {
      const log = t.orch.attempt_log || [];
      const ran = log.reduce((s, a) => s + Math.max(0, ((a.ended_at ? Date.parse(a.ended_at) : now) - Date.parse(a.started_at)) / 1000 || 0), 0);
      const last = log.at(-1);
      const lf = t.orch.last_failure;
      const o = { id: t.id, title: escCtrl(t.title), status: t.status, phase: t.orch.phase || null, tier: t.orch.model_tier, depends_on: t.depends_on, attempts: t.attempts, max_attempts: t.max_attempts,
        branch: t.orch.branch, ran_s: Math.round(ran), new_tokens: t.orch.tokens?.new || 0,
        check_summary: t.orch.phase === 'checking' ? 'checking' : last?.checks_ok === true ? 'checks passed' : last?.checks_ok === false ? 'checks failed' : t.status === 'done' ? 'checks passed' : null,
        waiting_for_human: t.status === 'needs_review' || pend.some((a) => a.task_id === t.id) };
      if (lf && t.status !== 'done') o.error = scrub(`${lf.kind}${lf.note ? `: ${lf.note}` : ''}`).slice(0, 300);
      return o;
    }),
    last_events: evs.map(eventView),
  };
}

/** Every string in a plan view is shown to a human: control, C1, bidi and zero-width characters are escaped. */
const escDeep = (v) => (typeof v === 'string' ? escCtrl(v) : Array.isArray(v) ? v.map(escDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [escCtrl(k), escDeep(x)])) : v);

export function planView(sup, id) {
  const { S, dir } = sup.state(id);
  const h = sup.reviewHash(id);
  // additive: what the human approves besides the tasks (profile, key allows/denies, limits, EVERY loosening with its layer); rules_text is the same as the CLI prints it
  const rs = readRulesSummary(dir, S.goal);
  return { plan_state: S.goal.orch.plan_state, plan_hash: h ? h.combined : null, rules: rs ? scrubDeep(rs) : null, rules_text: rs && !rs.tampered ? scrub(renderRulesSummary(rs)) : null,
    tasks: escDeep(S.tasks.map((t) => ({ id: t.id, title: t.title, tier: t.orch.model_tier, depends_on: t.depends_on, path_scope: t.orch.path_scope,
      allowed_commands: t.orch.allowed_commands || [], checks: (t.orch.checks || []).map((c) => ({ cmd: cmdText(c.argv), argv: c.argv, timeout_s: c.timeout_s })),
      allowed_tools: t.orch.allowed_tools || [] }))) };
}

// any <repo>-aos-worktrees/<goal>/<task|integration> prefix (the task's own worktree is gone once it is merged)
const WT_RE = /(?:\/[^\s/]+)*\/[^\s/]+-aos-worktrees\/[^\s/]+\/[^\s/]+/g;
const KIND = { Bash: 'command', Write: 'write', Edit: 'write', NotebookEdit: 'write', Read: 'read', Glob: 'read', Grep: 'read' };

/** EXCEPTION to "no full paths": the exact command / file the worker asked for is shown (a human cannot approve blind); only the worktree prefix is replaced. */
export function approvalView(sup, a) {
  const dir = goalDirOf(sup.orchDir, a.goal);
  const { tasks } = loadState(dir);
  const t = tasks.find((x) => x.id === a.task_id);
  const wt = t?.orch.worktree;
  const rep = (s) => { let r = String(s ?? ''); for (const w of [wt, wt && safeReal(wt)]) if (w) r = r.split(w).join('<worktree>'); return r.replace(WT_RE, '<worktree>'); };
  const raw = a.tool === 'Bash' ? a.input?.command : (a.input?.file_path || a.input?.notebook_path || a.input?.pattern || a.input?.path || JSON.stringify(a.input || {}));
  let cwd = null;
  if (a.cwd) { const r = rep(a.cwd); cwd = r.startsWith('<worktree>') ? (r.slice('<worktree>'.length).replace(/^\//, '') || '.') : path.basename(a.cwd); }
  return { id: `${a.goal}~${a.id}`, goal_id: a.goal, task_id: a.task_id, kind: KIND[a.tool] || 'tool', tool: a.tool, summary: rep(raw).slice(0, 500), reason: scrub(a.reason || ''), cwd,
    created_at: a.requested_at, expires_at: a.expires_at, status: a.status };
}
function safeReal(p) { try { return path.resolve(p); } catch { return p; } }
