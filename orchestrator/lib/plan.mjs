// Planner prompt + strict plan validation (design sections 4, 5). The plan comes from a model, so it is untrusted:
// anything unsafe or malformed is rejected, never repaired.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PLANNER_MARKER } from './worker.mjs';
import { commandAllowed, argvProblem } from './checks.mjs';
import crypto from 'node:crypto';
import { evaluate, DEFAULT_POLICY, allowlistEntryProblem } from './policy.mjs';
import { ID_RE, iso } from './state.mjs';
import { scopeHitsDeny, globCompileProblem, MAX_SCOPE_LEN } from './glob.mjs';
import { CTRL_RE, escCtrl } from './ctrl.mjs';
import { untrustedBlocks } from './untrusted.mjs';
import { isTestPath } from './protect.mjs';

export const TIERS = ['haiku', 'sonnet', 'opus'];
export const PLANNER_SYSTEM = 'You are the planner for an AOS-1 goal. You do not edit files. Output ONLY one JSON object.';
const OUTPUT_SCHEMA = '{"tasks":[{"id","title","description","depends_on":[],"model_tier":"haiku|sonnet|opus","path_scope":["glob"],'
  + '"allowed_commands":["..."],"checks":[{"argv":[],"timeout_s":n}],"output_contract","acceptance":["..."],"role":"implementation|acceptance (optional)","allow_skip":["reason (optional)"]}], "risks":["..."]}';

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

/** The tiers a plan may use: plan.tiers, none above plan.max_start_tier (what validatePlan enforces). */
export const startableTiers = (tiers, maxStart) => { const m = TIERS.indexOf(maxStart); return (tiers || TIERS).filter((t) => m < 0 || TIERS.indexOf(t) <= m); };

