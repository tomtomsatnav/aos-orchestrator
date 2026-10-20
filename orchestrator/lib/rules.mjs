// Declarative rule set (docs/rules-design.md sections 2-4). PURE: no fs, no clock, no env.
//   DEFAULT_RULES            today's behaviour, as data
//   validateRules(rules)     schema + domain checks -> {ok, errors[]}
//   compileRules(layers)     merge layers (a lower layer may only TIGHTEN) -> {ok, compiled, loosenings, dropped, hash, layers}
//   toPolicy(compiled)       the worker policy object policy.mjs evaluates (DEFAULT_RULES -> DEFAULT_POLICY exactly)
import { validateSchema } from './schema.mjs';
import { allowlistEntryProblem } from './policy.mjs';
import { canonical, sha256, UNSAFE_CHECK_CMDS } from './plan.mjs';
import { DEFAULT_BUDGETS } from './state.mjs';

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
    approval: obj({ wait_in_hook_s: num(0, 25), ttl_s: int(1, 604800), grant_scopes: list(enums('once', 'task'), 2) }),
    sandbox: enums('off', 'required'),
  }),
  plan: obj({ approval: enums('required', 'auto'), planner_tier: enums(...TIER), draft_tier: enums('haiku', 'sonnet'), planner_timeout_s: int(1, 1800), max_tasks: int(1, 50),
    tiers: { ...list(enums(...TIER), 3), minItems: 1 }, max_start_tier: enums(...TIER), scope_deny: globRules, auto_approvable_checks: cmdRules }),
  checks: obj({ allowlist: cmdRules, max_timeout_s: int(1, 3600), sandbox: enums('required', 'off'), localhost_ports: list(int(1, 65535), 16) }),
  retry: obj({ max_attempts: int(1, 10), ladder: { ...list(enums(...TIER), 3), minItems: 1 }, same_tier_retries: { type: 'object' }, no_escalate: list(str(48), 32), uncertain_limit_max: int(1, 5) }),
  budgets: obj({ max_new_tokens: int(1, 1e10), max_wall_clock_s: int(1, 31536000), max_ticks: int(1, 1e7), max_usd: num(0, 10000), attempt_usd_cap: num(0, 10000), task_wall_clock_s: int(1, 86400),
    stall_after_s: int(1, 86400), max_turns: int(1, 1000), soft_frac: num(0, 1), hard_grace_s: int(0, 3600), draft_usd_cap: num(0, 100) }),
  governor: obj({ reserve_5h: num(0, 1), hold_7d: num(0, 1), jitter_s: int(0, 3600), backoff_min: list(num(0, 100000), 16), overload_backoff_s: list(num(0, 100000), 16) }),
  parallel: obj({ max_parallel: int(1, 16), overlapping_scopes: enums('serialize'), soft_budget_blocks_tier: enums('opus', 'none') }),
  merge: obj({ strategy: enums('no-ff'), on_conflict: enums('retry_counted', 'fail') }),
  done: obj({ criteria_when: enums('all_tasks_done'), on_unmet: enums('block') }),
  ask_human: obj({ on_pending_approval: enums('needs_review'), on_7d_hold: enums('manual_resume'), on_budget_hard: enums('block'), on_plan_with_commands: enums('required'), on_human_criterion: enums('wait') }),
  repo_config: obj({ trust: { type: 'boolean' } }),
}, { required: ['rules_version'] });

export const MAX_REGEX_LEN = 200;
const BUILTIN_REGEX = new Set(DEFAULT_RULES.worker.bash.deny_patterns.map((e) => e.regex)); // the engine's own patterns (one uses a lookahead) are trusted
/**
 * RE2-style restrictions for a USER deny pattern (V8 backtracks, so the unsafe constructs are refused instead): no backreferences, no lookaround, no
 * group that is quantified with * + {n,} while containing a quantifier or an alternation ((a+)+, (a|aa)+), at most 3 unbounded quantifiers, a length cap.
 * Matching is additionally bounded at run time (policy.mjs: input cap and a vm timeout). Returns a problem string or null.
 */
