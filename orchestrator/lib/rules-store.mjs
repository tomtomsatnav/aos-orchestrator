// The file-system side of the rule set (docs/rules-design.md R5-R6): reads the user layer and the repo layer, assembles the layers for compileRules,
// and builds the summary the approval screens show. rules.mjs stays pure.
import fs from 'node:fs';
import path from 'node:path';
import { evaluate } from './policy.mjs';
import { escCtrl } from './ctrl.mjs';
import { DEFAULT_RULES, valueAt, validateRules, policyToRules, goalLegacyRules, compileRules, buildRulesSnapshot, snapshotHash, summarizeRules, renderRulesSummary } from './rules.mjs';
import { sha256, canonical } from './plan.mjs';
import { readJSON, paths } from './state.mjs';
import { worktreeRootFor } from './git.mjs';
import { realpathDeepest } from './policy-hook.mjs';

export const MAX_RULES_FILE = 64 * 1024;
export const REPO_RULES_PATH = '.aos/rules.json';
export const REPO_RULES_FILE = 'repo-rules.json'; // the repo layer as read from base_commit at createGoal, in the goal dir

function parseRulesText(text, what) {
  if (Buffer.byteLength(text) > MAX_RULES_FILE) return { error: `${what} is larger than ${MAX_RULES_FILE} bytes` };
  try { return { value: JSON.parse(text) }; } catch (e) { return { error: `${what} is not valid JSON (${e.message.slice(0, 80)})` }; }
}

/**
 * The user layer: $AOS_ORCH_DIR/rules.json, or (legacy alias) the policy file the goal names (default policy.default.json) mapped by policyToRules.
 * Returns {layer?, errors[]}. No file = no layer.
 */
export function readUserLayer(orchDir, policyName = 'policy.default.json') {
  const rf = path.join(orchDir, 'rules.json');
  if (fs.existsSync(rf)) {
    let text; try { text = fs.readFileSync(rf, 'utf8'); } catch (e) { return { errors: [`rules.json unreadable: ${e.code || e.message}`] }; }
    const p = parseRulesText(text, 'rules.json'); if (p.error) return { errors: [p.error] };
    const v = validateRules(p.value, { layer: 'user' }); if (!v.ok) return { errors: v.errors.map((e) => `rules.json: ${e}`) };
    return { layer: { layer: 'user', rules: p.value, source: 'rules.json' }, errors: [] };
  }
  if (typeof policyName !== 'string' || !/^[A-Za-z0-9][\w.-]{0,80}$/.test(policyName) || policyName.includes('..')) return { errors: [`policy file name "${String(policyName).slice(0, 40)}" is not a plain file name`] };
  const pf = path.join(orchDir, policyName);
  if (!fs.existsSync(pf)) return { errors: [] };
  let text; try { text = fs.readFileSync(pf, 'utf8'); } catch (e) { return { errors: [`${policyName} unreadable: ${e.code || e.message}`] }; }
  const p = parseRulesText(text, policyName); if (p.error) return { errors: [p.error] };
  const m = policyToRules(p.value);
  const v = validateRules(m.rules, { layer: 'user' }); if (!v.ok) return { errors: v.errors.map((e) => `${policyName}: ${e}`) };
  return { layer: { layer: 'user', rules: m.rules, source: policyName, notes: m.notes }, errors: [] };
}

/** Parse + validate the repo's `.aos/rules.json` bytes (from `git show <base_commit>:.aos/rules.json`). {rules?, sha256?, errors[]} */
export function parseRepoRules(buf) {
  if (!buf) return { errors: [] };
  const p = parseRulesText(buf.toString('utf8'), REPO_RULES_PATH); if (p.error) return { errors: [p.error] };
  const v = validateRules(p.value, { layer: 'repo' }); if (!v.ok) return { errors: v.errors.map((e) => `${REPO_RULES_PATH}: ${e}`) };
  return { rules: p.value, sha256: sha256(canonical(p.value)), errors: [] };
}

