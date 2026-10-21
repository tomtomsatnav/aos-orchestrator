// Budgets and the plan-limit governor (design section 8). Pure decision logic over a small JSON state file
// (orch/governor.json, shared by all goals) + counters. Time is always passed in, never read.
import path from 'node:path';
import { atomicWrite, readJSON } from './state.mjs';

// Real shapes (observed in ~/.claude/projects transcripts, CLI 2.1.299-302): a rejected call yields an assistant message with
// apiError "usage_limit_reached", error "rate_limit", apiErrorStatus 429, apiErrorParams.rate_limit_info {status:"rejected", resetsAt:<epoch s>,
// rateLimitType:"five_hour"|"seven_day"} and text "You've hit your session limit · resets 4:50pm (Europe/London)" / "You've hit your weekly limit · resets Oct 21 at 9am (Europe/London)".
// Structured fields win; this text is only a fallback. Overloaded (529) and auth texts were NOT observed: they follow the public API shape.
export const DEFAULTS = { reserve_5h: 0.8, hold_7d: 0.9, jitter_s: 60, backoff_min: [15, 30, 60, 240], overload_backoff_s: [30, 60, 120, 300],
  limit_text: "hit your (session|weekly|usage|opus|sonnet)? ?limit|usage[ _]limit|limit reached|rate[ _]limit|too many requests",
  overload_text: 'overloaded', auth_text: 'login expired|please run /login|authentication[_ ]failed|invalid api key|oauth token' };

const emptyState = () => ({ five_hour: null, seven_day: null, status: null, updated_at: null, pause: null, backoff_level: 0, overload_level: 0, ack_7d_reset_ms: null });

export const govFile = (orchDir) => path.join(orchDir, 'governor.json');
export const loadGovernor = (orchDir) => ({ ...emptyState(), ...(readJSON(govFile(orchDir), {}) || {}) });
export const saveGovernor = (orchDir, st) => atomicWrite(govFile(orchDir), st);

/** Epoch seconds (what the CLI emits, e.g. 1792527600) or ms -> ms. Anything below 1e11 is seconds (1e11 s is year 5138; 1e11 ms is 1973). */
export const epochToMs = (v) => (Number.isFinite(v) && v > 0 ? (v < 1e11 ? v * 1000 : v) : null);
const win = (w) => (w && Number.isFinite(w.utilization) ? { utilization: w.utilization, resets_at_ms: epochToMs(w.resetsAt) } : null);

/** Normalise one stream-json rate_limit_event (spike row 9) or an assistant api-error message carrying the same info
 *  (apiErrorParams.rate_limit_info / quotaLimits). resetsAt is epoch SECONDS in the CLI; we store ms. */
export function parseRateLimitEvent(ev) {
  const i = ev && (ev.rate_limit_info || ev.apiErrorParams?.rate_limit_info || ev.quotaLimits);
  if (!i || typeof i !== 'object') return null;
  const out = { status: typeof i.status === 'string' ? i.status : null, five_hour: win(i.unifiedWindows?.five_hour), seven_day: win(i.unifiedWindows?.seven_day),
    type: i.rateLimitType || null, resets_at_ms: epochToMs(i.resetsAt), utilization: i.utilization ?? null };
  if (!out.five_hour && out.type === 'five_hour' && Number.isFinite(i.utilization)) out.five_hour = { utilization: i.utilization, resets_at_ms: out.resets_at_ms };
  if (!out.seven_day && out.type === 'seven_day' && Number.isFinite(i.utilization)) out.seven_day = { utilization: i.utilization, resets_at_ms: out.resets_at_ms };
  return out;
}

export class Governor {
  constructor(orchDir, cfg = {}) { this.orchDir = orchDir; this.cfg = { ...DEFAULTS, ...cfg }; }
  load() { return loadGovernor(this.orchDir); }

