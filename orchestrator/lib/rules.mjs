// Declarative rule set (docs/rules-design.md sections 2-4). PURE: no fs, no clock, no env.
//   DEFAULT_RULES            today's behaviour, as data
//   validateRules(rules)     schema + domain checks -> {ok, errors[]}
//   compileRules(layers)     merge layers (a lower layer may only TIGHTEN) -> {ok, compiled, loosenings, dropped, hash, layers}
//   toPolicy(compiled)       the worker policy object policy.mjs evaluates (DEFAULT_RULES -> DEFAULT_POLICY exactly)
import { validateSchema } from './schema.mjs';
import { allowlistEntryProblem } from './policy.mjs';
import { canonical, sha256, UNSAFE_CHECK_CMDS } from './plan.mjs';

export const RULES_VERSION = 1;

const g = (id, glob) => ({ id, glob });
const c = (id, cmd) => ({ id, cmd });
export const DEFAULT_RULES = Object.freeze({
  rules_version: 1, profile: 'strict',
  description: 'Engine default. Workers inspect read-only; all verification is sandboxed engine checks.',
  worker: {
    tools: { allow: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] },
    paths: {
      deny: [g('home.claude', '~/.claude/**'), g('home.ssh', '~/.ssh/**'), g('home.config', '~/.config/**'), g('git.dir', '**/.git/**'), g('git.file', '**/.git'),
        g('claude.settings', '**/.claude/settings*.json')],
      read_extra: [], on_outside_scope: 'ask',
    },
    bash: {
      allow: [c('ls', 'ls'), c('cat', 'cat'), c('head', 'head'), c('tail', 'tail'), c('wc', 'wc'), c('grep', 'grep'), c('rg', 'rg'), c('find-name', 'find -name'), c('diff', 'diff'),
        c('git-status', 'git status'), c('git-diff', 'git diff'), c('git-log', 'git log'), c('git-show', 'git show')],
      deny: [c('git-push', 'git push'), c('git-remote', 'git remote'), c('git-config', 'git config'), c('git-reset-hard', 'git reset --hard'), c('sudo', 'sudo'), c('curl', 'curl'),
        c('wget', 'wget'), c('nc', 'nc'), c('ssh', 'ssh'), c('scp', 'scp'), c('rsync', 'rsync'), c('npm-install', 'npm install'), c('pip-install', 'pip install'), c('brew', 'brew'),
        c('eval', 'eval'), c('exec', 'exec')],
      deny_patterns: [{ id: 'pipe-into-interpreter', regex: '\\|\\s*(sh|bash|zsh|python3?|node|perl)\\b' }, { id: 'rm-r-root', regex: 'rm\\s+-(?=[a-z]*r)[a-z]*\\s+(/|~|\\.\\.)' }],
      ask_on: ['substitution', 'unparsed', 'unknown_command'],
    },
    approval: { wait_in_hook_s: 20, ttl_s: 86400, grant_scopes: ['once', 'task'] },
    sandbox: 'off',
  },
  plan: { approval: 'required', planner_tier: 'opus', planner_timeout_s: 300, draft_tier: 'haiku', max_tasks: 12, tiers: ['haiku', 'sonnet', 'opus'], max_start_tier: 'opus', scope_deny: [],
    auto_approvable_checks: [c('grep', 'grep'), c('test', 'test'), c('diff', 'diff'), c('cmp', 'cmp')] },
  checks: { allowlist: [], max_timeout_s: 3600, sandbox: 'required', localhost_ports: [] },
  retry: { max_attempts: 3, ladder: ['haiku', 'sonnet', 'opus'], same_tier_retries: { denied: 1 }, no_escalate: ['merge_conflict', 'plan_tampered', 'repo_instructions_changed'], uncertain_limit_max: 2 },
  budgets: { max_new_tokens: 2000000, max_wall_clock_s: 7200, max_ticks: 500, max_usd: 5, attempt_usd_cap: 2, task_wall_clock_s: 900, stall_after_s: 300, max_turns: 30,
    soft_frac: 0.8, hard_grace_s: 60, draft_usd_cap: 0.1 },
  governor: { reserve_5h: 0.8, hold_7d: 0.9, jitter_s: 60, backoff_min: [15, 30, 60, 240], overload_backoff_s: [30, 60, 120, 300] },
  parallel: { max_parallel: 3, overlapping_scopes: 'serialize', soft_budget_blocks_tier: 'opus' },
  merge: { strategy: 'no-ff', on_conflict: 'retry_counted' },
  done: { criteria_when: 'all_tasks_done', on_unmet: 'block' },
  ask_human: { on_pending_approval: 'needs_review', on_7d_hold: 'manual_resume', on_budget_hard: 'block', on_plan_with_commands: 'required', on_human_criterion: 'wait' },
  repo_config: { trust: false },
});

