// Budgets and the plan-limit governor (design section 8). Pure decision logic over a small JSON state file
// (orch/governor.json, shared by all goals) + counters. Time is always passed in, never read.
import path from 'node:path';
import { atomicWrite, readJSON } from './state.mjs';

export const DEFAULTS = { reserve_5h: 0.8, hold_7d: 0.9, jitter_s: 60, backoff_min: [15, 30, 60, 240],
  // UNVERIFIED: the real text/format of a rejected (plan-limited) call was never observed. Treated as a hint only.
  limit_text: 'usage limit|limit reached|rate limit|too many requests|resets \\d' };

const emptyState = () => ({ five_hour: null, seven_day: null, status: null, updated_at: null, pause: null, backoff_level: 0, ack_7d_reset_ms: null });

export const govFile = (orchDir) => path.join(orchDir, 'governor.json');
export const loadGovernor = (orchDir) => ({ ...emptyState(), ...(readJSON(govFile(orchDir), {}) || {}) });
export const saveGovernor = (orchDir, st) => atomicWrite(govFile(orchDir), st);

const win = (w) => (w && Number.isFinite(w.utilization) ? { utilization: w.utilization, resets_at_ms: Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null } : null);

/** Normalise one stream-json rate_limit_event (spike row 9). resetsAt is epoch SECONDS in the CLI; we store ms. */
export function parseRateLimitEvent(ev) {
  const i = ev && ev.rate_limit_info;
  if (!i || typeof i !== 'object') return null;
  const out = { status: typeof i.status === 'string' ? i.status : null, five_hour: win(i.unifiedWindows?.five_hour), seven_day: win(i.unifiedWindows?.seven_day),
    type: i.rateLimitType || null, resets_at_ms: Number.isFinite(i.resetsAt) ? i.resetsAt * 1000 : null, utilization: i.utilization ?? null };
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
    if (/^allowed/.test(info.status || '')) st.backoff_level = 0; // a healthy event ends the backoff ladder
    if (info.status && !/^allowed/.test(info.status)) {
      // rejected: pause until the relevant window resets (+jitter); else back off 15 -> 30 -> 60 -> 240 min
      const resets = [info.resets_at_ms, info.five_hour?.utilization >= 1 ? info.five_hour.resets_at_ms : null,
        info.seven_day?.utilization >= 1 ? info.seven_day.resets_at_ms : null].filter((x) => Number.isFinite(x) && x > nowMs);
      this._pauseTimed(st, resets.length ? Math.max(...resets) + this.cfg.jitter_s * 1000 : null, `plan limit: status ${info.status}`, nowMs);
    }
    saveGovernor(this.orchDir, st);
    return st;
  }

  /** A worker ended with what looks like a plan-limit failure (matcher is UNVERIFIED). */
  noteLimitFailure(nowMs, reason, resetsMs = null) {
    const st = this.load();
    this._pauseTimed(st, Number.isFinite(resetsMs) && resetsMs > nowMs ? resetsMs + this.cfg.jitter_s * 1000 : null, reason, nowMs);
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
    if (!st.pause || st.pause.manual || untilMs > (st.pause.until_ms || 0)) st.pause = { manual: false, until_ms: untilMs, reason, set_at: nowMs };
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

/**
 * Does a finished worker look plan-limited? Combines api_error_status 429, a configurable text matcher (UNVERIFIED)
 * and "unexplained is_error without usage". Returns {limited:bool, certain:bool, why}.
 */
export function detectLimitFailure(result, stderrText = '', cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const re = new RegExp(c.limit_text, 'i');
  if (!result) return { limited: false, certain: false, why: 'no result' };
  const text = `${result.result || ''} ${(result.errors || []).join(' ')} ${stderrText}`;
  if (result.api_error_status === 429) return { limited: true, certain: true, why: 'api_error_status 429' };
  if (result.is_error && re.test(text)) return { limited: true, certain: false, why: 'limit text matched (UNVERIFIED matcher)' };
  const u = result.usage || {};
  const noUsage = !(u.input_tokens || u.output_tokens || u.cache_read_input_tokens || u.cache_creation_input_tokens);
  if (result.is_error && result.subtype !== 'error_max_budget_usd' && noUsage && result.api_error_status != null) return { limited: true, certain: false, why: 'api error without usage' };
  return { limited: false, certain: false, why: 'not limited' };
}

/** New tokens = input + cache_creation + output; cache reads are tracked separately (design section 5). */
export function usageOf(u) {
  const x = u || {};
  return { new_tokens: (x.input_tokens || 0) + (x.cache_creation_input_tokens || 0) + (x.output_tokens || 0), cache_read_tokens: x.cache_read_input_tokens || 0 };
}

/** Budget evaluation. goal: goal.json object; nowMs: ms; seq: heartbeat seq; inflight: extra new tokens not yet accounted. */
export function checkBudgets(goal, { nowMs, seq, inflightTokens = 0 }) {
  const o = goal.orch, b = goal.budget, B = o.budgets;
  const used = (o.usage.new_tokens || 0) + inflightTokens;
  const wall = o.started_ms ? (nowMs - o.started_ms) / 1000 : 0;
  const out = { soft: [], hard: [] };
  const frac = (x, cap) => (cap > 0 ? x / cap : 0);
  if (Number.isFinite(B.max_new_tokens)) {
    if (frac(used, B.max_new_tokens) >= 1) out.hard.push(`new-token cap reached (${used} >= ${B.max_new_tokens})`);
    else if (frac(used, B.max_new_tokens) >= 0.8) out.soft.push('new tokens at 80% of the cap');
  }
  if (Number.isFinite(b.max_wall_clock_s)) {
    if (frac(wall, b.max_wall_clock_s) >= 1) out.hard.push(`wall-clock cap reached (${Math.round(wall)}s >= ${b.max_wall_clock_s}s)`);
    else if (frac(wall, b.max_wall_clock_s) >= 0.8) out.soft.push('wall clock at 80% of the cap');
  }
  if (Number.isFinite(b.max_ticks) && seq > b.max_ticks) out.hard.push(`tick budget exceeded (${seq} > ${b.max_ticks})`);
  if (Number.isFinite(b.max_usd) && b.max_usd > 0 && (o.usage.notional_usd || 0) >= b.max_usd) out.hard.push(`notional USD cap reached ($${(o.usage.notional_usd).toFixed(4)} >= $${b.max_usd})`);
  return out;
}