  /** Fold one parsed rate_limit_event into governor.json. Returns the new state. */
  observe(info, nowMs) {
    if (!info) return this.load();
    const st = this.load();
    if (info.five_hour) st.five_hour = info.five_hour;
    if (info.seven_day) st.seven_day = info.seven_day;
    st.status = info.status; st.updated_at = nowMs;
    if (/^allowed/.test(info.status || '')) { st.backoff_level = 0; st.overload_level = 0; } // a healthy event ends the backoff ladders
    if (info.status && !/^allowed/.test(info.status)) {
      // rejected: pause until the relevant window resets (+jitter); else back off 15 -> 30 -> 60 -> 240 min
      const resets = [info.resets_at_ms, info.five_hour?.utilization >= 1 ? info.five_hour.resets_at_ms : null,
        info.seven_day?.utilization >= 1 ? info.seven_day.resets_at_ms : null].filter((x) => Number.isFinite(x) && x > nowMs);
      this._pauseTimed(st, resets.length ? Math.max(...resets) + this.cfg.jitter_s * 1000 : null, `plan limit: status ${info.status}`, nowMs);
    }
    saveGovernor(this.orchDir, st);
    return st;
  }

  /** A worker ended with a plan-limit failure. resetsMs may be epoch s or ms (normalised). */
  noteLimitFailure(nowMs, reason, resetsMs = null) {
    const st = this.load(); resetsMs = epochToMs(resetsMs);
    this._pauseTimed(st, Number.isFinite(resetsMs) && resetsMs > nowMs ? resetsMs + this.cfg.jitter_s * 1000 : null, reason, nowMs);
    saveGovernor(this.orchDir, st);
    return st;
  }

  /** A worker hit API overload (HTTP 529): short escalating backoff (30 s -> 5 min), never an hours-long plan pause. */
  noteOverloaded(nowMs, reason = 'API overloaded (529)') {
    const st = this.load(); const lad = this.cfg.overload_backoff_s;
    const s = lad[Math.min(st.overload_level, lad.length - 1)]; st.overload_level += 1;
    this._pauseTimed(st, nowMs + s * 1000, `${reason}: retry in ${s} s`, nowMs);
    saveGovernor(this.orchDir, st);
    return st;
  }

  _pauseTimed(st, untilMs, reason, nowMs) {
    if (untilMs == null) {
      const mins = this.cfg.backoff_min[Math.min(st.backoff_level, this.cfg.backoff_min.length - 1)];
      st.backoff_level += 1;
      untilMs = nowMs + mins * 60000;
      reason += ` (no resetsAt: backoff ${mins} min)`;
    }
    if (!st.pause || (!st.pause.manual && untilMs > (st.pause.until_ms || 0))) st.pause = { manual: false, until_ms: untilMs, reason, set_at: nowMs };
  }

  /** Human `resume`: clears any pause and silences the seven-day hold until that window resets. */
  resume(nowMs) {
    const st = this.load();
    st.pause = null; st.backoff_level = 0;
    if (st.seven_day?.resets_at_ms) st.ack_7d_reset_ms = st.seven_day.resets_at_ms;
    saveGovernor(this.orchDir, st);
    return st;
  }

  /**
   * Decide what the engine may do now. Mutates governor.json only to clear an elapsed pause.
   * -> { dispatch: bool, paused: bool, manual: bool, reason: string|null, resume_at_ms: number|null, resumed: bool }
   */
  evaluate(nowMs) {
    const st = this.load();
    let resumed = false;
    if (st.pause && !st.pause.manual && st.pause.until_ms <= nowMs) { st.pause = null; resumed = true; }
    if (resumed) saveGovernor(this.orchDir, st);
    if (st.pause) return { dispatch: false, paused: true, manual: !!st.pause.manual, reason: st.pause.reason, resume_at_ms: st.pause.until_ms, resumed };
    const d7 = st.seven_day; // derived, not stored: ends by itself when the window resets; a human `resume` acknowledges it
    if (d7 && d7.utilization >= this.cfg.hold_7d && (!d7.resets_at_ms || nowMs < d7.resets_at_ms) && st.ack_7d_reset_ms !== d7.resets_at_ms) {
      return { dispatch: false, paused: true, manual: true, resume_at_ms: null, resumed,
        reason: `seven-day utilisation ${Math.round(d7.utilization * 100)}% >= ${Math.round(this.cfg.hold_7d * 100)}%: manual resume only` };
    }
    const d5 = st.five_hour;
    if (d5 && d5.utilization >= this.cfg.reserve_5h && d5.resets_at_ms && nowMs < d5.resets_at_ms) {
      return { dispatch: false, paused: false, manual: false, reason: `five-hour utilisation ${Math.round(d5.utilization * 100)}% >= reserve ${Math.round(this.cfg.reserve_5h * 100)}%: no new work until the window resets`,
        resume_at_ms: d5.resets_at_ms, resumed };
    }
    return { dispatch: true, paused: false, manual: false, reason: null, resume_at_ms: null, resumed };
  }
}

