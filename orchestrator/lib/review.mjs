// Advisory independent review (alignment doc row 9). Opt-in via the rules key `review.advisory: true`. After every task passed and the goal criteria are
// met, ONE read-only model call (no tools, empty temp dir) reads `git diff base..integration` as UNTRUSTED input and writes short "reviewer notes" into
// report.md. It never blocks, never changes task or goal state (only goal.orch.review, for the report), and is capped by a USD limit and a timeout.
import { callModel } from './draft.mjs';
import { untrustedBlocks, sanitizeUntrusted } from './untrusted.mjs';
import * as G from './git.mjs';

export const REVIEW_MARKER = 'AOS_REVIEW';
export const REVIEW_SYSTEM = 'You are an independent code reviewer for an AOS orchestrator. You have no tools and cannot read files. Output plain text only.';
export const REVIEW_USD_CAP = 0.25;
export const MAX_DIFF_CHARS = 60000;
export const MAX_NOTES_CHARS = 3000;

export function buildReviewPrompt({ goal, diff, nonce = null }) {
  const crit = goal.success_criteria.map((c) => `- ${c.id}: ${c.text}`).join('\n');
  const U = untrustedBlocks([{ label: 'git diff base..integration', text: diff || '(no changes)', max: MAX_DIFF_CHARS }], { nonce });
  return [
    REVIEW_MARKER,
    `Review the change below for goal "${goal.title}". Success criteria (already verified by the engine's checks):\n${crit}`,
    U.notice,
    U.blocks[0],
    'Write at most 12 short bullet lines of reviewer notes: scope creep beyond the goal, correctness risks the checks would not catch, missing or weak tests, anything a human should look at first. '
      + 'If you see nothing worth flagging, say "No concerns." Your notes are advisory and a human reads them; do not output anything else.',
  ].join('\n');
}

/** Runs the review. Returns {tier, text?, error?, usage}; never throws. */
export async function runAdvisoryReview({ goal, orchDir, env, bin, tier = 'haiku', spawnFn, timeoutMs = 120000, killGraceMs = 2000, usdCap = REVIEW_USD_CAP }) {
  try {
    const o = goal.orch;
    let diff = (await G.git(o.repo, ['diff', '-U2', `${o.base_commit}..${o.integration_branch}`], { allowFail: true })).stdout;
    if (!diff.trim()) diff = await G.diffStat(o.repo, o.base_commit, o.integration_branch);
    const r = await callModel({ orchDir, env, bin, tier, prompt: buildReviewPrompt({ goal, diff }), usdCap, timeoutMs, killGraceMs, spawnFn, system: REVIEW_SYSTEM });
    if (r.error) return { tier, error: r.error, usage: r.usage };
    return { tier, text: sanitizeUntrusted(String(r.text || '').trim(), MAX_NOTES_CHARS), usage: r.usage };
  } catch (e) { return { tier, error: `review failed: ${String(e.message).slice(0, 200)}`, usage: { new_tokens: 0, notional_usd: 0 } }; }
}