const setDeep = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((x, k) => (x[k] ??= {}), o)[last] = v; };
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const deepMerge = (a, b) => { const out = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v; return out; };

/** Assemble every layer of a goal, in order: user, repo, goal (legacy fields, legacy policy override, the spec's orch.rules). {layers, errors[]} */
export function collectLayers({ orchDir, goal, dir, repo = null }) {
  const o = goal.orch; const layers = []; const errors = [];
  const u = readUserLayer(orchDir, typeof o.policy === 'string' ? o.policy : 'policy.default.json');
  errors.push(...u.errors); if (u.layer) layers.push(u.layer);
  if (repo) layers.push({ layer: 'repo', rules: repo, source: `${REPO_RULES_PATH}@${String(o.base_commit || '').slice(0, 12)}` });
  else if (o.repo_rules) {
    const f = path.join(dir, REPO_RULES_FILE); const r = readJSON(f, null);
    if (!r || sha256(canonical(r)) !== o.repo_rules.sha256) errors.push(`${REPO_RULES_FILE} of this goal is missing or was modified`);
    else layers.push({ layer: 'repo', rules: r, source: `${REPO_RULES_PATH}@${String(o.base_commit || '').slice(0, 12)}` });
  }
  // ONE goal layer: the legacy fields, then the legacy policy override, then the spec's orch.rules, each overriding the previous per key (lists are replaced)
  const legacy = goalLegacyRules(goal);
  let rules = legacy.rules;
  if (legacy.caps.length) { // explicit limits equal to the default: a cap on whatever the lower layers allow (it must not raise a tighter user/repo value)
    const below = compileRules(layers, { accept: o.accept_repo_loosening || [] });
    for (const [p, v] of legacy.caps) { const cur = below.ok ? valueAt(below.compiled, p) : undefined; if (cur === undefined || v < cur) setDeep(rules, p, v); }
  }
  if (legacy.denyUnknown) { // approval_policy.outside_allowlist "deny": drop unknown_command from whatever ask_on the lower layers left (never adds an entry back)
    const below = compileRules(layers, { accept: o.accept_repo_loosening || [] });
    setDeep(rules, 'worker.bash.ask_on', (below.ok ? below.compiled : DEFAULT_RULES).worker.bash.ask_on.filter((x) => x !== 'unknown_command'));
  } const notes = [...legacy.notes]; const sources = ['goal.json'];
  if (o.policy && typeof o.policy === 'object' && !Array.isArray(o.policy)) { const m = policyToRules(o.policy); rules = deepMerge(rules, m.rules); notes.push(...m.notes); sources.push('goal.orch.policy'); }
  if (o.rules_layer) { rules = deepMerge(rules, o.rules_layer); sources.push('goal.orch.rules'); }
  layers.push({ layer: 'goal', rules, source: sources.join('+'), notes });
  return { layers, errors };
}

/** What the layers of a goal being CREATED would compile to (no snapshot, no files written): {ok, comp} or {ok:false, errors[]}. */
export function previewGoal({ orchDir, goal, repo = null }) {
  const { layers, errors } = collectLayers({ orchDir, goal, dir: null, repo });
  if (errors.length) return { ok: false, errors };
  const comp = compileRules(layers, { accept: goal.orch.accept_repo_loosening || [] });
  return comp.ok ? { ok: true, comp } : { ok: false, errors: comp.errors };
}

/** Compile the layers of a goal into a snapshot. {ok, snap, comp, layers} or {ok:false, errors[]} (an invalid layer refuses the goal). */
export function compileGoal({ orchDir, goal, dir, accept = goal.orch.accept_repo_loosening || [] }) {
  const { layers, errors } = collectLayers({ orchDir, goal, dir });
  if (errors.length) return { ok: false, errors };
  const comp = compileRules(layers, { accept });
  if (!comp.ok) return { ok: false, errors: comp.errors };
  return { ok: true, comp, layers, snap: buildRulesSnapshot(comp, layers) };
}