/** `replan` = {errors[], plan?}: the previous plan was rejected by validatePlan; the exact errors are fed back (one automatic re-plan). */
export function buildPlannerPrompt({ goal, facts = { files: [], make_targets: [] }, constraints, replan = null }) {
  const B = goal.orch.budgets;
  const c = constraints || { max_tasks: B.max_tasks, tiers: TIERS, check_allowlist: goal.orch.check_allowlist || [] };
  const crit = goal.success_criteria.map((x) => `- ${x.id}: ${x.text}${x.check ? ` (check argv: ${JSON.stringify(x.check.argv)})` : ''}`).join('\n');
  const U = untrustedBlocks([{ label: 'repo facts', text: `files (depth 2): ${facts.files.join(' ') || '(unknown)'}; Makefile targets: ${facts.make_targets.join(' ') || '(none)'}`, max: 8000 }]);
  const prompt = [
    `${PLANNER_MARKER}`,
    `Goal: ${goal.title}${goal.description ? `\n${goal.description}` : ''}`,
    `Success criteria:\n${crit}`,
    U.notice,
    `Repo facts (from the repository, so untrusted): ${U.blocks[0]}`,
    `Constraints: max_tasks=${c.max_tasks}; allowed tiers: ${c.tiers.join(', ')}; command allowlist candidates for checks: ${JSON.stringify(c.check_allowlist)}`,
    `HARD LIMITS (a plan that breaks any of them is REJECTED, not repaired): every task's model_tier must be one of [${c.tiers.join(', ')}]${c.max_start_tier ? ` and never above "${c.max_start_tier}" (plan.max_start_tier)` : ''}; at most ${c.max_tasks} tasks; every check argv must START with one of ${JSON.stringify(c.check_allowlist)} (nothing else, no other runner)${c.scope_deny?.length ? `; path_scope must not reach any of ${JSON.stringify(c.scope_deny)}` : ''}${c.protected_tests?.length ? `; these EXISTING test files must stay unchanged, never put them in a path_scope (add new test files instead): ${JSON.stringify(c.protected_tests.slice(0, 30))}` : ''}.`,
    'WORKERS CANNOT RUN CODE: their Bash is limited to read-only inspection (ls, cat, head, tail, wc, grep, rg, find -name, diff, git status/diff/log/show). '
      + 'node, npm/npx/pnpm/yarn, make, python, ruby, perl, shells, env/xargs wrappers, find -exec and git hooks-running subcommands are rejected: a plan whose allowed_commands contain any of them is REJECTED. '
      + 'allowed_commands are ONLY for read-only inspection. Creating or editing files needs NO command: workers write files with their Write/Edit tools within path_scope, so never add printf/echo/tee/redirect/sed-style commands. '
      + 'Leave allowed_commands empty unless a read-only command is really needed. Put ALL verification (tests, builds, linters) in each task\'s `checks`: the engine runs those itself, in an OS sandbox (no network, writes only inside the task worktree). '
      + 'A human reviews every plan that has commands before anything is dispatched.',
    ...(c.self_check ? [`WORKERS MAY RUN THEIR TASK'S CHECKS (worker.self_check): a worker may ask the engine to run its own task's \`checks\` argv exactly as written in the plan (nothing else, at most ${c.self_checks_max || 5} times per attempt); the engine runs them in the same sandbox and still re-runs them after the attempt. `
      + 'So give every task a fast check that exercises exactly that task\'s change (e.g. node --test on its own test file), because the worker uses it to fix its work before finishing.'] : []),
    ...(c.acceptance_first ? ['ACCEPTANCE TESTS FIRST (checks.acceptance_first): emit at least one task with "role":"acceptance" that ONLY writes test files (path_scope: test files/directories only) describing the goal\'s behaviour with concrete expected values, and no implementation. '
      + 'Its check must not require the new tests to pass yet (e.g. `node --check <file>`), because the code does not exist. EVERY other task must depend (directly or through other tasks) on an acceptance task. '
      + 'Write ONE acceptance test file PER FEATURE (e.g. test/<feature>.test.js), so that each implementation task\'s check runs ONLY its own feature\'s file (e.g. `node --test test/<feature>.test.js`): never give an implementation task a check that also runs the acceptance tests of another task\'s feature (they fail until that task is merged); the engine runs every acceptance test once all tasks are merged. '
      + 'Implementation tasks may READ the acceptance tests but their path_scope must never reach them: the engine rejects such a plan, fails any attempt that changes them, and re-runs them from their committed version at the end.'] : []),
    'TASK CHECKS JUDGE THE TASK\'S OWN SCOPE: a task\'s checks run while the other tasks\' work is NOT merged yet, so they must exercise only that task\'s change (e.g. the test runner on that task\'s OWN test files, a syntax check of its files). '
      + 'At most ONE task of the plan may carry a whole-suite check (normally the last, integration task); a plan with two or more is rejected. Do not give any other task a whole-suite check (a package test script, or a test runner without file arguments or with a directory/glob): it fails for reasons outside the task. The whole suite belongs in the goal\'s success criteria, which run once every task is merged. '
      + 'If a task does get a whole-suite check, the engine makes it depend on every other task that changes code (and shows that at approval).',
    'Produce tasks that are small (one concern, ideally < 200 changed lines), have disjoint path_scope where possible, start at the cheapest plausible tier, and each have at least one check from the allowed commands.',
    'Every task must create or change files within its path_scope. Do NOT add verification-only tasks (run the tests, check the output, review): the engine already runs each task\'s checks after the task and the goal\'s success-criteria checks at the end.',
    `OUTPUT SCHEMA: ${OUTPUT_SCHEMA}`,
    ...(replan ? [`YOUR PREVIOUS PLAN WAS REJECTED by the validator: ${replan.errors.slice(0, 8).join(' | ')}. Output a corrected plan that fixes exactly these and respects the HARD LIMITS above.`] : []),
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

const BAD_SCOPE_ROOTS = /^(\.git|\.claude|\.aos)(\/|$)/;
const BROAD = new Set(['**', '**/*', '*', '.', './', '/']);

export function validateScope(g) {
  if (typeof g !== 'string' || !g.trim()) return 'empty path_scope entry';
  if (path.isAbsolute(g) || g.startsWith('~')) return `path_scope "${g}" must be relative to the repo`;
  if (g.split('/').includes('..')) return `path_scope "${g}" escapes the repo`;
  if (BROAD.has(g)) return `path_scope "${g}" is too broad`;
  if (BAD_SCOPE_ROOTS.test(g.replace(/^\.\//, ''))) return `path_scope "${g}" targets protected files`;
  if (CTRL_RE.test(g)) return 'path_scope contains control characters';
  if (g.length > MAX_SCOPE_LEN) return `path_scope is longer than ${MAX_SCOPE_LEN} characters`;
  const p = globCompileProblem(g); if (p) return `path_scope "${g}" ${p}`;
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

export const UNSAFE_CHECK_CMDS = new Set(['sh', 'bash', 'zsh', 'fish', 'eval', 'exec', 'sudo', 'su', 'curl', 'wget', 'nc', 'ssh', 'scp', 'rsync', 'env', 'xargs', 'open', 'osascript']);

/**
 * Strict validation. opts: {max_tasks, check_allowlist, rules?, policy?}. `rules` is the goal's COMPILED rule set and `policy` its worker policy: with them the plan
 * must also respect plan.tiers, plan.max_start_tier, plan.scope_deny, checks.max_timeout_s, and allowed_commands are judged by the goal's own policy (G4; without
 * them the engine defaults apply). Returns {ok, errors[], tasks[] (normalised)}.
 */
export function validatePlan(plan, opts) {
  const errors = [];
  const bad = (m) => errors.push(escCtrl(m)); // an error text never carries raw control characters
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, errors: ['plan must be a JSON object'], tasks: [] };
  if (!Array.isArray(plan.tasks) || !plan.tasks.length) return { ok: false, errors: ['plan.tasks must be a non-empty array'], tasks: [] };
  if (plan.tasks.length > opts.max_tasks) bad(`plan has ${plan.tasks.length} tasks, max_tasks is ${opts.max_tasks}`);
  const R = opts.rules || null; const pol = opts.policy || DEFAULT_POLICY; const maxTimeout = R ? R.checks.max_timeout_s : 3600;
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
    // control / bidi / zero-width characters would rewrite the approval screen: refused in every plan string (a description or output_contract may still span lines)
    const ctrl = (v, what, multiline = false) => { if (typeof v === 'string' && CTRL_RE.test(multiline ? v.replace(/[\n\t]/g, ' ') : v)) bad(`${at}: ${what} contains control characters or bidi overrides`); };
    ctrl(t.title, 'title'); ctrl(t.description, 'description', true); ctrl(t.output_contract, 'output_contract', true);
    if (Array.isArray(t.acceptance)) t.acceptance.forEach((a, k) => ctrl(a, `acceptance[${k}]`));
    if (Array.isArray(t.depends_on)) t.depends_on.forEach((d, k) => ctrl(d, `depends_on[${k}]`));
    if (Array.isArray(t.allowed_commands)) t.allowed_commands.forEach((c, k) => ctrl(c, `allowed_commands[${k}]`));
    if (Array.isArray(t.checks)) t.checks.forEach((c, j) => { if (Array.isArray(c?.argv)) c.argv.forEach((a, k) => ctrl(a, `checks[${j}].argv[${k}]`)); });
    if (!Array.isArray(t.depends_on)) bad(`${at}: depends_on must be an array`);
    if (!TIERS.includes(t.model_tier)) bad(`${at}: model_tier must be one of ${TIERS.join('|')}`);
    else if (R && !R.plan.tiers.includes(t.model_tier)) bad(`${at}: model_tier ${t.model_tier} is not allowed by the rules (plan.tiers: ${R.plan.tiers.join(', ')})`);
    else if (R && TIERS.indexOf(t.model_tier) > TIERS.indexOf(R.plan.max_start_tier)) bad(`${at}: model_tier ${t.model_tier} is above plan.max_start_tier ${R.plan.max_start_tier}`);
    if (t.role !== undefined && t.role !== 'implementation' && t.role !== 'acceptance') bad(`${at}: role must be "implementation" or "acceptance"`);
    if (t.allow_skip !== undefined) {
      if (!Array.isArray(t.allow_skip) || t.allow_skip.length > 5 || t.allow_skip.some((r) => typeof r !== 'string' || !r.trim() || r.length > 200)) bad(`${at}: allow_skip must be 1-5 reason strings (at most 200 characters each)`);
      else t.allow_skip.forEach((r, k) => ctrl(r, `allow_skip[${k}]`));
    }
    if (!Array.isArray(t.acceptance) || !t.acceptance.length || t.acceptance.some((a) => typeof a !== 'string' || !a.trim())) bad(`${at}: acceptance needs at least one non-empty string`);
    if (!Array.isArray(t.path_scope) || !t.path_scope.length) bad(`${at}: path_scope must be a non-empty array`);
    else for (const g of t.path_scope) {
      const m = validateScope(g); if (m) { bad(`${at}: ${m}`); continue; }
      for (const d of R?.plan.scope_deny || []) if (scopeHitsDeny(g, d.glob)) bad(`${at}: path_scope "${g}" can reach "${d.glob}", which the rules deny (plan.scope_deny ${d.id}, layer ${d.layer})`);
    }
    const cmds = t.allowed_commands ?? [];
    if (!Array.isArray(cmds) || cmds.some((c) => typeof c !== 'string')) bad(`${at}: allowed_commands must be an array of strings`);
    else for (const c of cmds) {
      const prob = allowlistEntryProblem(c);
      if (prob) { bad(`${at}: allowed_commands entry "${c}" is dangerous or executes code and is rejected: ${prob}`); continue; }
      // the WORST of the engine default and the goal's own policy: a goal policy can add denies but must never make a plan-time check weaker than the default
      for (const p of pol === DEFAULT_POLICY ? [pol] : [DEFAULT_POLICY, pol]) {
        const v = evaluate(p, { tool_name: 'Bash', tool_input: { command: c }, cwd: '/w' }, { worktree: '/w', path_scope: [], allowed_tools: ['Bash'], allowed_commands: [c], grants: [] });
        if (v.decision === 'deny') { bad(`${at}: allowed_commands entry "${c}" is dangerous (${v.rule})`); break; }
      }
    }
    if (!Array.isArray(t.checks) || !t.checks.length) bad(`${at}: at least one check is required`);
    else for (const [j, c] of t.checks.entries()) {
      if (!c || !Array.isArray(c.argv) || !c.argv.length || c.argv.some((a) => typeof a !== 'string')) { bad(`${at}.checks[${j}]: argv must be a non-empty string array`); continue; }
      if (!(typeof c.timeout_s === 'number' && c.timeout_s > 0 && c.timeout_s <= maxTimeout)) bad(`${at}.checks[${j}]: timeout_s must be in (0, ${maxTimeout}]`);
      if (UNSAFE_CHECK_CMDS.has(path.basename(c.argv[0]))) bad(`${at}.checks[${j}]: ${c.argv[0]} is not allowed as a check`);
      else if (!commandAllowed(c.argv, opts.check_allowlist)) bad(`${at}.checks[${j}]: "${c.argv.join(' ')}" is not on the goal's check allowlist`);
      else if (argvProblem(c.argv)) bad(`${at}.checks[${j}]: ${argvProblem(c.argv)}`);
    }
    if (Array.isArray(t.depends_on) && typeof t.id === 'string') tasks.push(t);
  }
  // acceptance tests first (anti-cheat e): acceptance tasks only write test files; every other task depends on one and may not write what they write
  const acc = tasks.filter((t) => t.role === 'acceptance'); const impl = tasks.filter((t) => t.role !== 'acceptance');
  if (opts.acceptance_first && !acc.length) bad('checks.acceptance_first is on: the plan needs at least one task with "role":"acceptance" that writes the tests first');
  for (const a of acc) {
    for (const g of Array.isArray(a.path_scope) ? a.path_scope : []) if (typeof g === 'string' && !isTestPath(g)) bad(`${a.id}: an acceptance task may only write test files, but its path_scope "${g}" does not look like one (test/, tests/, __tests__/, *.test.*, *.spec.*)`);
    for (const d of Array.isArray(a.depends_on) ? a.depends_on : []) if (impl.some((x) => x.id === d)) bad(`${a.id}: an acceptance task must not depend on an implementation task ("${d}")`);
  }
  if (acc.length) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const reachesAcc = (t, seen = new Set()) => (Array.isArray(t.depends_on) ? t.depends_on : []).some((d) => { const x = byId.get(d); if (!x || seen.has(d)) return false; seen.add(d); return x.role === 'acceptance' || reachesAcc(x, seen); });
    for (const t of impl) {
      if (!reachesAcc(t)) bad(`${t.id}: with acceptance tests, every other task must depend on an acceptance task (${acc.map((a) => a.id).join(', ')})`);
      for (const g of Array.isArray(t.path_scope) ? t.path_scope : []) for (const a of acc) for (const ag of Array.isArray(a.path_scope) ? a.path_scope : []) if (typeof g === 'string' && typeof ag === 'string' && scopeHitsDeny(g, ag)) bad(`${t.id}: path_scope "${g}" can reach the acceptance tests of ${a.id} ("${ag}"), which are read-only for every other task`);
    }
  }
  for (const t of tasks) for (const d of t.depends_on) {
    if (typeof d !== 'string' || !ids.has(d)) bad(`${t.id}: depends_on "${d}" is not a task in the plan`);
    else if (d === t.id) bad(`${t.id}: depends on itself`);
  }
  if (!errors.length) { const cyc = findCycle(tasks); if (cyc.length) bad(`dependency cycle among: ${cyc.join(', ')}`); }
  const notes = errors.length ? [] : wholeSuiteDeps(tasks, bad);
  return { ok: errors.length === 0, errors, tasks: errors.length ? [] : tasks, notes: errors.length ? [] : notes };
}

const NODE_VALUE_FLAGS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--env-file', '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern', '--test-concurrency', '--test-timeout', '--test-shard']);
/**
 * A check that runs the WHOLE test suite instead of named files: `npm|pnpm|yarn test` / `run test` (the package script decides what runs), `make test|check`,
 * and `node --test` without a file argument or with a directory / glob argument.
 */
export function isWholeSuiteCheck(argv) {
  if (!Array.isArray(argv) || !argv.length) return false;
  const b = path.basename(String(argv[0])); const rest = argv.slice(1);
  if (['npm', 'pnpm', 'yarn'].includes(b)) return rest[0] === 'test' || rest[0] === 't' || (rest[0] === 'run' && rest[1] === 'test');
  if (b === 'make') return rest.some((a) => a === 'test' || a === 'check');
  if (b !== 'node' || !rest.includes('--test')) return false;
  const files = [];
  for (let i = 0; i < rest.length; i++) { const a = rest[i]; if (NODE_VALUE_FLAGS.has(a)) { i++; continue; } if (!a.startsWith('-')) files.push(a); }
  return !files.length || files.some((f) => /[*?{}[\]]/.test(f) || f.endsWith('/') || !/\.[A-Za-z0-9]+$/.test(path.basename(f)));
}
/** A path_scope that can only change documentation (no code, no tests, no configuration): such a task never changes what a test suite sees. */
export const docsOnlyScope = (scope) => Array.isArray(scope) && scope.length > 0 && scope.every((g) => typeof g === 'string' && (/\.(?:md|markdown|txt|rst|adoc)$/i.test(g) || /^(?:\.\/)?docs\//.test(g)));

/**
 * A task-level whole-suite check judges the work of EVERY task, so it can only pass once all of it is merged: such a task gets every other task that
 * changes code as a (transitive) dependency, added here and returned as a note for the approval screen. When that is impossible (one of those tasks
 * already runs after it) the plan is rejected with a clear error. Mutates `tasks` (entries are replaced by copies; the planner's plan object is not changed).
 */
function wholeSuiteDeps(tasks, bad) {
  const notes = [];
  const ancestors = (id) => { const byId = new Map(tasks.map((t) => [t.id, t])); const seen = new Set(); const st = [...(byId.get(id)?.depends_on || [])]; while (st.length) { const d = st.pop(); if (seen.has(d)) continue; seen.add(d); st.push(...(byId.get(d)?.depends_on || [])); } return seen; };
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const whole = (t.checks || []).filter((c) => isWholeSuiteCheck(c.argv)).map((c) => c.argv.join(' '));
    if (!whole.length) continue;
    const anc = ancestors(t.id);
    const missing = tasks.filter((x) => x.id !== t.id && !anc.has(x.id) && !docsOnlyScope(x.path_scope));
    const after = missing.filter((x) => ancestors(x.id).has(t.id));
    const otherWhole = tasks.filter((x) => x.id !== t.id && (x.checks || []).some((c) => isWholeSuiteCheck(c.argv)) && !docsOnlyScope(x.path_scope));
    if (otherWhole.length) { bad(`${t.id}: its check "${whole[0]}" runs the WHOLE test suite, and so does ${otherWhole.map((x) => x.id).join(', ')}: each would have to run after the other's work is merged, which is impossible. At most ONE task may carry a whole-suite check (normally the last, integration task); give the others a check on their own test files`); continue; }
    if (after.length) { bad(`${t.id}: its check "${whole[0]}" runs the WHOLE test suite, so it can only pass after every other task that changes code is merged, but ${after.map((x) => x.id).join(', ')} run(s) after ${t.id}. Give ${t.id} a check on its own test files instead (e.g. node --test <its test file>); the whole suite belongs in the goal's success criteria`); continue; }
    if (!missing.length) continue;
    tasks[i] = { ...t, depends_on: [...t.depends_on, ...missing.map((x) => x.id)] };
    notes.push({ task: t.id, added: missing.map((x) => x.id), text: `WHOLE-SUITE CHECK: "${whole[0]}" runs every test, which fails while other tasks' work is not merged, so the engine made this task also wait for ${missing.map((x) => x.id).join(', ')} (dependencies added to the plan). To let it run earlier, give it a check on its own test files instead.` });
  }
  return notes;
}

/** Build AOS-1 task objects (+ orch extension, design section 3) from a validated plan. */
export function toTasks(planTasks, goal, nowMs, ladder = TIERS) {
  const ts = iso(nowMs);
  const B = goal.orch.budgets;
  return planTasks.map((t) => ({
    id: t.id, goal_id: goal.id, title: t.title, assignee: `worker-${t.id}`, status: 'pending', depends_on: [...t.depends_on],
    attempts: 0, max_attempts: B.max_attempts, output_contract: t.output_contract, acceptance: [...t.acceptance], artifacts: [],
    created_at: ts, updated_at: ts,
    orch: {
      description: t.description, model_tier: t.model_tier, tier_ladder: [...ladder], path_scope: [...t.path_scope], read_scope: ['**'],
      allowed_tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'], allowed_commands: [...(t.allowed_commands || [])],
      checks: t.checks.map((c) => ({ argv: [...c.argv], timeout_s: c.timeout_s })), branch: `aos/${goal.id}/${t.id}`, worktree: null,
      ...(t.role === 'acceptance' ? { role: 'acceptance' } : {}), ...(Array.isArray(t.allow_skip) && t.allow_skip.length ? { allow_skip: [...t.allow_skip] } : {}),
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
/** The text a human wrote for the goal (title, description, criteria and their check commands): what "mentioned in the prompt" is judged against. */
export const goalPromptText = (goal) => [goal.title, goal.description, ...(goal.success_criteria || []).flatMap((c) => [c.text, ...(Array.isArray(c.check?.argv) ? c.check.argv : [])])].filter((x) => typeof x === 'string').join('\n').toLowerCase();
/** Heuristic, informational: path_scope globs none of whose literal pieces (3+ characters, wildcards removed) appear in the goal text. {beyond_prompt, beyond_paths}. */
export function beyondPrompt(scope, text) {
  const beyond = (scope || []).filter((g) => {
    const pieces = String(g).split(/[/*?{}[\]!,]+/).filter((x) => x.length >= 3);
    return !pieces.some((x) => text.includes(x.toLowerCase()));
  });
  return { beyond_prompt: beyond.length > 0, beyond_paths: beyond };
}
/** What a human reviews, per task, in plain text: tier, path scope, allowed commands and the exact check commands. */
export function reviewView(tasks, goal = null) {
  const text = goal ? goalPromptText(goal) : null;
  const W = goal?.orch?.plan_warnings || {};
  const view = tasks.map((t) => { const o = t.orch || t; return { ...(text === null ? {} : beyondPrompt(o.path_scope, text)), ...(W[t.id]?.length ? { warnings: [...W[t.id]] } : {}), id: t.id, ...(o.role === 'acceptance' ? { role: 'acceptance' } : {}), ...(o.allow_skip?.length ? { allow_skip: [...o.allow_skip] } : {}), title: t.title ?? '', description: o.description ?? '', output_contract: t.output_contract ?? '', acceptance: [...(t.acceptance || [])], model_tier: o.model_tier, path_scope: [...o.path_scope], depends_on: [...(t.depends_on || [])],
    allowed_commands: [...(o.allowed_commands || [])], checks: (o.checks || []).map((c) => ({ command: c.argv.join(' '), argv: c.argv, timeout_s: c.timeout_s })) }; });
  view.goal_warnings = [...(W.goal || [])]; // not serialised with the array: renderReview prints them
  return view;
}
/** Hash of everything the approval covers in the engine's tasks (tier excluded: the retry ladder escalates it legitimately). */
export function tasksHash(tasks, v = 1) {
  return sha256(canonical(tasks.map((t) => { const o = t.orch || t; return { id: t.id, depends_on: t.depends_on || [], path_scope: o.path_scope, allowed_commands: o.allowed_commands || [],
    allowed_tools: o.allowed_tools || null, ...(o.role === 'acceptance' ? { role: 'acceptance' } : {}), ...(o.allow_skip?.length ? { allow_skip: o.allow_skip } : {}), checks: (o.checks || []).map((c) => ({ argv: c.argv, timeout_s: c.timeout_s })),
    // v2: the text that reaches the worker prompt is covered too (a tasks.json edit of the description or the done-criteria is a plan change). v1 (goals approved before) omits it.
    ...(v >= 2 ? { title: t.title ?? null, description: o.description ?? null, output_contract: t.output_contract ?? null, acceptance: t.acceptance || [] } : {}) }; })));
}
/** The tasks-hash version of a goal: 2 once the engine created its plan with v2 (goal.orch.tasks_hash_v), 1 for a goal whose plan predates v2 (its approval must keep verifying). */
export const tasksHashV = (goal) => { const o = goal?.orch || {}; const fp = o.plan_fingerprint || o.plan_approval; return fp ? (fp.tasks_hash_v || 1) : (o.tasks_hash_v || 1); };
export const tasksHashFor = (goal, tasks) => tasksHash(tasks, tasksHashV(goal));
/** Plain-text rendering of reviewView for `status` / `approvals` / `plan`. `rulesText` (rules-store renderRulesFor) is printed after the tasks, next to the rules hash; `selfCheck`: the goal's rules turn worker.self_check on. */
export function renderReview(view, rulesText, { selfCheck = false } = {}) {
  const L = [];
  const e = escCtrl; const arg = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : e(JSON.stringify(String(a))));
  for (const w of view.goal_warnings || []) L.push(`!! WARNING: ${e(w)}`);
  for (const t of view) {
    for (const w of t.warnings || []) L.push(`!! WARNING (task ${e(t.id)}): ${e(w)}`);
    L.push(`task ${e(t.id)}  tier=${e(t.model_tier)}  scope=${t.path_scope.map(e).join(', ')}${t.depends_on.length ? `  after=${t.depends_on.map(e).join(',')}` : ''}`);
    const block = (label, text) => { const ls = String(text ?? '').slice(0, 2000).split('\n'); ls.forEach((ln, i) => L.push(i ? `    ${ln}` : `  ${label}: ${ln}`)); }; // what the worker is told (covered by the tasks hash)
    if (t.role === 'acceptance') L.push('  ACCEPTANCE TASK: writes the tests first; every other task gets these test files read-only and the engine re-runs them from their committed version at verify');
    if (t.allow_skip?.length) L.push(`  !! ALLOW_SKIP: this task may add skipped/todo tests (the anti-cheat check would otherwise fail it). Reason(s): ${t.allow_skip.map(e).join(' | ')}`);
    if (t.beyond_prompt) L.push(`  BEYOND THE PROMPT (heuristic, informational): scope ${t.beyond_paths.map(e).join(', ')} is not mentioned in the goal text; check it is intended`);
    if (t.title) block('title', t.title);
    if (t.description) block('description', t.description);
    if (t.output_contract) block('output contract', t.output_contract);
    if ((t.acceptance || []).length) block('acceptance', t.acceptance.join(' | '));
    const sc = selfCheck && t.checks.length ? 'self-check: may run its approved checks via the engine' : null; // worker.self_check: the engine runs them, sandboxed
    L.push(`  worker commands: ${t.allowed_commands.length ? `${t.allowed_commands.map(e).join(' | ')}${sc ? `; ${sc}` : ''}` : sc ? `(none; read-only inspection; ${sc})` : '(none; read-only inspection only)'}`);
    for (const c of t.checks) L.push(`  check (sandboxed, ${e(c.timeout_s)}s): ${c.argv.map(arg).join(' ')}`);
  }
  if (rulesText) L.push(...String(rulesText).split('\n'));
  return L.map(e).join('\n');
}