export function regexProblem(src) {
  if (typeof src !== 'string' || !src) return 'empty pattern';
  if (BUILTIN_REGEX.has(src)) return null;
  if (src.length > MAX_REGEX_LEN) return `longer than ${MAX_REGEX_LEN} characters`;
  const stack = [{ q: false, alt: false }]; let unbounded = 0; let i = 0;
  const top = () => stack[stack.length - 1];
  const quantAt = (k) => { const c = src[k]; if (c === '*' || c === '+') return 'unbounded'; if (c === '?') return 'opt'; const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(k)); if (!m) return null; return m[2] !== undefined && m[3] === '' ? 'unbounded' : 'bounded'; };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      if (/[1-9kK]/.test(src[i + 1] || '')) return 'backreferences are not allowed';
      i += 2; continue;
    }
    if (c === '[') { i++; if (src[i] === '^') i++; if (src[i] === ']') i++; while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1; i++; continue; }
    if (c === '(') {
      if (src[i + 1] === '?') { if (src[i + 2] === ':') i += 3; else return 'only plain and (?:...) groups are allowed (no lookaround or named groups)'; } else i++;
      stack.push({ q: false, alt: false }); continue;
    }
    if (c === ')') {
      if (stack.length < 2) return 'unbalanced parentheses';
      const g = stack.pop(); i++;
      const k = quantAt(i);
      if (k === 'unbounded' || k === 'bounded') { if (g.q || g.alt) return 'a quantified group may not contain a quantifier or an alternation (ReDoS risk)'; }
      const t = top(); t.q ||= g.q || !!k; t.alt ||= g.alt; if (k === 'unbounded') unbounded++;
      continue;
    }
    if (c === '|') { top().alt = true; i++; continue; }
    const k = quantAt(i);
    if (k && (c === '*' || c === '+' || c === '?' || c === '{')) {
      top().q = true; if (k === 'unbounded') unbounded++;
      i += c === '{' ? /^\{[^}]*\}/.exec(src.slice(i))[0].length : 1; if (src[i] === '?') i++; // lazy suffix
      continue;
    }
    i++;
  }
  if (stack.length !== 1) return 'unbalanced parentheses';
  if (unbounded > 3) return 'more than 3 unbounded quantifiers';
  return null;
}
const MAX_SAME_TIER_KEYS = 8;
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
  (rules.worker?.paths?.read_extra || []).forEach((e, i) => globProblem(e.glob, at('worker.paths.read_extra', i, 'glob'), bad, true));
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
    const rp = regexProblem(e.regex); if (rp) bad(`${w}: ${rp}`);
  });
  const str_ = rules.retry?.same_tier_retries;
  if (str_ && typeof str_ === 'object' && !Array.isArray(str_)) {
    if (Object.keys(str_).length > MAX_SAME_TIER_KEYS) bad(`$.retry.same_tier_retries: more than ${MAX_SAME_TIER_KEYS} keys`);
    for (const [k, v] of Object.entries(str_)) {
      if (!/^[a-z][a-z_]{0,31}$/.test(k) || k in Object.prototype) bad(`$.retry.same_tier_retries: invalid key "${String(k).slice(0, 40)}"`);
      else if (!Number.isInteger(v) || v < 0 || v > 5) bad(`$.retry.same_tier_retries.${k}: must be an integer 0-5`);
    }
  } else if (str_ !== undefined) bad('$.retry.same_tier_retries: expected object');
  if (rules.budgets?.soft_frac !== undefined && rules.budgets.soft_frac <= 0) bad('$.budgets.soft_frac: must be > 0');
  return { ok: errors.length === 0, errors };
}

function globProblem(glob, where, bad, absoluteOk = false) {
  if (/[\0\n]/.test(glob)) bad(`${where}: contains control characters`);
  else if (glob.startsWith('/') && !absoluteOk) bad(`${where}: must be relative or start with ~/`);
  else if (glob.startsWith('~') && !glob.startsWith('~/')) bad(`${where}: must be relative or start with ~/`);
}

