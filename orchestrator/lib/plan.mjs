// Planner prompt + strict plan validation (design sections 4, 5). The plan comes from a model, so it is untrusted:
// anything unsafe or malformed is rejected, never repaired.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PLANNER_MARKER } from './worker.mjs';
import { commandAllowed } from './checks.mjs';
import crypto from 'node:crypto';
import { evaluate, DEFAULT_POLICY, allowlistEntryProblem } from './policy.mjs';
import { ID_RE, iso } from './state.mjs';

export const TIERS = ['haiku', 'sonnet', 'opus'];
export const PLANNER_SYSTEM = 'You are the planner for an AOS-1 goal. You do not edit files. Output ONLY one JSON object.';
const OUTPUT_SCHEMA = '{"tasks":[{"id","title","description","depends_on":[],"model_tier":"haiku|sonnet|opus","path_scope":["glob"],'
  + '"allowed_commands":["..."],"checks":[{"argv":[],"timeout_s":n}],"output_contract","acceptance":["..."]}], "risks":["..."]}';

/** Repo facts for the planner: file tree depth 2 (tracked files) and Makefile targets. Bounded and read-only. */
export function gatherRepoFacts(dir) {
  const facts = { files: [], make_targets: [] };
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 });
    const set = new Set();
    for (const f of out.split('\n').filter(Boolean)) set.add(f.split('/').slice(0, 2).join('/'));
    facts.files = [...set].slice(0, 200);
  } catch { /* not a repo or git missing */ }
  try {
    const mk = fs.readFileSync(path.join(dir, 'Makefile'), 'utf8');
    facts.make_targets = [...mk.matchAll(/^([A-Za-z0-9_.-]+):/gm)].map((m) => m[1]).slice(0, 50);
  } catch { /* none */ }
  return facts;
}

export function buildPlannerPrompt({ goal, facts = { files: [], make_targets: [] }, constraints }) {
  const B = goal.orch.budgets;
  const c = constraints || { max_tasks: B.max_tasks, tiers: TIERS, check_allowlist: goal.orch.check_allowlist || [] };
  const crit = goal.success_criteria.map((x) => `- ${x.id}: ${x.text}${x.check ? ` (check argv: ${JSON.stringify(x.check.argv)})` : ''}`).join('\n');
  const prompt = [
    `${PLANNER_MARKER}`,
    `Goal: ${goal.title}${goal.description ? `\n${goal.description}` : ''}`,
    `Success criteria:\n${crit}`,
    `Repo facts: files (depth 2): ${facts.files.join(' ') || '(unknown)'}; Makefile targets: ${facts.make_targets.join(' ') || '(none)'}`,
    `Constraints: max_tasks=${c.max_tasks}; allowed tiers: ${c.tiers.join(', ')}; command allowlist candidates for checks: ${JSON.stringify(c.check_allowlist)}`,
    'WORKERS CANNOT RUN CODE: their Bash is limited to read-only inspection (ls, cat, head, tail, wc, grep, rg, find -name, diff, git status/diff/log/show). '
      + 'node, npm/npx/pnpm/yarn, make, python, ruby, perl, shells, env/xargs wrappers, find -exec and git hooks-running subcommands are rejected: a plan whose allowed_commands contain any of them is REJECTED. '
      + 'Leave allowed_commands empty unless a read-only command is really needed. Put ALL verification (tests, builds, linters) in each task\'s `checks`: the engine runs those itself, in an OS sandbox (no network, writes only inside the task worktree). '
      + 'A human reviews every plan that has commands before anything is dispatched.',
    'Produce tasks that are small (one concern, ideally < 200 changed lines), have disjoint path_scope where possible, start at the cheapest plausible tier, and each have at least one check from the allowed commands.',
    `OUTPUT SCHEMA: ${OUTPUT_SCHEMA}`,
  ].join('\n');
  return { system: PLANNER_SYSTEM, prompt };
}

/** Pull the one JSON object out of the planner's result text (plain, fenced, or surrounded by prose). */
export function extractJson(text) {
  if (typeof text !== 'string') return { error: 'planner returned no text' };
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const cands = fenced ? [fenced[1], text] : [text];
  for (const s of cands) {
    const start = s.indexOf('{');
    if (start < 0) continue;
    let depth = 0; let inStr = false; let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return { value: JSON.parse(s.slice(start, i + 1)) }; } catch (e) { return { error: `plan JSON does not parse: ${e.message}` }; }
      }
    }
  }
  return { error: 'no JSON object found in planner output' };
}

const BAD_SCOPE_ROOTS = /^(\.git|\.claude)(\/|$)/;
const BROAD = new Set(['**', '**/*', '*', '.', './', '/']);

