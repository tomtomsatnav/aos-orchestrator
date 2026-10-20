// ENGINE-OWNED test reporter (runs in the node --test runner process, never in code under test): per-file test counts for the anti-cheat judge.
// Output (one JSON line, written to the destination file the engine passes): {"<abs file>": {tests, pass, fail, skipped, todo, file_only}}.
// "tests" matches node's TAP `# tests` minus the file-level entries node adds for a file that declares no test (file_only: true, tests 0).
import path from 'node:path';
export default async function* (source) {
  const files = {};
  for await (const e of source) {
    if (e.type !== 'test:pass' && e.type !== 'test:fail') continue;
    const d = e.data || {}; if (!d.file || d.details?.type === 'suite') continue;
    const f = String(d.file).replace(/^file:\/\//, '');
    const row = (files[f] ||= { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, file_only: false, _named: 0 });
    if (d.nesting === 0 && (d.name === f || d.name === path.basename(f) || d.name === path.relative(process.cwd(), f) || f.endsWith(`/${d.name}`)) && !d.skip && !d.todo) { row.file_only = true; if (e.type === 'test:fail') row.fail++; continue; }
    row.tests++; row._named++;
    if (d.skip) row.skipped++; else if (d.todo) row.todo++; else if (e.type === 'test:pass') row.pass++;
    if (e.type === 'test:fail') row.fail++;
  }
  for (const r of Object.values(files)) { if (r._named > 0) r.file_only = false; delete r._named; }
  yield `${JSON.stringify(files)}\n`;
}
