#!/usr/bin/env node
// Step 1 of the demo: copy the exact inputs the video uses into demo/data/ and record where each came from (demo/data/SOURCES.md).
// The kept trial directories are temporary, so this must run while they still exist; render.mjs then reads demo/data/ only.
//   node demo/collect.mjs
// Trial-selection rule: the lowest-numbered trial of each arm (bare trial 1, guarded trial 1) of the impossible-test runs below.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DATA = path.join(HERE, 'data');
const RESULTS = path.join(REPO, 'evals/results');
const BARE = 'eval-real-bare-impossible-test-2026-10-21T12-02-32-079Z.json';
const GUARDED = 'eval-real-guarded-impossible-test-postfix-2026-10-21T14-21-39-167Z.json';
const VERDICTS = process.env.DEMO_VERDICTS || '/private/tmp/claude-501/-Users-tom/417c8483-4f77-4fba-b49b-4efbd68d863b/scratchpad/guardcheck/orch/verdicts';

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const mtime = (p) => fs.statSync(p).mtime.toISOString();
const rows = [];
const put = (name, buf, source, date, note = '') => {
  fs.mkdirSync(path.dirname(path.join(DATA, name)), { recursive: true });
  fs.writeFileSync(path.join(DATA, name), buf);
  rows.push(`| \`${name}\` | ${source} | ${date} | ${sha(buf)} | ${note} |`);
};
const copy = (name, src, note) => put(name, fs.readFileSync(src), `\`${src}\``, `file mtime ${mtime(src)}`, note);

fs.rmSync(DATA, { recursive: true, force: true }); fs.mkdirSync(DATA, { recursive: true });

// 1. The two impossible-test result files, whole (they hold final_message, files_touched, guard results and kept dir paths).
for (const f of [BARE, GUARDED]) {
  const doc = JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8'));
  copy(f, path.join(RESULTS, f), `eval result, generated_at ${doc.generated_at}, arm ${doc.arm}, k ${doc.summary.k}`);
}
const lowest = (f) => JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8')).results.slice().sort((a, b) => a.trial - b.trial)[0];
const bare = lowest(BARE), guarded = lowest(GUARDED);

// 2. The agents' real diffs, from the kept trial repos (git diff of the working tree against the seed commit).
for (const [name, r] of [['bare-trial-1.diff', bare], ['guarded-trial-1.diff', guarded]]) {
  const repo = path.join(r.kept, 'repo');
  const diff = execFileSync('git', ['-C', repo, 'diff'], { encoding: 'utf8' });
  const seed = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%H %cI'], { encoding: 'utf8' }).trim();
  put(name, diff, `\`git -C ${repo} diff\``, `seed commit ${seed}; file mtime ${mtime(path.join(repo, 'test/vat.test.js'))}`, `${r.arm} trial ${r.trial}`);
}

// 3. The task prompt as the harness sends it (evals/tasks.mjs, tracked in git).
const tasks = fs.readFileSync(path.join(REPO, 'evals/tasks.mjs'), 'utf8');
const m = tasks.match(/id: 'impossible-test'[^\n]*\n\s*prompt: '([^']+)'/);
if (!m) throw new Error('impossible-test prompt not found in evals/tasks.mjs');
const commit = execFileSync('git', ['-C', REPO, 'log', '-1', '--format=%h %cI', '--', 'evals/tasks.mjs'], { encoding: 'utf8' }).trim();
put('task-prompt.txt', m[1] + '\n', '`evals/tasks.mjs` (impossible-test `prompt`)', `last commit ${commit}`);

// 4. The real verdict records written by `aos-orch verify` (dashboard Guard view input).
for (const f of fs.readdirSync(VERDICTS).filter((n) => n.endsWith('.json')).sort()) {
  const v = JSON.parse(fs.readFileSync(path.join(VERDICTS, f), 'utf8'));
  copy(`orch/verdicts/${f}`, path.join(VERDICTS, f), `aos.verdict/1, created_at ${v.created_at}, repo ${v.repo_name}, accepted ${v.accepted}`);
  if (v.repo_name === 'vat-cheat' && fs.existsSync(v.repo)) put('verdict-vat-cheat.diff', execFileSync('git', ['-C', v.repo, 'diff', v.base], { encoding: 'utf8' }),
    `\`git -C ${v.repo} diff ${v.base.slice(0, 12)}\``, `verdict created_at ${v.created_at}`, 'the tree that verdict judged');
}

// 5. The task x arm table, regenerated now from evals/results by evals/compile.mjs.
const table = execFileSync('node', [path.join(REPO, 'evals/compile.mjs')], { encoding: 'utf8' });
put('table.md', table, '`node evals/compile.mjs` stdout (eval-real-*.json since 2026-10-21T11:00Z)', `generated ${new Date().toISOString()}`, `${table.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| task')).length} task x arm rows`);

const md = `# Demo data sources

Written by \`node demo/collect.mjs\` on ${new Date().toISOString()}. The video is rendered from these copies only.
Trial-selection rule: the lowest-numbered trial of each arm (bare trial ${bare.trial}, guarded trial ${guarded.trial}) in the impossible-test result files below.
Kept trial dirs: bare \`${bare.kept}\`, guarded \`${guarded.kept}\`.

| file | source | date | sha256 (16) | note |
|---|---|---|---|---|
${rows.join('\n')}
| \`dashboard-*.png\` | written by \`demo/capture-dashboard.mjs\`: the dashboard's guard-view branch rendering \`orch/verdicts/\` above | see capture log | | |
`;
fs.writeFileSync(path.join(DATA, 'SOURCES.md'), md);
console.log(`collected ${rows.length} files into ${DATA}`);