// ---------------------------------------------------------------- schema
const TIER = ['haiku', 'sonnet', 'opus'];
const obj = (properties, extra = {}) => ({ type: 'object', additionalProperties: false, properties, ...extra });
const str = (maxLength = 200) => ({ type: 'string', maxLength });
const int = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const num = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const ID = { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,47}$' };
const list = (items, maxItems = 128) => ({ type: 'array', maxItems, items });
const enums = (...e) => ({ enum: e });
const entry = (field) => ({ type: 'array', maxItems: 128, items: obj({ id: ID, [field]: str(200), description: str(500) }, { required: ['id', field] }) });
const cmdRules = entry('cmd'); const globRules = entry('glob');

export const RULES_SCHEMA = obj({
  rules_version: enums(RULES_VERSION), profile: enums('strict', 'node-library', 'docs-only'), description: str(500),
  worker: obj({
    tools: obj({ allow: list(str(40), 32) }),
    paths: obj({ deny: globRules, read_extra: globRules, on_outside_scope: enums('ask', 'deny') }),
    bash: obj({ allow: cmdRules, deny: cmdRules, deny_patterns: entry('regex'), ask_on: list(enums('substitution', 'unparsed', 'unknown_command'), 8) }),
    approval: obj({ wait_in_hook_s: int(0, 25), ttl_s: int(60, 604800), grant_scopes: list(enums('once', 'task'), 2) }),
    sandbox: enums('off', 'required'),
  }),
  plan: obj({ approval: enums('required', 'auto'), planner_tier: enums(...TIER), draft_tier: enums('haiku', 'sonnet'), planner_timeout_s: int(1, 1800), max_tasks: int(1, 50),
    tiers: list(enums(...TIER), 3), max_start_tier: enums(...TIER), scope_deny: globRules, auto_approvable_checks: cmdRules }),
  checks: obj({ allowlist: cmdRules, max_timeout_s: int(1, 3600), sandbox: enums('required', 'off'), localhost_ports: list(int(1, 65535), 16) }),
  retry: obj({ max_attempts: int(1, 10), ladder: list(enums(...TIER), 3), same_tier_retries: { type: 'object' }, no_escalate: list(str(48), 32), uncertain_limit_max: int(1, 5) }),
  budgets: obj({ max_new_tokens: int(1, 1e10), max_wall_clock_s: int(1, 31536000), max_ticks: int(1, 1e7), max_usd: num(0, 10000), attempt_usd_cap: num(0, 10000), task_wall_clock_s: int(1, 86400),
    stall_after_s: int(1, 86400), max_turns: int(1, 1000), soft_frac: num(0, 1), hard_grace_s: int(0, 3600), draft_usd_cap: num(0, 100) }),
  governor: obj({ reserve_5h: num(0, 1), hold_7d: num(0, 1), jitter_s: int(0, 3600), backoff_min: list(num(0, 100000), 16), overload_backoff_s: list(num(0, 100000), 16) }),
  parallel: obj({ max_parallel: int(1, 16), overlapping_scopes: enums('serialize'), soft_budget_blocks_tier: enums('opus', 'none') }),
  merge: obj({ strategy: enums('no-ff'), on_conflict: enums('retry_counted', 'fail') }),
  done: obj({ criteria_when: enums('all_tasks_done'), on_unmet: enums('block') }),
  ask_human: obj({ on_pending_approval: enums('needs_review'), on_7d_hold: enums('manual_resume'), on_budget_hard: enums('block'), on_plan_with_commands: enums('required'), on_human_criterion: enums('wait') }),
  repo_config: obj({ trust: { type: 'boolean' } }),
}, { required: ['rules_version'] });

const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;
const dup = (arr, key) => { const seen = new Set(); for (const e of arr) { if (seen.has(e.id)) return e.id; seen.add(e.id); } return null; };
const at = (p, i, f) => `$.${p}[${i}].${f}`;