// ---------------------------------------------------------------- merge
const getPath = (o, p) => p.split('.').reduce((x, k) => (x && typeof x === 'object' && Object.hasOwn(x, k) ? x[k] : undefined), o);
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((x, k) => (x[k] ??= {}), o)[last] = v; }
/** 8 hex characters of the new value: what an acceptance id is bound to. */
export const bindHash = (v) => sha256(canonical(v)).slice(0, 8);
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
const NON_EMPTY = new Set(['plan.tiers']);
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
  // the id binds the CONTENT (a short hash of the new value): an acceptance of `repo:worker.bash.allow.sedn@1a2b3c4d` does not cover a changed body under the same id
  const rid = (suffix, to) => `${L.layer}:${p}${suffix ? `.${suffix}` : ''}@${bindHash(to)}`;
  const permit = (id) => {
    if (L.layer !== 'repo') return true;
    return !NEVER_FROM_REPO.has(p) && L.accept.has(id);
  };
  const loose = (suffix, from, to) => { const id = rid(suffix, to); const ok = permit(id); (ok ? L.loosenings : L.dropped).push({ layer: L.layer, path: p, from, to, rule_id: id, ...(ok ? {} : { reason: 'loosening' }) }); return ok; };
  switch (kind) {
    case 'set': {
      const ident = (e) => (arg ? e[arg] : e);
      const keep = new Set(val.map(ident));
      const out = base.filter((e) => keep.has(ident(e)));
      const have = new Set(base.map(ident));
      for (const e of val) if (!have.has(ident(e)) && loose(arg ? e.id : String(e), null, ident(e))) out.push(tag(e, L.layer));
      return out.length || !NON_EMPTY.has(p) ? out : base; // an emptied tier list must not mean "never run"
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
    for (const k of ['profile', 'description']) { // labels shown on the approval screen: only the human's user layer may change them
      const v = l.rules[k];
      if (v === undefined || v === compiled[k]) continue;
      if (l.layer === 'user') compiled[k] = v;
      else dropped.push({ layer: l.layer, path: k, from: compiled[k], to: v, rule_id: `${l.layer}:${k}@${bindHash(v)}`, reason: 'ignored: only the user layer sets it' });
    }
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
  try {
    // loosenings / dropped / notes are part of what a human approves: hashed when present (an R4 snapshot has none, so its hash is unchanged)
    const extra = {}; for (const k of ['loosenings', 'dropped', 'notes']) if (Array.isArray(snap[k]) && snap[k].length) extra[k] = snap[k];
    return sha256(canonical({ rules_version: snap.rules_version, compiled: snap.compiled, policy: snap.policy, ...extra }));
  } catch { return 'invalid'; }
}
/** The rules hash a plan fingerprint / approval binds: undefined for goals without rules or legacy goals (their plan hash is unchanged). */
export function rulesFingerprint(goal, snap) {
  const r = goal?.orch?.rules;
  if (!r || r.legacy) return undefined;
  return snap ? snapshotHash(snap) : 'missing';
}

// ---------------------------------------------------------------- R5: user and goal layers, legacy mapping, summary
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const slugId = (text, i, used) => {
  let id = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
  if (!/^[a-z0-9]/.test(id)) id = `x${id}`;
  while (used.has(id)) id = `${id.slice(0, 40)}-${i}`;
  used.add(id); return id;
};
const entries = (arr, field) => { const used = new Set(); return arr.map((v, i) => ({ id: slugId(v, i, used), [field]: v })); };

/**
 * Map a LEGACY worker policy object (policy.default.json, goal `orch.policy`: the DEFAULT_POLICY shape) onto a rules layer. Returns {rules, notes}.
 * Differences from the old shallow merge, all tightening-only or listed: deny lists, deny patterns can only grow (the old merge could empty them; the floor
 * still protected the critical paths), allow-list entries that execute code are dropped (the evaluator denied them anyway), unknown keys are ignored.
 */
export function policyToRules(p) {
  const rules = { rules_version: RULES_VERSION }; const notes = [];
  if (!isObj(p)) return { rules, notes: p === undefined || p === null ? [] : ['policy is not an object: ignored'] };
  const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
  const w = {};
  if (isObj(p.tools) && Array.isArray(p.tools.allow)) w.tools = { allow: strs(p.tools.allow) };
  if (isObj(p.paths)) {
    const pa = {};
    if (Array.isArray(p.paths.deny)) pa.deny = entries(strs(p.paths.deny), 'glob');
    if (Array.isArray(p.paths.read_extra)) pa.read_extra = entries(strs(p.paths.read_extra), 'glob');
    if (typeof p.paths.on_outside_scope === 'string') pa.on_outside_scope = p.paths.on_outside_scope;
    if (Object.keys(pa).length) w.paths = pa;
    for (const k of Object.keys(p.paths)) if (!['deny', 'read_extra', 'on_outside_scope'].includes(k) && !(k === 'write' && p.paths.write === 'worktree+scope')) notes.push(`policy.paths.${k} is not a rule: ignored`);
  }
  if (isObj(p.bash)) {
    const b = {};
    if (Array.isArray(p.bash.allow)) {
      const ok = strs(p.bash.allow).filter((e) => { const why = allowlistEntryProblem(e); if (why) notes.push(`policy.bash.allow "${e.slice(0, 60)}" dropped: ${why}`); return !why; });
      b.allow = entries(ok, 'cmd');
    }
    if (Array.isArray(p.bash.deny)) b.deny = entries(strs(p.bash.deny), 'cmd');
    if (Array.isArray(p.bash.deny_patterns)) b.deny_patterns = entries(strs(p.bash.deny_patterns), 'regex');
    if (Array.isArray(p.bash.ask_on)) b.ask_on = strs(p.bash.ask_on);
    if (Object.keys(b).length) w.bash = b;
  }
  if (isObj(p.approval)) {
    const a = {};
    if (p.approval.wait_in_hook_s !== undefined) a.wait_in_hook_s = p.approval.wait_in_hook_s;
    if (p.approval.ttl_s !== undefined) a.ttl_s = p.approval.ttl_s;
    if (Object.keys(a).length) w.approval = a;
    if (p.approval.on_timeout !== undefined && p.approval.on_timeout !== 'deny') notes.push('policy.approval.on_timeout is not a rule (always deny): ignored');
  }
  if (Object.keys(w).length) rules.worker = w;
  for (const k of Object.keys(p)) if (!['tools', 'paths', 'bash', 'approval', 'version', 'default'].includes(k)) notes.push(`policy.${k} is not a rule: ignored`);
  if (p.default !== undefined && p.default !== 'deny') notes.push('policy.default is not a rule (always deny): ignored');
  return { rules, notes };
}

/**
 * The goal's legacy fields as a rules layer: only values that differ from the defaults (a goal spec always carries a full budgets object, and a default
 * value must not undo a user-layer tightening). Returns {rules, notes}. goal.orch.rules_layer (the spec's `orch.rules`) is a separate layer.
 */
export function goalLegacyRules(goal) {
  const o = goal.orch || {}; const B = o.budgets || {}; const rules = { rules_version: RULES_VERSION }; const notes = [];
  const put = (path, val, dflt) => { if (val !== undefined && val !== null && val !== dflt) setPath(rules, path, val); };
  const D = DEFAULT_RULES;
  put('budgets.max_new_tokens', B.max_new_tokens, D.budgets.max_new_tokens); put('budgets.task_wall_clock_s', B.task_wall_clock_s, D.budgets.task_wall_clock_s);
  put('budgets.stall_after_s', B.stall_after_s, D.budgets.stall_after_s); put('budgets.max_turns', B.max_turns, D.budgets.max_turns); put('budgets.attempt_usd_cap', B.attempt_usd_cap, D.budgets.attempt_usd_cap);
  put('parallel.max_parallel', B.max_parallel, D.parallel.max_parallel); put('retry.max_attempts', B.max_attempts, D.retry.max_attempts); put('plan.max_tasks', B.max_tasks, D.plan.max_tasks);
  put('worker.approval.ttl_s', B.approval_ttl_s, D.worker.approval.ttl_s);
  const g = goal.budget || {};
  put('budgets.max_ticks', g.max_ticks, D.budgets.max_ticks); put('budgets.max_usd', g.max_usd, D.budgets.max_usd); put('budgets.max_wall_clock_s', g.max_wall_clock_s, D.budgets.max_wall_clock_s);
  if (Array.isArray(o.check_allowlist) && o.check_allowlist.length) {
    const ok = o.check_allowlist.map((e) => (Array.isArray(e) ? e.join(' ') : e)).filter((e) => {
      const first = typeof e === 'string' ? e.trim().split(/\s+/)[0] || '' : '';
      const bad = !first || UNSAFE_CHECK_CMDS.has(first.split('/').pop()) || e.length > 200;
      if (bad) notes.push(`check_allowlist entry "${String(e).slice(0, 60)}" dropped: not allowed as a check`);
      return !bad;
    });
    if (ok.length) setPath(rules, 'checks.allowlist', entries(ok, 'cmd'));
  }
  if (Array.isArray(o.check_localhost_ports) && o.check_localhost_ports.length) setPath(rules, 'checks.localhost_ports', o.check_localhost_ports);
  if (o.unsandboxed_checks === true) setPath(rules, 'checks.sandbox', 'off');
  if (o.sandbox_workers === true) setPath(rules, 'worker.sandbox', 'required');
  if (o.trust_repo_config === true) setPath(rules, 'repo_config.trust', true);
  if (o.approval_policy?.plan && o.approval_policy.plan !== 'required') setPath(rules, 'plan.approval', o.approval_policy.plan);
  if (isObj(o.governor) && Object.keys(o.governor).length) notes.push('goal governor settings are ignored: the governor is shared by every goal and only the user layer may set it');
  return { rules, notes };
}

/** Write the compiled values the engine reads from goal.json back into it (compiled rules are the truth; legacy fields stay in step). Mutates goal. */
export function applyCompiledToGoal(goal, c) {
  const o = goal.orch; const B = o.budgets;
  B.max_new_tokens = c.budgets.max_new_tokens; B.task_wall_clock_s = c.budgets.task_wall_clock_s; B.stall_after_s = c.budgets.stall_after_s; B.max_turns = c.budgets.max_turns;
  B.attempt_usd_cap = c.budgets.attempt_usd_cap; B.max_parallel = c.parallel.max_parallel; B.max_attempts = c.retry.max_attempts; B.max_tasks = c.plan.max_tasks; B.approval_ttl_s = c.worker.approval.ttl_s;
  goal.budget.max_ticks = c.budgets.max_ticks; goal.budget.max_usd = c.budgets.max_usd; goal.budget.max_wall_clock_s = c.budgets.max_wall_clock_s;
  o.check_localhost_ports = [...c.checks.localhost_ports]; o.unsandboxed_checks = c.checks.sandbox === 'off'; o.sandbox_workers = c.worker.sandbox === 'required';
  o.approval_policy = { ...o.approval_policy, plan: c.plan.approval };
}

/** Snapshot of a compile result (R5+). Not legacy: `policy` is exactly toPolicy(compiled). `inputs` (each layer's rules) lets an accepted loosening recompile without re-reading files. */
export function buildRulesSnapshot(comp, layers) {
  const snap = { rules_version: RULES_VERSION, legacy: false, compiled: comp.compiled, policy: toPolicy(comp.compiled), layers: comp.layers, loosenings: comp.loosenings, dropped: comp.dropped,
    notes: layers.flatMap((l) => l.notes || []).slice(0, 50), inputs: layers.map((l) => ({ layer: l.layer, source: l.source ?? null, rules: l.rules })) };
  snap.rules_hash = snapshotHash(snap);
  return snap;
}

const cmdList = (a, n = 8) => { const c = a.map((e) => e.cmd ?? e.glob ?? e); return c.length <= n ? c.join(', ') || '(none)' : `${c.slice(0, n).join(', ')} +${c.length - n} more`; };
const val = (v) => (v === null || v === undefined ? '(none)' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * Human-readable facts about a snapshot, for the approval screens: what the worker may do, the hard limits, and EVERY loosening (and dropped repo loosening)
 * with its layer and id. Pure; `snap` is a rules.snapshot.json (verified by the caller). Plain strings only (no raw rule bodies beyond commands/globs).
 */
export function summarizeRules(snap) {
  const c = snap?.compiled; const pol = snap?.policy;
  if (!c || !pol) return null;
  const layerLine = (snap.layers || []).map((l) => {
    const dr = (snap.dropped || []).filter((d) => d.layer === l.layer && d.reason === 'loosening').length;
    return `${l.layer}${l.sha256 ? `(${l.sha256.slice(0, 6)}${dr ? `, ${dr} loosening${dr > 1 ? 's' : ''} dropped` : ''})` : ''}`;
  });
  const lo = (snap.loosenings || []).map((l) => ({ layer: l.layer, rule_id: l.rule_id, path: l.path, change: l.from === null || l.from === undefined ? `+ ${val(l.to)}` : `${val(l.from)} -> ${val(l.to)}` }));
  const dr = (snap.dropped || []).map((l) => ({ layer: l.layer, rule_id: l.rule_id, path: l.path, change: l.from === null || l.from === undefined ? `+ ${val(l.to)}` : `${val(l.from)} -> ${val(l.to)}`, reason: l.reason || 'loosening' }));
  return {
    rules_hash: snapshotHash(snap).slice(0, 12), profile: c.profile, description: c.description, legacy: !!snap.legacy, layers: layerLine,
    worker: { tools: [...pol.tools.allow], bash_allow: [...pol.bash.allow], read_extra: [...(pol.paths.read_extra || [])], on_outside_scope: pol.paths.on_outside_scope, sandbox: c.worker.sandbox,
      ask_on: [...pol.bash.ask_on], approval_wait_s: pol.approval.wait_in_hook_s, approval_ttl_s: pol.approval.ttl_s },
    denies: { bash: [...pol.bash.deny], paths: [...pol.paths.deny], patterns: pol.bash.deny_patterns.length, scope_deny: c.plan.scope_deny.map((e) => e.glob), floor: ['.git', '.claude/settings*.json', '.aos', '~/.claude', '~/.ssh', '~/.config'] },
    checks: { allowlist: c.checks.allowlist.map((e) => e.cmd), sandbox: c.checks.sandbox, max_timeout_s: c.checks.max_timeout_s, localhost_ports: [...c.checks.localhost_ports] },
    plan: { approval: c.plan.approval, max_tasks: c.plan.max_tasks, tiers: [...c.plan.tiers], max_start_tier: c.plan.max_start_tier },
    limits: { max_usd: c.budgets.max_usd, max_new_tokens: c.budgets.max_new_tokens, max_wall_clock_s: c.budgets.max_wall_clock_s, max_ticks: c.budgets.max_ticks, max_attempts: c.retry.max_attempts, max_parallel: c.parallel.max_parallel },
    loosenings: lo, dropped: dr, notes: [...(snap.notes || [])].slice(0, 10),
  };
}

/** Plain-text rendering of summarizeRules() for the CLI (design 3.6). */
export function renderRulesSummary(sm) {
  if (!sm) return 'rules: (no snapshot yet)';
  const L = [`rules ${sm.rules_hash}  profile=${sm.profile}${sm.legacy ? '  (legacy goal: rules predate rule sets)' : ''}  layers: ${sm.layers.join(' ')}`];
  L.push(`  worker tools: ${sm.worker.tools.join(' ')}   outside path_scope: ${sm.worker.on_outside_scope}   worker sandbox: ${sm.worker.sandbox}`);
  L.push(`  worker bash allow (${sm.worker.bash_allow.length}): ${cmdList(sm.worker.bash_allow)}${sm.worker.read_extra.length ? `   extra read roots: ${cmdList(sm.worker.read_extra)}` : ''}`);
  L.push(`  denied: bash ${sm.denies.bash.length} (${cmdList(sm.denies.bash, 6)}); paths ${cmdList(sm.denies.paths, 6)}; ${sm.denies.patterns} pattern(s); floor (never removable): ${sm.denies.floor.join(' ')}`);
  if (sm.denies.scope_deny.length) L.push(`  planner may not scope: ${sm.denies.scope_deny.join(' ')}`);
  L.push(`  checks: ${sm.checks.sandbox === 'required' ? 'sandboxed' : 'NOT sandboxed'}; allowlist: ${sm.checks.allowlist.join(', ') || '(none)'}${sm.checks.localhost_ports.length ? `; localhost ports ${sm.checks.localhost_ports.join(',')}` : ''}; max ${sm.checks.max_timeout_s}s`);
  L.push(`  plan approval: ${sm.plan.approval}; max ${sm.plan.max_tasks} tasks; tiers ${sm.plan.tiers.join('/')}; start at most ${sm.plan.max_start_tier}`);
  L.push(`  limits: $${sm.limits.max_usd}, ${sm.limits.max_new_tokens} tokens, ${sm.limits.max_wall_clock_s}s, ${sm.limits.max_attempts} attempts/task, ${sm.limits.max_parallel} parallel`);
  L.push(sm.loosenings.length ? `LOOSENINGS YOU ARE APPROVING (${sm.loosenings.length}):` : 'LOOSENINGS YOU ARE APPROVING: none');
  for (const l of sm.loosenings) L.push(`  ${l.layer}:${l.path}  ${l.change}   [${l.rule_id}]`);
  if (sm.dropped.length) {
    L.push(`NOT APPLIED (${sm.dropped.length}; a repo's loosenings need --accept-repo-loosening <rule_id>):`);
    for (const l of sm.dropped) L.push(`  ${l.layer}:${l.path}  ${l.change}   [${l.rule_id}]${l.reason !== 'loosening' ? `  (${l.reason})` : ''}`);
  }
  for (const n of sm.notes) L.push(`  note: ${n}`);
  return L.join('\n');
}
