// ENGINE-OWNED test reporter (runs in the node --test runner process, never in code under test): per-file test counts for the anti-cheat judge.
// Output (one JSON line, written to the destination file the engine passes): {files: {"<abs file>": {tests, pass, fail, skipped, todo, file_only}}, procs: ["<abs file>"]}.
// "tests" matches node's TAP `# tests` minus the file-level entries node adds for a file that declares no test (file_only: true, tests 0).
// A test's `file` is where test() was CALLED, so a test file that require()s other test files (an aggregator) yields several `files` from ONE process.
// `procs` are the files the runner itself started as test processes (its file-level entries and per-process summaries); the engine matches them to the markers.
import path from 'node:path';
export default async function* (source) {
  const files = {}; const procs = new Set();
  const norm = (f) => String(f).replace(/^file:\/\//, '');
  const isFileEntry = (d, f) => d.nesting === 0 && (d.name === f || d.name === path.basename(f) || d.name === path.relative(process.cwd(), f) || f.endsWith(`/${d.name}`));
  for await (const e of source) {
    const d = e.data || {};
    if (d.file && (e.type === 'test:summary' || isFileEntry(d, norm(d.file)))) procs.add(norm(d.file));
    if (e.type !== 'test:pass' && e.type !== 'test:fail') continue;
    if (!d.file || d.details?.type === 'suite') continue;
    const f = norm(d.file);
    const row = (files[f] ||= { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, file_only: false, _named: 0 });
    if (isFileEntry(d, f) && !d.skip && !d.todo) { row.file_only = true; if (e.type === 'test:fail') row.fail++; continue; }
    row.tests++; row._named++;
    if (d.skip) row.skipped++; else if (d.todo) row.todo++; else if (e.type === 'test:pass') row.pass++;
    if (e.type === 'test:fail') row.fail++;
  }
  for (const r of Object.values(files)) { if (r._named > 0) r.file_only = false; delete r._named; }
  yield `${JSON.stringify({ files, procs: [...procs] })}\n`;
}