/** Schema check, then domain checks. layer 'user'|'repo'|'goal' (governor is accepted in the user layer only). Never throws. */
export function validateRules(rules, { layer = 'user' } = {}) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return { ok: false, errors: ['$: rules must be an object'] };
  if (rules.rules_version !== RULES_VERSION) return { ok: false, errors: [`$.rules_version: unsupported version ${JSON.stringify(rules.rules_version)} (only ${RULES_VERSION} is understood)`] };
  const errors = validateSchema(rules, RULES_SCHEMA);
  if (errors.length) return { ok: false, errors };
  const bad = (m) => errors.push(m);
  if (rules.governor && layer !== 'user') bad(`$.governor: only the user layer may set the governor (layer is ${layer})`);
  for (const p of ['worker.paths.deny', 'worker.paths.read_extra', 'worker.bash.allow', 'worker.bash.deny', 'worker.bash.deny_patterns', 'plan.scope_deny', 'plan.auto_approvable_checks', 'checks.allowlist']) {
    const a = getPath(rules, p); if (!a) continue;
    const d = dup(a); if (d) bad(`$.${p}: duplicate id "${d}"`);
  }
  (rules.worker?.paths?.deny || []).forEach((e, i) => globProblem(e.glob, at('worker.paths.deny', i, 'glob'), bad));
  (rules.worker?.paths?.read_extra || []).forEach((e, i) => globProblem(e.glob, at('worker.paths.read_extra', i, 'glob'), bad));
  (rules.plan?.scope_deny || []).forEach((e, i) => globProblem(e.glob, at('plan.scope_deny', i, 'glob'), bad));
  (rules.worker?.bash?.allow || []).forEach((e, i) => { const w = allowlistEntryProblem(e.cmd); if (w) bad(`${at('worker.bash.allow', i, 'cmd')}: ${w}`); });
  (rules.checks?.allowlist || []).forEach((e, i) => {
    const first = String(e.cmd).trim().split(/\s+/)[0] || '';
    if (!first) bad(`${at('checks.allowlist', i, 'cmd')}: empty command`);
    else if (UNSAFE_CHECK_CMDS.has(first.split('/').pop())) bad(`${at('checks.allowlist', i, 'cmd')}: ${first} is not allowed as a check`);
  });
  (rules.worker?.bash?.deny_patterns || []).forEach((e, i) => {
    const w = at('worker.bash.deny_patterns', i, 'regex');
    try { new RegExp(e.regex); } catch (x) { bad(`${w}: does not compile (${x.message})`); return; }
    if (NESTED_QUANTIFIER.test(e.regex)) bad(`${w}: nested quantifier (ReDoS risk)`);
  });
  for (const [k, v] of Object.entries(rules.retry?.same_tier_retries || {})) if (!Number.isInteger(v) || v < 0 || v > 5) bad(`$.retry.same_tier_retries.${k}: must be an integer 0-5`);
  if (rules.budgets?.soft_frac !== undefined && rules.budgets.soft_frac <= 0) bad('$.budgets.soft_frac: must be > 0');
  return { ok: errors.length === 0, errors };
}

function globProblem(glob, where, bad) {
  if (/[\0\n]/.test(glob)) bad(`${where}: contains control characters`);
  else if (glob.startsWith('/') ) bad(`${where}: must be relative or start with ~/`);
  else if (glob.startsWith('~') && !glob.startsWith('~/')) bad(`${where}: must be relative or start with ~/`);
}

