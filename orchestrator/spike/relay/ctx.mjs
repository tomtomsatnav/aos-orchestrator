// usage: node ctx.mjs <transcript.jsonl> — per assistant record context size, plus any compaction-looking records
import fs from 'node:fs';
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
let n = 0, last = -1;
for (const l of lines) {
  let r; try { r = JSON.parse(l); } catch { console.log('BAD LINE'); continue; }
  n++;
  if (r.type === 'assistant' && r.message?.usage && !r.isSidechain) {
    const u = r.message.usage; const c = (u.input_tokens||0)+(u.cache_creation_input_tokens||0)+(u.cache_read_input_tokens||0);
    if (c !== last) console.log(`#${n} assistant ctx=${c} out=${u.output_tokens}`); last = c;
  } else if (/compact/i.test(l.slice(0, 400)) || r.isCompactSummary || r.subtype) {
    console.log(`#${n} type=${r.type} subtype=${r.subtype||''} compactMeta=${JSON.stringify(r.compactMetadata||'')} isCompactSummary=${!!r.isCompactSummary}`);
  }
}