const kindOf = (type, text) => (type === 'five_hour' || type === 'seven_day' ? type
  : /weekly|seven.day|7.day/i.test(text) ? 'seven_day' : /session|five.hour|5.hour/i.test(text) ? 'five_hour' : null);

/**
 * Classify a finished worker. Structured fields first, text only as a fallback.
 * extra.rateLimit: last parsed rate_limit_event / api-error info (status 'rejected' is decisive). extra.apiError: assistant api-error message
 * ({apiError, apiErrorStatus, error}). Returns {limited, overloaded, auth, certain, kind: 'five_hour'|'seven_day'|'limit'|'overloaded'|'auth'|null, why}.
 */
export function detectLimitFailure(result, stderrText = '', cfg = {}, extra = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const no = (why) => ({ limited: false, overloaded: false, auth: false, certain: false, kind: null, why });
  const rl = extra.rateLimit; const ae = extra.apiError;
  // Text is a fallback ONLY for results shaped like an API error (no usage, synthetic model, zero output tokens, or api_error fields).
  // A result that did real work (tokens produced, max_turns stop) carries worker-authored text ("Implemented the rate limit middleware")
  // and its errors[] hold tool/file errors (ENOENT: rate_limit.json): neither is ever matched.
  const u = result?.usage; const outTok = Number(u?.output_tokens);
  const apiShaped = !!ae || (!!result && (result.api_error_status != null || result.apiError != null || result.model === '<synthetic>'
    || (result.modelUsage && Object.keys(result.modelUsage).length > 0 && Object.keys(result.modelUsage).every((m) => m === '<synthetic>'))
    || !u || (Number.isFinite(outTok) && outTok === 0)) && result.subtype !== 'error_max_turns');
  const text = apiShaped ? `${result?.result || ''} ${stderrText} ${ae?.text || ''}` : '';
  const status = result?.api_error_status ?? ae?.apiErrorStatus ?? null;
  const rejected = rl && typeof rl.status === 'string' && !/^allowed/.test(rl.status);
  const hit = (kind, certain, why) => ({ limited: true, overloaded: false, auth: false, certain, kind, why });
  if (!result && !ae) return /usage limit|rate limit|limit reached|hit your .{0,12}limit/i.test(stderrText) ? hit(kindOf(rl?.type, stderrText) || 'limit', false, 'stderr limit text, no result') : no('no result');
  if (result && result.subtype === 'error_max_budget_usd') return no('budget');
  const isErr = result ? !!result.is_error : true;
  if (!isErr) return no('not an error');
  // structured: HTTP status / api error code
  if (status === 529 || ae?.apiError === 'overloaded_error') return { limited: false, overloaded: true, auth: false, certain: true, kind: 'overloaded', why: 'api_error_status 529' };
  if (status === 401 || status === 403 || ae?.error === 'authentication_failed') return { limited: false, overloaded: false, auth: true, certain: true, kind: 'auth', why: `auth failure (${status ?? ae.error})` };
  if (ae?.apiError === 'usage_limit_reached') return hit(kindOf(rl?.type, text) || 'limit', true, 'apiError usage_limit_reached');
  if (rejected) return hit(kindOf(rl.type, text) || 'limit', true, `rate_limit_event status ${rl.status}`);
  if (status === 429) return hit(kindOf(rl?.type, text) || 'limit', true, 'api_error_status 429');
  // fallback: text (uncertain)
  if (!apiShaped) return no('not an API-error-shaped result: text fallback not applied');
  if (new RegExp(c.overload_text, 'i').test(text)) return { limited: false, overloaded: true, auth: false, certain: false, kind: 'overloaded', why: 'overloaded text matched' };
  if (new RegExp(c.auth_text, 'i').test(text)) return { limited: false, overloaded: false, auth: true, certain: false, kind: 'auth', why: 'auth text matched' };
  if (new RegExp(c.limit_text, 'i').test(text)) return hit(kindOf(rl?.type, text) || 'limit', false, 'limit text matched (fallback)');
  return no('not limited');
}

/** New tokens = input + cache_creation + output; cache reads are tracked separately (design section 5). */
export function usageOf(u) {
  const x = u || {};
  return { new_tokens: (x.input_tokens || 0) + (x.cache_creation_input_tokens || 0) + (x.output_tokens || 0), cache_read_tokens: x.cache_read_input_tokens || 0 };
}