// ---------------------------------------------------------------- merge
const getPath = (o, p) => p.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((x, k) => (x[k] ??= {}), o)[last] = v; }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// kind per path (docs/rules-design.md 2.2). entry lists are identified by their `key` field.
const SPEC = [
  ['worker.paths.read_extra', 'set', 'glob'], ['worker.bash.allow', 'set', 'cmd'], ['plan.auto_approvable_checks', 'set', 'cmd'], ['checks.allowlist', 'set', 'cmd'],
  ['worker.tools.allow', 'set'], ['worker.bash.ask_on', 'set'], ['worker.approval.grant_scopes', 'set'], ['plan.tiers', 'set'], ['checks.localhost_ports', 'set'],
  ['worker.paths.deny', 'union', 'glob'], ['worker.bash.deny', 'union', 'cmd'], ['worker.bash.deny_patterns', 'union', 'regex'], ['plan.scope_deny', 'union', 'glob'], ['retry.no_escalate', 'union'],
  ['worker.approval.wait_in_hook_s', 'min'], ['worker.approval.ttl_s', 'min'], ['plan.planner_timeout_s', 'min'], ['plan.max_tasks', 'min'], ['checks.max_timeout_s', 'min'],
  ['retry.max_attempts', 'min'], ['retry.uncertain_limit_max', 'min'], ['parallel.max_parallel', 'min'],
  ...Object.keys(DEFAULT_RULES.budgets).map((k) => [`budgets.${k}`, 'min']),
  ['retry.same_tier_retries', 'minmap'],
  ['worker.paths.on_outside_scope', 'rank', ['ask', 'deny']], ['worker.sandbox', 'rank', ['off', 'required']], ['plan.approval', 'rank', ['auto', 'required']],
  ['checks.sandbox', 'rank', ['off', 'required']], ['plan.planner_tier', 'rank', ['haiku', 'sonnet', 'opus']], ['plan.draft_tier', 'rank', ['haiku', 'sonnet']],
  ['plan.max_start_tier', 'rank', ['opus', 'sonnet', 'haiku']], ['parallel.soft_budget_blocks_tier', 'rank', ['none', 'opus']],
  ['retry.ladder', 'subseq'],
  ['parallel.overlapping_scopes', 'pinned'], ['merge.strategy', 'pinned'], ['merge.on_conflict', 'pinned'], ['done.criteria_when', 'pinned'], ['done.on_unmet', 'pinned'],
  ['ask_human.on_pending_approval', 'pinned'], ['ask_human.on_7d_hold', 'pinned'], ['ask_human.on_budget_hard', 'pinned'], ['ask_human.on_plan_with_commands', 'pinned'], ['ask_human.on_human_criterion', 'pinned'],
  ['repo_config.trust', 'safe', false],
  ...Object.keys(DEFAULT_RULES.governor).map((k) => [`governor.${k}`, 'free']),
];
// a repo may never loosen these, not even with human acceptance (design 3.3)
const NEVER_FROM_REPO = new Set(['worker.sandbox', 'checks.sandbox', 'plan.approval', 'repo_config.trust']);

const tag = (e, layer) => (e && typeof e === 'object' ? { ...e, layer } : e);
const clone = (v) => JSON.parse(JSON.stringify(v));
const isSubseq = (sub, full) => { let i = 0; for (const x of full) if (i < sub.length && sub[i] === x) i++; return i === sub.length; };

function tagged(rules, layer) {
  const out = clone(rules);
  for (const [p, kind] of SPEC) { if (kind !== 'set' && kind !== 'union') continue; const a = getPath(out, p); if (Array.isArray(a)) setPath(out, p, a.map((e) => tag(e, layer))); }
  return out;
}

function applyOne(base, val, [p, kind, arg], L) {
  const rid = (suffix) => `${L.layer}:${p}${suffix ? `.${suffix}` : ''}`;
  const permit = (id) => {
    if (L.layer !== 'repo') return true;
    return !NEVER_FROM_REPO.has(p) && L.accept.has(id);
  };
  const loose = (suffix, from, to) => { const id = rid(suffix); const ok = permit(id); (ok ? L.loosenings : L.dropped).push({ layer: L.layer, path: p, from, to, rule_id: id }); return ok; };
  switch (kind) {
    case 'set': {
      const ident = (e) => (arg ? e[arg] : e);
      const keep = new Set(val.map(ident));
      const out = base.filter((e) => keep.has(ident(e)));
      const have = new Set(base.map(ident));
      for (const e of val) if (!have.has(ident(e)) && loose(arg ? e.id : String(e), null, ident(e))) out.push(tag(e, L.layer));
      return out;
    }
    case 'union': {
      const ident = (e) => (arg ? e[arg] : e); const have = new Set(base.map(ident));
      return [...base, ...val.filter((e) => !have.has(ident(e))).map((e) => tag(e, L.layer))];
    }
    case 'min': return val <= base || loose('', base, val) ? val : base;
    case 'minmap': {
      const out = { ...base };
      for (const [k, v] of Object.entries(val)) { if (v <= (base[k] ?? 0) || loose(k, base[k] ?? 0, v)) out[k] = v; }
      return out;
    }
    case 'rank': { const r = (x) => arg.indexOf(x); return r(val) >= r(base) || loose('', base, val) ? val : base; }
    case 'subseq': return isSubseq(val, base) || loose('', base, val) ? val : base;
    case 'pinned': return same(val, base) || loose('', base, val) ? val : base;
    case 'safe': return val === arg || val === base || loose('', base, val) ? val : base;
    case 'free': return val;
    default: throw new Error(`unknown rule kind ${kind}`);
  }
}