export function validateScope(g) {
  if (typeof g !== 'string' || !g.trim()) return 'empty path_scope entry';
  if (path.isAbsolute(g) || g.startsWith('~')) return `path_scope "${g}" must be relative to the repo`;
  if (g.split('/').includes('..')) return `path_scope "${g}" escapes the repo`;
  if (BROAD.has(g)) return `path_scope "${g}" is too broad`;
  if (BAD_SCOPE_ROOTS.test(g.replace(/^\.\//, ''))) return `path_scope "${g}" targets protected files`;
  if (/[\0\n]/.test(g)) return 'path_scope contains control characters';
  return null;
}

/** Cycle check (Kahn). Returns the ids left in a cycle, or []. */
export function findCycle(tasks) {
  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  for (const t of tasks) for (const d of t.depends_on) if (indeg.has(d)) indeg.set(t.id, indeg.get(t.id) + 1);
  const q = [...indeg].filter(([, n]) => n === 0).map(([id]) => id);
  let seen = 0;
  while (q.length) {
    const id = q.shift(); seen++;
    for (const t of tasks) if (t.depends_on.includes(id)) { indeg.set(t.id, indeg.get(t.id) - 1); if (indeg.get(t.id) === 0) q.push(t.id); }
  }
  return seen === tasks.length ? [] : [...indeg].filter(([, n]) => n > 0).map(([id]) => id);
}

const UNSAFE_CHECK_CMDS = new Set(['sh', 'bash', 'zsh', 'fish', 'eval', 'exec', 'sudo', 'su', 'curl', 'wget', 'nc', 'ssh', 'scp', 'rsync', 'env', 'xargs', 'open', 'osascript']);

/**
 * Strict validation. opts: {max_tasks, check_allowlist, taskIdPrefix?}. Returns {ok, errors[], tasks[] (normalised)}.
 */
export function validatePlan(plan, opts) {
  const errors = [];
  const bad = (m) => errors.push(m);
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, errors: ['plan must be a JSON object'], tasks: [] };
  if (!Array.isArray(plan.tasks) || !plan.tasks.length) return { ok: false, errors: ['plan.tasks must be a non-empty array'], tasks: [] };
  if (plan.tasks.length > opts.max_tasks) bad(`plan has ${plan.tasks.length} tasks, max_tasks is ${opts.max_tasks}`);
  const ids = new Set();
  const tasks = [];
  for (const [i, t] of plan.tasks.entries()) {
    const at = `tasks[${i}]${t && t.id ? `(${t.id})` : ''}`;
    if (!t || typeof t !== 'object') { bad(`${at}: not an object`); continue; }
    if (typeof t.id !== 'string' || !ID_RE.test(t.id)) bad(`${at}: id must match ${ID_RE}`);
    else if (t.id === 'integration' || t.id === 'planner') bad(`${at}: reserved id`);
    else if (ids.has(t.id)) bad(`${at}: duplicate id`);
    else ids.add(t.id);
    for (const f of ['title', 'description', 'output_contract']) if (typeof t[f] !== 'string' || !t[f].trim()) bad(`${at}: ${f} is required`);
    if (!Array.isArray(t.depends_on)) bad(`${at}: depends_on must be an array`);
    if (!TIERS.includes(t.model_tier)) bad(`${at}: model_tier must be one of ${TIERS.join('|')}`);
    if (!Array.isArray(t.acceptance) || !t.acceptance.length || t.acceptance.some((a) => typeof a !== 'string' || !a.trim())) bad(`${at}: acceptance needs at least one non-empty string`);
    if (!Array.isArray(t.path_scope) || !t.path_scope.length) bad(`${at}: path_scope must be a non-empty array`);
    else for (const g of t.path_scope) { const m = validateScope(g); if (m) bad(`${at}: ${m}`); }
    const cmds = t.allowed_commands ?? [];
    if (!Array.isArray(cmds) || cmds.some((c) => typeof c !== 'string')) bad(`${at}: allowed_commands must be an array of strings`);
    else for (const c of cmds) {
      const prob = allowlistEntryProblem(c);
      if (prob) { bad(`${at}: allowed_commands entry "${c}" is dangerous or executes code and is rejected: ${prob}`); continue; }
      const v = evaluate(DEFAULT_POLICY, { tool_name: 'Bash', tool_input: { command: c }, cwd: '/w' }, { worktree: '/w', path_scope: [], allowed_tools: ['Bash'], allowed_commands: [c], grants: [] });
      if (v.decision === 'deny') bad(`${at}: allowed_commands entry "${c}" is dangerous (${v.rule})`);
    }
    if (!Array.isArray(t.checks) || !t.checks.length) bad(`${at}: at least one check is required`);
    else for (const [j, c] of t.checks.entries()) {
      if (!c || !Array.isArray(c.argv) || !c.argv.length || c.argv.some((a) => typeof a !== 'string')) { bad(`${at}.checks[${j}]: argv must be a non-empty string array`); continue; }
      if (!(typeof c.timeout_s === 'number' && c.timeout_s > 0 && c.timeout_s <= 3600)) bad(`${at}.checks[${j}]: timeout_s must be in (0, 3600]`);
      if (UNSAFE_CHECK_CMDS.has(path.basename(c.argv[0]))) bad(`${at}.checks[${j}]: ${c.argv[0]} is not allowed as a check`);
      else if (!commandAllowed(c.argv, opts.check_allowlist)) bad(`${at}.checks[${j}]: "${c.argv.join(' ')}" is not on the goal's check allowlist`);
    }
    if (Array.isArray(t.depends_on) && typeof t.id === 'string') tasks.push(t);
  }
  for (const t of tasks) for (const d of t.depends_on) {
    if (typeof d !== 'string' || !ids.has(d)) bad(`${t.id}: depends_on "${d}" is not a task in the plan`);
    else if (d === t.id) bad(`${t.id}: depends on itself`);
  }
  if (!errors.length) { const cyc = findCycle(tasks); if (cyc.length) bad(`dependency cycle among: ${cyc.join(', ')}`); }
  return { ok: errors.length === 0, errors, tasks: errors.length ? [] : tasks };
}

/** Build AOS-1 task objects (+ orch extension, design section 3) from a validated plan. */
export function toTasks(planTasks, goal, nowMs) {
  const ts = iso(nowMs);
  const B = goal.orch.budgets;
  return planTasks.map((t) => ({
    id: t.id, goal_id: goal.id, title: t.title, assignee: `worker-${t.id}`, status: 'pending', depends_on: [...t.depends_on],
    attempts: 0, max_attempts: B.max_attempts, output_contract: t.output_contract, acceptance: [...t.acceptance], artifacts: [],
    created_at: ts, updated_at: ts,
    orch: {
      description: t.description, model_tier: t.model_tier, tier_ladder: [...TIERS], path_scope: [...t.path_scope], read_scope: ['**'],
      allowed_tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'], allowed_commands: [...(t.allowed_commands || [])],
      checks: t.checks.map((c) => ({ argv: [...c.argv], timeout_s: c.timeout_s })), branch: `aos/${goal.id}/${t.id}`, worktree: null,
      phase: null, attempt_log: [], grants: [], result_summary: null, tokens: { new: 0, cache_read: 0 }, denial_retries: 0, note: null,
    },
  }));
}


// ---------------------------------------------------------------- human review of plans with commands (condition 3)
/** Checks the engine may approve without a human: pure read-only inspection of files, no code execution. Deliberately tiny.
 *  `make test`, `node --test <glob>`, npm/pytest/... execute worker-written code and are NEVER auto-approvable. */
export const AUTO_APPROVABLE_CHECKS = ['grep', 'test', 'diff', 'cmp'];
export function checkAutoApprovable(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string')) return false;
  const a0 = argv[0];
  const name = path.basename(a0);
  if (a0 !== name && a0 !== `/usr/bin/${name}` && a0 !== `/bin/${name}`) return false;
  return AUTO_APPROVABLE_CHECKS.includes(name);
}

/** Why this set of (validated) plan tasks needs a human, or null when plan_approval "auto" may proceed. Works on plan tasks or engine tasks. */
export function humanReviewReason(tasks) {
  const cmds = [];
  for (const t of tasks) {
    const o = t.orch || t;
    for (const c of o.allowed_commands || []) cmds.push(`${t.id} allowed_commands: ${c}`);
    for (const c of o.checks || []) if (!checkAutoApprovable(c.argv)) cmds.push(`${t.id} check: ${c.argv.join(' ')}`);
  }
  return cmds.length ? `plan contains commands that need human review (${cmds.slice(0, 5).join('; ')}${cmds.length > 5 ? `; +${cmds.length - 5} more` : ''})` : null;
}

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** Hash of the plan as stored in plan.json. */
export const planHash = (plan) => sha256(canonical(plan));
/** What a human reviews, per task, in plain text: tier, path scope, allowed commands and the exact check commands. */
export function reviewView(tasks) {
  return tasks.map((t) => { const o = t.orch || t; return { id: t.id, model_tier: o.model_tier, path_scope: [...o.path_scope], depends_on: [...(t.depends_on || [])],
    allowed_commands: [...(o.allowed_commands || [])], checks: (o.checks || []).map((c) => ({ command: c.argv.join(' '), argv: c.argv, timeout_s: c.timeout_s })) }; });
}
/** Hash of everything the approval covers in the engine's tasks (tier excluded: the retry ladder escalates it legitimately). */
export function tasksHash(tasks) {
  return sha256(canonical(tasks.map((t) => { const o = t.orch || t; return { id: t.id, depends_on: t.depends_on || [], path_scope: o.path_scope, allowed_commands: o.allowed_commands || [],
    allowed_tools: o.allowed_tools || null, checks: (o.checks || []).map((c) => ({ argv: c.argv, timeout_s: c.timeout_s })) }; })));
}
/** Plain-text rendering of reviewView for `status` / `approvals`. */
export function renderReview(view) {
  const L = [];
  for (const t of view) {
    L.push(`task ${t.id}  tier=${t.model_tier}  scope=${t.path_scope.join(', ')}${t.depends_on.length ? `  after=${t.depends_on.join(',')}` : ''}`);
    L.push(`  worker commands: ${t.allowed_commands.length ? t.allowed_commands.join(' | ') : '(none; read-only inspection only)'}`);
    for (const c of t.checks) L.push(`  check (sandboxed, ${c.timeout_s}s): ${c.argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`);
  }
  return L.join('\n');
}