/**
 * Recompile from the layers stored in a snapshot (a human accepted loosenings): never re-reads files. The stored inputs must match the layer hashes recorded in
 * the snapshot AND, when `goal` is given, the ones goal.json recorded (goal.orch.rules.layers, goal.orch.repo_rules.sha256): a rewritten snapshot cannot smuggle rules in.
 */
export function recompileSnapshot(snap, accept, goal = null) {
  const stored = (snap.layers || []).filter((l) => l.layer !== 'default');
  const inputs = snap.inputs || [];
  const mismatch = { ok: false, errors: ['stored rule layers do not match their recorded hashes'] };
  if (inputs.length !== stored.length || inputs.some((x, i) => x.layer !== stored[i].layer || sha256(canonical(x.rules)) !== stored[i].sha256)) return mismatch;
  if (goal) {
    const rec = (goal.orch?.rules?.layers || []).filter((l) => l.layer !== 'default');
    if (rec.length !== inputs.length || inputs.some((x, i) => rec[i].layer !== x.layer || !rec[i].sha12 || !sha256(canonical(x.rules)).startsWith(rec[i].sha12))) return mismatch;
    const rr = goal.orch?.repo_rules; const ri = inputs.find((x) => x.layer === 'repo');
    if ((rr && (!ri || sha256(canonical(ri.rules)) !== rr.sha256)) || (!rr && ri)) return mismatch;
  }
  const layers = inputs.map((x) => ({ layer: x.layer, rules: x.rules, source: x.source }));
  const comp = compileRules(layers, { accept });
  if (!comp.ok) return { ok: false, errors: comp.errors };
  const next = buildRulesSnapshot(comp, layers); next.notes = snap.notes || [];
  next.rules_hash = snapshotHash(next);
  return { ok: true, comp, snap: next };
}

/** The summary for the approval screens: from the snapshot on disk, only if it still hashes to what goal.json recorded (else {tampered:true}). null before the first snapshot. */
export function readRulesSummary(dir, goal) {
  const o = goal?.orch; if (!o?.rules) return null;
  const snap = readJSON(paths(dir).rules, null);
  if (!snap || snapshotHash(snap) !== o.rules.sha256) return { tampered: true, rules_hash: String(o.rules.sha256 || '').slice(0, 12) };
  return summarizeRules(snap, goal);
}

/** The summary as text for the CLI approval screens (also says so when the snapshot is tampered or not taken yet). */
export function renderRulesFor(dir, goal) {
  const sm = readRulesSummary(dir, goal);
  if (!sm) return 'rules: not snapshotted yet (the engine compiles them when it first loads the goal)';
  return sm.tampered ? `RULES TAMPERED: the rules snapshot no longer matches goal.json (${sm.rules_hash}); do not approve` : renderRulesSummary(sm);
}

// ---------------------------------------------------------------- R10: `aos-orch rules ...`
/** `rules show` without a goal: the default rules overlaid with the user layer ($AOS_ORCH_DIR/rules.json or the legacy policy file), as the approval screens print them. */
export function renderUserRules(orchDir) {
  const u = readUserLayer(orchDir);
  if (u.errors.length) return { ok: false, text: `user rules are INVALID: ${u.errors.slice(0, 5).map(escCtrl).join('; ')}` };
  const layers = u.layer ? [u.layer] : [];
  const comp = compileRules(layers);
  if (!comp.ok) return { ok: false, text: `user rules are INVALID: ${comp.errors.slice(0, 5).map(escCtrl).join('; ')}` };
  return { ok: true, text: renderRulesSummary(summarizeRules(buildRulesSnapshot(comp, layers))) };
}

