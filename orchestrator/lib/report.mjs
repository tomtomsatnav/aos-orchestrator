// Final report.md (design section 4): criteria with check output, per-task tier/attempts/tokens, approvals,
// denials, `git diff --stat base..integration`, and the exact commands for the human to review and merge.
const fence = (s) => `\n\`\`\`\n${String(s || '').trim()}\n\`\`\`\n`;

export function buildReport({ goal, tasks, approvals = [], denials = [], diffStat = '', criteriaResults = {}, events = [], governor = null }) {
  const o = goal.orch;
  const L = [];
  L.push(`# Goal report: ${goal.title}`, '', `- id: \`${goal.id}\``, `- status: **${goal.status}**${goal.blocked_reason ? ` (${goal.blocked_reason})` : ''}`,
    `- repo: \`${o.repo}\`  base: \`${o.base_branch}\` @ \`${(o.base_commit || '').slice(0, 10)}\`  integration: \`${o.integration_branch}\``,
    `- new tokens: ${o.usage.new_tokens}  cache-read tokens: ${o.usage.cache_read_tokens}  workers started: ${o.usage.workers_started}`,
    `- notional cost (list price, NOT money spent on a subscription): $${(o.usage.notional_usd || 0).toFixed(4)}`, '');
  L.push('## Success criteria', '');
  for (const c of goal.success_criteria) {
    L.push(`- [${c.met ? 'x' : ' '}] **${c.id}** ${c.text}${c.check ? ` (\`${c.check.argv.join(' ')}\`)` : ''}`);
    const r = criteriaResults[c.id];
    if (r) L.push(fence((r.ok ? 'PASS' : 'FAIL') + ` exit=${r.exit_code}\n${(r.output || '').slice(-1500)}`).replace(/\n$/, ''));
  }
  L.push('', '## Tasks', '', '| task | status | tier | attempts | new tokens | outcomes |', '|---|---|---|---|---|---|');
  for (const t of tasks) {
    const out = (t.orch?.attempt_log || []).map((a) => `${a.n}:${a.tier}:${a.outcome || 'running'}`).join(', ');
    L.push(`| ${t.id} | ${t.status} | ${t.orch?.model_tier} | ${t.attempts}/${t.max_attempts} | ${t.orch?.tokens?.new ?? 0} | ${out} |`);
  }
  L.push('', '## Approvals', '');
  if (!approvals.length) L.push('none');
  for (const a of approvals) L.push(`- ${a.id} ${a.task_id} ${a.tool}: ${a.status}${a.scope ? ` (${a.scope})` : ''} by ${a.decided_by || 'n/a'}`);
  L.push('', '## Policy denials', '');
  if (!denials.length) L.push('none');
  for (const d of denials) L.push(`- ${d.task_id} attempt ${d.attempt}: ${d.label} (${d.rule})`);
  if (governor?.pause) L.push('', '## Governor', '', `paused: ${governor.pause.reason}`);
  L.push('', '## Diff (base..integration)', fence(diffStat || '(no changes)'));
  L.push('## Review and merge (the engine never merges to your base branch)', '',
    '```sh', `git -C ${JSON.stringify(o.repo)} log --oneline ${o.base_branch}..${o.integration_branch}`,
    `git -C ${JSON.stringify(o.repo)} diff ${o.base_branch}..${o.integration_branch}`,
    `git -C ${JSON.stringify(o.repo)} merge --no-ff ${o.integration_branch}   # when satisfied, from ${o.base_branch}`, '```', '',
    `Events: ${events.length} (see events.ndjson).`, '');
  return L.join('\n');
}
