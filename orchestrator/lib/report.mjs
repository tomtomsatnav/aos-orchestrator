// Final report.md (design section 4): criteria with check output, per-task tier/attempts/tokens, approvals,
// denials, `git diff --stat base..integration`, and the exact commands for the human to review and merge.
import { versionDrift } from './cli-version.mjs';
import { reportLines } from './anticheat.mjs';
import { escCtrl } from './ctrl.mjs';
const fence = (s) => `\n\`\`\`\n${String(s || '').trim()}\n\`\`\`\n`;

export function buildReport({ goal, tasks, state = null, approvals = [], denials = [], selfChecks = 0, diffStat = '', criteriaResults = {}, events = [], governor = null }) {
  const o = goal.orch;
  const L = [];
  L.push(`# Goal report: ${goal.title}`, '', `- id: \`${goal.id}\``, `- status: **${goal.status}**${goal.blocked_reason ? ` (${escCtrl(goal.blocked_reason)})` : ''}`,
    `- repo: \`${o.repo}\`  base: \`${o.base_branch}\` @ \`${(o.base_commit || '').slice(0, 10)}\`  integration: \`${o.integration_branch}\``,
    `- new tokens: ${o.usage.new_tokens}  cache-read tokens: ${o.usage.cache_read_tokens}  workers started: ${o.usage.workers_started}`,
    `- notional cost (list price, NOT money spent on a subscription): $${(o.usage.notional_usd || 0).toFixed(4)}`);
  if (o.claude_version_start) L.push(`- claude CLI version at first dispatch: \`${o.claude_version_start}\``);
  const drift = versionDrift(o.claude_version_start, tasks);
  if (drift.length) L.push(`- **WARN: the claude CLI version changed during this goal** (started with \`${o.claude_version_start}\`): ${drift.map((d) => `${d.task}#${d.n} ran on \`${d.version}\``).join(', ')}. Results may not be comparable.`);
  L.push('');
  L.push('## Success criteria', '');
  for (const c of goal.success_criteria) {
    L.push(`- [${c.met ? 'x' : ' '}] **${c.id}** ${c.text}${c.check ? ` (\`${c.check.argv.join(' ')}\`)` : ''}`);
    const r = criteriaResults[c.id];
    if (r) L.push(fence(((r.ok ? 'PASS' : 'FAIL') + ` exit=${r.exit_code}\n${(r.output || '').slice(-1500)}`).replace(/```/g, "'''")).replace(/\n$/, ''));
  }
  L.push('', '## Tasks', '', '| task | status | tier | attempts | new tokens | outcomes |', '|---|---|---|---|---|---|');
  for (const t of tasks) {
    const out = (t.orch?.attempt_log || []).map((a) => `${a.n}:${a.tier}:${a.outcome || 'running'}`).join(', ');
    L.push(`| ${t.id} | ${t.status} | ${t.orch?.model_tier} | ${t.attempts}/${t.max_attempts} | ${t.orch?.tokens?.new ?? 0} | ${out} |`);
  }
  const errs = tasks.flatMap((t) => (t.orch?.attempt_log || []).filter((a) => a.stderr_tail).map((a) => ({ t, a })));
  if (errs.length) {
    L.push('', '## Worker errors (last lines of stderr)');
    for (const { t, a } of errs) L.push('', `${t.id} attempt ${a.n} (${a.tier}): ${a.outcome || 'running'}`, fence(String(a.stderr_tail).replace(/```/g, "'''")).replace(/\n$/, ''));
  }
  const notes = tasks.filter((t) => t.status === 'failed' && t.orch?.last_failure?.worker_note);
  if (notes.length) {
    L.push('', "## Failed tasks: the worker's last note (written by the model: untrusted, check it yourself)");
    for (const t of notes) L.push('', `${t.id}:`, fence(String(t.orch.last_failure.worker_note).replace(/```/g, "'''")).replace(/\n$/, ''));
  }
  L.push('', ...reportLines(state || { goal, tasks }));
  L.push('## Approvals', '');
  if (!approvals.length) L.push('none');
  for (const a of approvals) L.push(`- ${a.id} ${a.task_id} ${a.tool}: ${a.status}${a.scope ? ` (${a.scope})` : ''} by ${a.decided_by || 'n/a'}`);
  L.push('', '## Policy denials', '');
  if (!denials.length) L.push('none');
  for (const d of denials) L.push(`- ${d.task_id} attempt ${d.attempt}: ${d.label} (${d.rule})`);
  if (selfChecks) L.push('', `Self-checks: ${selfChecks} run(s) (approved check argv a worker asked the engine to run, sandboxed; not denials)`);
  if (o.review) {
    L.push('', '## Reviewer notes (advisory, written by a model, not verified)', '',
      o.review.error ? `The advisory review did not complete: ${o.review.error}` : fence(String(o.review.text || '(empty)').replace(/```/g, "'''")).trim(),
      '', `(tier ${o.review.tier}; these notes never affect the goal status)`);
  }
  if (governor?.pause) L.push('', '## Governor', '', `paused: ${governor.pause.reason}`);
  L.push('', '## Diff (base..integration)', fence(String(diffStat || '(no changes)').replace(/```/g, "'''")));
  L.push('## Review and merge (the engine never merges to your base branch)', '',
    '```sh', `git -C ${JSON.stringify(o.repo)} log --oneline ${o.base_branch}..${o.integration_branch}`,
    `git -C ${JSON.stringify(o.repo)} diff ${o.base_branch}..${o.integration_branch}`,
    `git -C ${JSON.stringify(o.repo)} merge --no-ff ${o.integration_branch}   # when satisfied, from ${o.base_branch}`, '```', '',
    `Events: ${events.length} (see events.ndjson).`, '');
  return L.join('\n');
}