/** `rules check <file>`: validate a rules file as a layer and show what it would change. {ok, errors[], text} */
export function checkRulesFile(file, layer = 'user') {
  if (!['user', 'repo', 'goal'].includes(layer)) return { ok: false, errors: [`--layer must be user, repo or goal`], text: '' };
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, errors: [`cannot read ${escCtrl(file)}: ${e.code || e.message}`], text: '' }; }
  const p = parseRulesText(text, 'file'); if (p.error) return { ok: false, errors: [p.error], text: '' };
  // a whole goal file (what `aos-orch draft` writes) is accepted for --layer goal: its rules layer is `orch.rules`
  const looksLikeGoal = !!p.value && typeof p.value === 'object' && !Array.isArray(p.value) && p.value.rules_version === undefined && Array.isArray(p.value.success_criteria);
  let note = '';
  if (looksLikeGoal) {
    if (layer !== 'goal') return { ok: false, errors: ['this file is a goal file, not a rules file: check it with --layer goal (its rules layer is orch.rules)'], text: '' };
    const r = p.value.orch?.rules;
    if (r === undefined) return { ok: false, errors: ['this goal file has no orch.rules, so it adds no goal-layer rules (nothing to check; the profile "strict" has none)'], text: '' };
    p.value = r; note = 'checking orch.rules of the goal file as the goal layer\n';
  }
  const v = validateRules(p.value, { layer }); if (!v.ok) return { ok: false, errors: v.errors, text: '' };
  const comp = compileRules([{ layer, rules: p.value, source: 'file' }]);
  if (!comp.ok) return { ok: false, errors: comp.errors, text: '' };
  const sm = summarizeRules(buildRulesSnapshot(comp, [{ layer, rules: p.value, source: 'file' }]));
  return { ok: true, errors: [], text: `${note}OK as a ${layer} layer (${sm.rules_hash} when applied alone over the defaults)\n${renderRulesSummary(sm)}` };
}

/**
 * `rules explain <goal> <task> '<tool json>'`: a dry run of the policy hook's evaluate() against the goal's snapshot and the task's scope and grants.
 * Pure: nothing is written, no approval is created. {ok:false, error} or {ok:true, decision, reason, rule, rule_id, layer, rules_hash}.
 */
export function explainCall(dir, goal, taskId, callText) {
  const o = goal.orch;
  const snap = readJSON(paths(dir).rules, null);
  if (!o.rules || !snap || snapshotHash(snap) !== o.rules.sha256 || !snap.policy) return { ok: false, error: 'the goal has no intact rules snapshot (not started yet, or tampered)' };
  const task = readJSON(paths(dir).tasks, []).find((t) => t.id === taskId);
  if (!task) return { ok: false, error: `no such task: ${escCtrl(String(taskId)).slice(0, 60)}` };
  let call; try { call = JSON.parse(callText); } catch (e) { return { ok: false, error: `tool json does not parse: ${e.message.slice(0, 80)}` }; }
  if (!call || typeof call !== 'object' || typeof call.tool_name !== 'string' || (call.tool_input !== undefined && (typeof call.tool_input !== 'object' || !call.tool_input))) return { ok: false, error: 'expected {"tool_name": "...", "tool_input": {...}, "cwd"?: "..."}' };
  const wt = path.join(o.worktree_root || worktreeRootFor(o.repo, goal.id), task.id); // where the engine will (or did) put the task's worktree
  const worktree = realpathDeepest(wt);
  const ctx = { worktree, path_scope: task.orch.path_scope, allowed_tools: task.orch.allowed_tools, allowed_commands: task.orch.allowed_commands, grants: task.orch.grants || [], home: process.env.HOME, base_branch: o.base_branch };
  const r = evaluate(snap.policy, { tool_name: call.tool_name, tool_input: call.tool_input || {}, cwd: typeof call.cwd === 'string' ? call.cwd : worktree }, ctx);
  return { ok: true, decision: r.decision, reason: r.reason, rule: r.rule, rule_id: r.rule_id, layer: r.layer, rules_hash: snapshotHash(snap).slice(0, 12), worktree };
}