/**
 * Merge layers over DEFAULT_RULES. layers: [{layer:'user'|'repo'|'goal', rules, source?}] in application order.
 * A layer may only tighten. Loosenings from `user`/`goal` are applied and listed; from `repo` they are DROPPED unless their
 * rule_id is in opts.accept (and never for NEVER_FROM_REPO paths). Floor rules live in policy.mjs and cannot be reached from here.
 * Returns {ok:false, errors} when a layer is invalid; else {ok:true, compiled, loosenings, dropped, hash, layers}.
 */
export function compileRules(layers = [], { accept = [] } = {}) {
  const errors = [];
  for (const l of layers) {
    const v = validateRules(l.rules, { layer: l.layer });
    if (!v.ok) errors.push(...v.errors.map((e) => `${l.layer}: ${e}`));
  }
  if (errors.length) return { ok: false, errors };
  const compiled = tagged(DEFAULT_RULES, 'default');
  const loosenings = []; const dropped = []; const acc = new Set(accept);
  for (const l of layers) {
    const L = { layer: l.layer, accept: acc, loosenings, dropped };
    for (const spec of SPEC) {
      const val = getPath(l.rules, spec[0]);
      if (val === undefined) continue;
      setPath(compiled, spec[0], applyOne(getPath(compiled, spec[0]), clone(val), spec, L));
    }
    if (l.rules.profile) compiled.profile = l.rules.profile;
    if (l.rules.description) compiled.description = l.rules.description;
  }
  return { ok: true, compiled, loosenings, dropped, hash: rulesHash(compiled),
    layers: [{ layer: 'default', sha256: sha256(canonical(DEFAULT_RULES)) }, ...layers.map((l) => ({ layer: l.layer, source: l.source ?? null, sha256: sha256(canonical(l.rules)) }))] };
}

export const rulesHash = (compiled) => sha256(canonical(compiled));

/** The worker policy (policy.mjs shape) for compiled rules. toPolicy(DEFAULT_RULES) deep-equals DEFAULT_POLICY. */
export function toPolicy(r) {
  const w = r.worker;
  return {
    version: 1, default: 'deny',
    tools: { allow: [...w.tools.allow] },
    paths: { write: 'worktree+scope', read_extra: w.paths.read_extra.map((e) => e.glob), on_outside_scope: w.paths.on_outside_scope, deny: w.paths.deny.map((e) => e.glob) },
    bash: { allow: w.bash.allow.map((e) => e.cmd), deny: w.bash.deny.map((e) => e.cmd), deny_patterns: w.bash.deny_patterns.map((e) => e.regex), ask_on: [...w.bash.ask_on] },
    approval: { wait_in_hook_s: w.approval.wait_in_hook_s, ttl_s: w.approval.ttl_s, on_timeout: 'deny' },
  };
}

// ---------------------------------------------------------------- snapshot (R4)
/**
 * What the engine stores per goal (rules.snapshot.json) and hashes. R4 wires only the legacy goal inputs (policy file + goal policy
 * override), which are already folded into `policy` (the effective worker policy); `compiled` is the engine default rule set that R5
 * will overlay with the user and goal layers. The hash covers both, so any change to either is detected.
 */
export function buildSnapshot({ policy, legacy = false, layers = [] }) {
  const c = compileRules([]);
  const snap = { rules_version: RULES_VERSION, legacy: !!legacy, compiled: c.compiled, policy, layers: [...c.layers, ...layers], loosenings: [...c.loosenings] };
  snap.rules_hash = snapshotHash(snap);
  return snap;
}
/** Hash of the part of a snapshot that decides behaviour. Recomputed from content on every check, never trusted from the file. Never throws. */
export function snapshotHash(snap) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return 'invalid';
  try { return sha256(canonical({ rules_version: snap.rules_version, compiled: snap.compiled, policy: snap.policy })); } catch { return 'invalid'; }
}
/** The rules hash a plan fingerprint / approval binds: undefined for goals without rules or legacy goals (their plan hash is unchanged). */
export function rulesFingerprint(goal, snap) {
  const r = goal?.orch?.rules;
  if (!r || r.legacy) return undefined;
  return snap ? snapshotHash(snap) : 'missing';
}