const TICK_FLOOR_S = 1; // regular polls are >= 1s apart (default 10s, the evals 2s; heartbeat interval_s floors at 1s): faster SUSTAINED ticking looks like a runaway loop
/** Budget evaluation. goal: goal.json object; nowMs: ms; seq: heartbeat seq; inflight: extra new tokens not yet accounted. */
export function checkBudgets(goal, { nowMs, seq, inflightTokens = 0, softFrac = 0.8 }) {
  const o = goal.orch, b = goal.budget, B = o.budgets;
  const used = (o.usage.new_tokens || 0) + inflightTokens;
  const wall = o.started_ms ? (nowMs - o.started_ms) / 1000 : 0;
  const out = { soft: [], hard: [] };
  const frac = (x, cap) => (cap > 0 ? x / cap : Infinity); // a cap of 0 (or less) means "nothing allowed", never "unlimited"
  if (Number.isFinite(B.max_new_tokens)) {
    if (frac(used, B.max_new_tokens) >= 1) out.hard.push(`new-token cap reached (${used} >= ${B.max_new_tokens})`);
    else if (frac(used, B.max_new_tokens) >= softFrac) out.soft.push(`new tokens at ${Math.round(softFrac * 100)}% of the cap`);
  }
  if (Number.isFinite(b.max_wall_clock_s)) {
    if (frac(wall, b.max_wall_clock_s) >= 1) out.hard.push(`wall-clock cap reached (${Math.round(wall)}s >= ${b.max_wall_clock_s}s)`);
    else if (frac(wall, b.max_wall_clock_s) >= softFrac) out.soft.push(`wall clock at ${Math.round(softFrac * 100)}% of the cap`);
  }
  // max_ticks guards against a runaway engine loop (ticks far faster than its poll), not against a long goal: time is max_wall_clock_s's job. So the cap
  // grows by one tick per elapsed wall-clock second: an engine polling every >= 1s never hits it however long the goal runs
  // (an eval at a 2s poll used to stop at ~17 min with tick budget exceeded (501 > 500)), while a tick storm still exceeds max_ticks extra ticks quickly.
  const tickCap = b.max_ticks + Math.floor(Math.max(0, wall) / TICK_FLOOR_S);
  if (Number.isFinite(b.max_ticks) && (seq > tickCap || b.max_ticks <= 0)) out.hard.push(`tick budget exceeded (${seq} > ${tickCap})`);
  if (Number.isFinite(b.max_usd) && ((o.usage.notional_usd || 0) >= b.max_usd || b.max_usd <= 0)) out.hard.push(`notional USD cap reached ($${(o.usage.notional_usd).toFixed(4)} >= $${b.max_usd})`);
  return out;
}

// ---- elastic token budget (drafted goals only, unless the human passed --max-tokens): sized from the plan, grown only while the goal makes progress; never above `hard` (the rules limit)
const TIER_TOKENS = { haiku: 60000, sonnet: 120000, opus: 200000 }; const RETRY_HEADROOM = 1.5; const GROW_STEP = 0.25; const MIN_PLAN_BUDGET = 150000;
const round10k = (n) => Math.ceil(n / 10000) * 10000;
/** Working token budget from a plan: per task an allowance by tier, +10% per path_scope entry (max 10), summed, x1.5 for retries, plus what the planner already used; capped at `hard`. */
export function planTokenBudget(tasks, { used = 0, hard = Infinity } = {}) {
  const sum = tasks.reduce((s, t) => s + (TIER_TOKENS[t.model_tier ?? t.orch?.model_tier] || TIER_TOKENS.sonnet) * (1 + Math.min((t.path_scope ?? t.orch?.path_scope ?? []).length, 10) / 10), 0);
  return Math.min(hard, Math.max(MIN_PLAN_BUDGET, round10k(sum * RETRY_HEADROOM + used)));
}
/** The new working budget when usage is at `softFrac` of it AND progress (merged tasks + met criteria) rose since the last extension; else null. Bounded step, never above `hard`. */
export function grownTokenBudget({ used, cap, progress, mark, hard, softFrac = 0.8 }) {
  if (!(cap > 0) || cap >= hard || used < softFrac * cap || !(progress > mark)) return null;
  const next = Math.min(hard, round10k(cap * (1 + GROW_STEP))); return next > cap ? next : null;
}
