// PostToolUse / PostToolUseFailure probe hook: estimate context, inject once past the threshold.
import fs from 'node:fs';
const T = Number(process.env.AOS_RELAY_THRESHOLD || 30000);
const LOG = process.env.AOS_RELAY_LOG;
let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  const p = JSON.parse(s);
  let last = 0;
  try {
    const fd = fs.openSync(p.transcript_path, 'r'); const size = fs.fstatSync(fd).size; const n = Math.min(size, 262144);
    const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
    for (const l of buf.toString('utf8').split('\n')) { try { const r = JSON.parse(l); if (r.type === 'assistant' && !r.isSidechain && r.message?.usage) { const u = r.message.usage; last = (u.input_tokens||0)+(u.cache_creation_input_tokens||0)+(u.cache_read_input_tokens||0)+(u.output_tokens||0); } } catch {} }
  } catch {}
  const resp = JSON.stringify(p.tool_response ?? p.error ?? '').length;
  const est = last + Math.round(resp / 3.5);
  const marker = `${LOG}.injected`;
  const fire = est >= T && !fs.existsSync(marker);
  fs.appendFileSync(LOG, JSON.stringify({ ev: p.hook_event_name, tool: p.tool_name, last, resp, est, fire, keys: Object.keys(p) }) + '\n');
  if (fire) {
    fs.writeFileSync(marker, '1');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: p.hook_event_name, additionalContext:
      `RELAY: context budget reached (about ${est} tokens, budget ${T}). Stop the task now. Use the Write tool to write HANDOFF.md with these sections: ## Done, ## In progress, ## Next steps, ## Known failures, ## Decisions, ## Files touched. Then end your turn. Do not call any other tool.` } }));
  }
});
