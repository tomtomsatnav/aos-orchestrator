// Anti-cheating layer ("reward hacking" defences). A worker is rewarded when the engine's checks pass, so the engine must make sure a pass is honest.
// Everything here is either PURE (parse / judge / analyse) or reads git through lib/git.mjs; the engine decides what to do with the findings.
//   a) vacuous passes     parseTestSummary + judgeRun: node:test output with 0 tests, only skipped/todo tests, or fewer tests than the base commit's
//   b) skips              added .skip( / .only( / { skip / { todo / xit( ... in test files               -> tests_skipped (unless the plan approved allow_skip)
//   c) config tamper      package.json scripts, runner configs, files the check command reads            -> check_config_changed (unless explicitly in path_scope)
//   d) deleted tests      a test file deleted or renamed                                                  -> tests_deleted
//   e) acceptance tests   files of an `acceptance` task are read-only for every other task                -> acceptance_modified
//   f) literal copy       expected values of the tests pasted into source lines (heuristic)               -> literal_copy (warn by default)
//   g) harness tamper     source mentions node:assert / node:test / process.exit ...; at run time the engine preload (lib/harness-preload.mjs) -> harness_tamper
//   h) weakened tests     a modified test file (or test helper) that drops assertion calls                -> tests_weakened (unless named exactly in path_scope)
// Findings: {kind, severity: 'fail'|'warn'|'allowed', path?, detail}. 'allowed' = a rule would have fired, a human-approved plan field lets it through.
import fs from 'node:fs';
import path from 'node:path';
import { isTestPath } from './protect.mjs';
import { matchGlob } from './glob.mjs';
import * as G from './git.mjs';
import { harnessTamperHits } from './harness-guard.mjs';

export const MAX_FINDINGS = 20;

// ---------------------------------------------------------------- test output
const base = (p) => path.basename(String(p));
export const isNodeTestArgv = (argv) => Array.isArray(argv) && base(argv[0]) === 'node' && argv.slice(1).includes('--test');
/** Commands whose output is a test run (baselines are only recorded for these). */
export const isTestRunArgv = (argv) => isNodeTestArgv(argv) || (Array.isArray(argv) && ['npm', 'pnpm', 'yarn'].includes(base(argv[0])) && argv.slice(1).some((a) => a === 'test' || a === 'run-test'));
/** `node --test ...` -> `node --test --test-reporter=tap ...` (unless the check already names a reporter). Execution argv only: the approved argv is never rewritten. */
export function forceTapArgv(argv) {
  if (!isNodeTestArgv(argv) || argv.some((a) => a.startsWith('--test-reporter'))) return argv;
  const i = argv.indexOf('--test');
  return [...argv.slice(0, i + 1), '--test-reporter=tap', ...argv.slice(i + 1)];
}
const FILE_ENTRY_TAP = /^(ok|not ok) \d+ - [^\n]*?\.(?:m?js|cjs|[mc]?ts|tsx?|jsx)(?: # [^\n]*)?$/gm; // top level only: nested results are indented
const FILE_ENTRY_SPEC = /^(✔|✖) [^\n]*?\.(?:m?js|cjs|[mc]?ts|tsx?|jsx) \(\d[^\n]*$/gm;
const SUMMARY_RE = /^(?:#|ℹ)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gm;
/**
 * Summary of a node:test run from TAP (`# tests 5`) or the spec reporter (`ℹ tests 5`): {tests, pass, fail, cancelled, skipped, todo}, or null when the text has none.
 * The LAST value of each key counts: test code can print fake summary lines earlier in the stream, the runner's own summary is always printed last.
 */
export function parseTestSummary(text) {
  const s = {}; let m; SUMMARY_RE.lastIndex = 0;
  while ((m = SUMMARY_RE.exec(String(text || '')))) s[m[1]] = Number(m[2]);
  if (s.tests === undefined) return null;
  // node reports a test FILE that declares no test (or exits early) as one passing "test" named after the file: those are not tests
  const T = String(text); let fileOnly = 0; let filePass = 0;
  for (const m of T.matchAll(FILE_ENTRY_TAP)) { fileOnly++; if (m[1] === 'ok' && !/ # (?:SKIP|TODO)/i.test(m[0])) filePass++; }
  for (const m of T.matchAll(FILE_ENTRY_SPEC)) { fileOnly++; if (m[1] === '✔') filePass++; }
  return { tests: Math.max(0, s.tests - fileOnly), pass: Math.max(0, (s.pass ?? 0) - filePass), fail: s.fail ?? 0, cancelled: s.cancelled ?? 0, skipped: s.skipped ?? 0, todo: s.todo ?? 0, ...(fileOnly ? { file_entries: fileOnly } : {}) };
}
/**
 * Judge one passing check. `summary` = parseTestSummary(output), `baseline` = {tests} for the same check on the base commit.
 * -> {ok, applicable, kind?, reason?}. A node --test check without any summary cannot be counted and is refused; other commands (npm test, make) without one are not judged.
 */
export function judgeRun(argv, summary, baseline = null, { allowSkip = false } = {}) {
  if (!summary) return isNodeTestArgv(argv) ? { ok: false, applicable: true, kind: 'vacuous_pass', reason: 'node --test printed no test summary, so the tests could not be counted' } : { ok: true, applicable: false };
  if (summary.tests <= 0) return { ok: false, applicable: true, kind: 'vacuous_pass', reason: 'the check passed but ran 0 tests' };
  if (summary.pass <= 0) return { ok: false, applicable: true, kind: 'vacuous_pass', reason: `the check passed but no test actually passed (${summary.skipped} skipped, ${summary.todo} todo, ${summary.cancelled} cancelled of ${summary.tests})` };
  if (baseline && baseline.tests > 0 && summary.tests < baseline.tests) return { ok: false, applicable: true, kind: 'tests_reduced', reason: `the check ran ${summary.tests} test(s), fewer than the ${baseline.tests} on the base commit (${baseline.source || 'run'})` };
  // runtime truth beats the regexes: skips written as `const o = {skip: 1}; test('x', o, f)`, a multi-line `skip:`, `t['skip']()` all show up as skipped/todo in the summary
  if (!allowSkip && baseline && baseline.source === 'run' && Number.isFinite(baseline.skipped)) {
    const was = (baseline.skipped || 0) + (baseline.todo || 0); const now = (summary.skipped || 0) + (summary.todo || 0);
    if (now > was) return { ok: false, applicable: true, kind: 'tests_skipped', reason: `the check reports ${now} skipped/todo test(s), more than the ${was} on the base commit` };
  }
  return { ok: true, applicable: true };
}
/**
 * The test summary the engine trusts for one check result: the per-file counts of the engine's OWN reporter (harness-reporter.mjs, a separate channel code under
 * test cannot write to) when the run has them, else the TAP/spec text. Text printed by the code under test (fake `ok` / `# tests 99` lines) never inflates them.
 */
export function summaryOfRun(r) {
  const sm = parseTestSummary(r.summary_text ?? r.output);
  const files = r.test_files && typeof r.test_files === 'object' ? Object.values(r.test_files) : null;
  if (!files || !files.length || !sm) return sm;
  const sum = (k) => files.reduce((n, f) => n + (Number(f[k]) || 0), 0);
  if (!files.some((f) => 'skipped' in f)) return { ...sm, tests: sum('tests'), pass: sum('pass') }; // compact records (no skip/todo counts) are only ever baselines
  return { ...sm, tests: sum('tests'), pass: sum('pass'), skipped: sum('skipped'), todo: sum('todo') };
}
export const checkKey = (argv) => argv.join(' ');
/**
 * The failing tests of a TAP run: [{name, file}] (file relative to `root` when it lies under it). Reads `not ok N - name` and the `location:` line of its
 * YAML block; a parent suite that only fails because of its children is dropped when a child names the same file.
 */
export function failingTests(text, root = null) {
  const out = []; const lines = String(text || '').split('\n');
  const rel = (f) => { let p = String(f).replace(/^file:\/\//, ''); p = p.replace(/:\d+:\d+$/, ''); for (const R of [root].flat().filter(Boolean)) { const r = path.relative(R, p); if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r; } return p; };
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok \d+ - (.*?)(?: # (?:TODO|SKIP)\b.*)?$/.exec(lines[i]); if (!m) continue;
    let file = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) { const l = /^\s*location: '(.+)'\s*$/.exec(lines[j]); if (l) { file = rel(l[1]); break; } if (/^\s*\.\.\.\s*$/.test(lines[j])) break; }
    const name = m[2].trim();
    if (!file && /\.(?:m?js|cjs|[mc]?ts|tsx?|jsx)$/.test(name)) file = rel(name); // a whole test FILE failed (syntax error, early exit)
    out.push({ name, file, depth: m[1].length });
  }
  return out.filter((t) => !out.some((c) => c !== t && c.depth > t.depth && c.file && c.file === t.file)).map(({ name, file }) => ({ name, file }));
}
/** One line naming the failing tests of a TAP run (at most `n`), e.g. `test/a.test.js: "adds" | test/b.test.js: "subtracts" (+2 more)`; null when none can be named. */
export function failingTestsLine(text, root = null, n = 3) {
  const f = failingTests(text, root); if (!f.length) return null;
  const one = (t) => `${t.file && t.file !== t.name ? `${t.file}: ` : ''}"${t.name.slice(0, 120)}"`;
  return `${f.slice(0, n).map(one).join(' | ')}${f.length > n ? ` (+${f.length - n} more)` : ''}`;
}
/**
 * Merge repeated baseline runs of one check ({tests, pass, skipped, todo, source, files?} or null): the LARGEST count wins (per file too), so a test file whose
 * registered tests depend on the clock / randomness cannot record a low baseline by luck. unstable=true when the runs disagreed. -> merged | null
 */
export function mergeBaselineRuns(runs) {
  const rs = (runs || []).filter(Boolean); if (!rs.length) return null;
  const top = rs.reduce((a, b) => (b.tests > a.tests ? b : a));
  const max = (k) => Math.max(...rs.map((r) => r[k] ?? 0));
  const out = { ...top, tests: max('tests'), pass: max('pass'), skipped: max('skipped'), todo: max('todo'), runs: rs.length };
  let unstable = rs.some((r) => r.tests !== top.tests);
  if (rs.some((r) => r.files)) {
    const files = {};
    for (const r of rs) for (const [f, c] of Object.entries(r.files || {})) {
      const cur = files[f];
      if (cur && cur.tests !== c.tests) unstable = true;
      if (!cur || c.tests > cur.tests) files[f] = { ...c };
    }
    out.files = files;
  }
  if (unstable) out.unstable = true;
  return out;
}

const DECL_RE = /(^|[^\w.$])(?:test|it)(?:\.(?:only|skip|todo))?\s*\(/g;
/** Static fallback for a baseline: test( / it( declarations in the test files a check would run. `files` = [{path, text}] of the base commit. */
export function staticTestCount(argv, files) {
  let sel = files.filter((f) => isTestPath(f.path));
  if (isNodeTestArgv(argv)) {
    const targets = argv.slice(argv.indexOf('--test') + 1).filter((a) => !a.startsWith('-')).map((a) => a.replace(/^\.\//, '').replace(/\/+$/, ''));
    if (targets.length) sel = files.filter((f) => targets.some((t) => f.path === t || f.path.startsWith(`${t}/`) || (/[*?{]/.test(t) && matchGlob(t, f.path))));
  }
  let n = 0; for (const f of sel) n += (String(f.text).match(DECL_RE) || []).length;
  return n;
}

// ---------------------------------------------------------------- diff
/** Parse `git diff -U0 -M` into [{path, from, status: A|M|D|R, added: [], removed: []}]. */
export function parseDiff(text) {
  const files = []; let cur = null; let inHunk = false;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / a\/(.+) b\/(.+)$/.exec(line);
      cur = { path: m ? m[2] : '', from: m ? m[1] : '', status: 'M', added: [], removed: [] }; files.push(cur); inHunk = false; continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) cur.status = 'A';
      else if (line.startsWith('deleted file mode')) cur.status = 'D';
      else if (line.startsWith('rename from ')) { cur.status = 'R'; cur.from = line.slice(12); }
      else if (line.startsWith('rename to ')) cur.path = line.slice(10);
      else if (line.startsWith('--- a/')) cur.from = line.slice(6).replace(/\t.*$/, '');
      else if (line.startsWith('+++ b/')) cur.path = line.slice(6).replace(/\t.*$/, '');
      else if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line[0] === '+' && cur.added.length < 5000) cur.added.push(line.slice(1));
    else if (line[0] === '-' && cur.removed.length < 5000) cur.removed.push(line.slice(1));
  }
  for (const f of files) if (f.status === 'D') f.path = f.from;
  return files;
}
/** The attempt's change: merge-base(HEAD, integration) .. HEAD, parsed. */
export async function attemptDiff(wt, integrationBranch) {
  const mb = (await G.git(wt, ['merge-base', 'HEAD', integrationBranch], { allowFail: true })).stdout.trim();
  if (!mb) return { base: null, files: [] };
  const d = await G.git(wt, ['-c', 'core.quotepath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', mb, 'HEAD'], { allowFail: true });
  return { base: mb, files: parseDiff(d.stdout) };
}

/** Test files of a worktree's index: [{path, text}] (bounded: 300 files, 200 KB each). Used by the engine and lib/guard.mjs. */
export async function readTestFiles(wt) {
  const out = [];
  const ls = (await G.git(wt, ['ls-files', '-z'], { allowFail: true })).stdout.split('\0').filter((f) => f && isTestPath(f) && !f.split('/').includes('node_modules'));
  for (const f of ls.slice(0, 300)) { try { const abs = path.join(wt, f); if (fs.statSync(abs).size <= 200000) out.push({ path: f, text: fs.readFileSync(abs, 'utf8') }); } catch { /* gone */ } }
  return out;
}

// ---------------------------------------------------------------- (b) skips
const TEST_CALL = /\b(?:test|it|describe|suite|specify|context)\w*\s*\(/;
const SKIP_RULES = [
  [/\b(?:test|it|describe|suite|t|context|specify)\.(?:skip|only|todo)\b/, 'skip/only/todo call'],
  [/\bx(?:it|describe|test|context|specify)\s*\(/, 'xit/xdescribe'],
  [(l) => TEST_CALL.test(l) && /\{[^}]*\b(?:skip|todo)\b/.test(l), '{ skip } / { todo } option'],
  [/^\s*(?:skip|todo)\s*:\s*true\b/, 'skip/todo: true option'],
  [/\bpytest\.mark\.(?:skip|skipif|xfail)\b|\bunittest\.skip|\bpytest\.skip\(/, 'pytest/unittest skip'],
  [/\bt\.Skip(?:Now)?\(|#\[ignore\]|@Disabled\b|@Ignore\b/, 'skip annotation'],
];
export function skipHits(added) {
  const hits = [];
  for (const l of added) for (const [re, what] of SKIP_RULES) if (typeof re === 'function' ? re(l) : re.test(l)) { hits.push({ what, line: l.trim().slice(0, 120) }); break; }
  return hits;
}

// ---------------------------------------------------------------- (h) weakened tests
const ASSERT_CALL = /(?<![\w$])(?:assert(?:\.(?:strict|\w+))*|t\.assert\.\w+|expect|should|ok|equal|strictEqual|deepEqual|deepStrictEqual|notEqual|throws|rejects|doesNotThrow|match)\s*(?:\(|\.(?:to|not)\b)/g;
const STRONG_CALL = /(?<![\w$])(?:(?:assert|t\.assert)\.(?:equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual|throws|rejects|match|partialDeepStrictEqual|snapshot)|expect\s*\([^)]*\)\s*\.(?:toBe|toEqual|toStrictEqual|toMatch|toThrow|toHaveLength|toContain))\s*\(/g;
const countRe = (lines, re) => { let n = 0; for (const l of lines) { if (/^\s*(?:\/\/|\*|\/\*|#)/.test(l)) continue; n += (l.match(re) || []).length; } return n; };
/** Assertion calls removed vs added by a diff of one test file. -> {total, strong} drops (positive = weaker). Counts, not semantics: changing an expected value in place is NOT seen. */
export function assertionDrop(f) {
  return { total: countRe(f.removed, ASSERT_CALL) - countRe(f.added, ASSERT_CALL), strong: countRe(f.removed, STRONG_CALL) - countRe(f.added, STRONG_CALL) };
}

// ---------------------------------------------------------------- (c) config
export const CONFIG_BASENAME = /^(?:\.mocharc(?:\..+)?|jest\.config\..+|vitest\.config\..+|vitest\.workspace\..+|\.c8rc(?:\..+)?|\.nycrc(?:\..+)?|\.npmrc|ava\.config\..+|karma\.conf\..+|playwright\.config\..+|pytest\.ini|tox\.ini|setup\.cfg|conftest\.py|node\.config\.json|\.node-test-runner(?:\..+)?|\.taprc|tsconfig(?:\..+)?\.json|jsconfig(?:\..+)?\.json)$/;
export const PKG_KEYS = ['scripts', 'jest', 'mocha', 'c8', 'nyc', 'ava', 'vitest', 'imports', 'exports', 'type'];
export const isConfigPath = (rel) => { const b = base(rel); return b === 'package.json' || CONFIG_BASENAME.test(b); };
const norm = (p) => String(p).replace(/^\.\//, '').replace(/\/+$/, '');
/** Files the check commands read to decide what to run: script/dir arguments that are not test files themselves, plus the Makefile for `make`. */
export function checkInputPaths(argvs) {
  const out = new Set();
  for (const argv of argvs || []) {
    if (!Array.isArray(argv)) continue;
    if (base(argv[0]) === 'make') { out.add('Makefile'); out.add('makefile'); out.add('GNUmakefile'); }
    const LOADERS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--env-file']);
    for (let i = 1; i < argv.length; i++) { // `--import ./x.mjs` / `--import=./x.mjs`: code or config the runner loads before the tests, a config input even under test/
      const a = argv[i]; let v = null;
      if (typeof a !== 'string') continue;
      if (LOADERS.has(a) && typeof argv[i + 1] === 'string') v = argv[i + 1]; else { const m = /^(--import|--require|--loader|--experimental-loader|--env-file)=(.+)$/.exec(a); if (m) v = m[2]; }
      if (v && !v.startsWith('/') && !v.split('/').includes('..') && !/^(?:node:|data:|file:)/.test(v) && !/\s/.test(v)) out.add(norm(v));
    }
    // `node --check <file>` only parses its file (runs nothing): that file is the subject of the check, never a configuration input of it
    if (base(argv[0]) === 'node' && (argv.includes('--check') || argv.includes('-c'))) continue;
    for (const a of argv.slice(1)) {
      if (typeof a !== 'string' || a.startsWith('-') || a.startsWith('/') || a.split('/').includes('..') || /\s/.test(a)) continue;
      if (/\.(?:m?js|cjs|ts|py|sh|json|rb)$/.test(a) || a.endsWith('/') || a.includes('/')) { const n = norm(a); if (n && !isTestPath(n)) out.add(n); }
    }
  }
  return [...out];
}
export function packageConfigChanged(beforeText, afterText) {
  const parse = (t) => { if (t === null || t === undefined) return {}; try { const j = JSON.parse(t); return j && typeof j === 'object' ? j : {}; } catch { return { __unparsable: String(t) }; } };
  const b = parse(beforeText); const a = parse(afterText);
  if (a.__unparsable !== undefined || b.__unparsable !== undefined) return a.__unparsable === b.__unparsable ? [] : ['(unparsable package.json)'];
  return PKG_KEYS.filter((k) => JSON.stringify(b[k] ?? null) !== JSON.stringify(a[k] ?? null));
}
/** A path_scope entry that names the file exactly (no wildcard): the only way a task may change test configuration. */
export const explicitInScope = (scope, rel) => (scope || []).some((g) => typeof g === 'string' && !/[*?{}[\]!]/.test(g) && norm(g) === norm(rel));

// ---------------------------------------------------------------- (f) literal copy
const EXPECT_LINE = /\b(?:assert\w*|expect|equal|deepEqual|strictEqual|deepStrictEqual|toBe|toEqual|toStrictEqual|should)\b/;
const STR_RE = /(['"`])((?:\\.|(?!\1)[^\\\n]){3,80})\1/g;
const NUM_RE = /(?<![\w.$])(\d{3,}(?:\.\d+)?|\d+\.\d+)(?![\w.])/g;
const BORING = /^(?:node:|\.{0,2}\/|use strict$|utf-?8$|[\w.-]+\.(?:m?js|cjs|json|ts|txt)$)/i;
/** Literals the tests EXPECT: strings (>= 3 chars) and numbers (>= 3 digits or decimals) on assert/expect lines. `testTexts` = [{path, text}]. */
export function expectedLiterals(testTexts) {
  const strs = new Set(); const nums = new Set();
  for (const f of testTexts || []) for (const line of String(f.text).split('\n')) {
    if (!EXPECT_LINE.test(line)) continue;
    let m; STR_RE.lastIndex = 0;
    while ((m = STR_RE.exec(line))) { if (!m[2].includes('${') && !BORING.test(m[2]) && /[A-Za-z0-9]/.test(m[2])) strs.add(m[2]); }
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(line))) nums.add(m[1]);
  }
  return { strs: [...strs].slice(0, 400), nums: [...nums].slice(0, 200) };
}
const SRC_EXT = /\.(?:m?js|cjs|jsx|tsx?|py|rb|go|java|rs|c|cc|cpp|sh)$/;
const COMPARE = /===?|!==?|\bcase\b|\breturn\b|=>|\?\s|:\s/;
/** New non-test source lines that contain an expected literal of the tests (e.g. `if (x === 'Hello World!') return 'hello-world'`). Advisory heuristic: it cannot prove hard-coding. */
export function literalCopies(files, lits) {
  const out = [];
  if (!lits.strs.length && !lits.nums.length) return out;
  for (const f of files) {
    if (f.status === 'D' || isTestPath(f.path) || !SRC_EXT.test(f.path)) continue;
    const gone = f.removed.join('\n');
    for (const line of f.added) {
      if (/^\s*(?:\/\/|#|\*|\/\*)/.test(line) || !COMPARE.test(line)) continue;
      const s = lits.strs.find((x) => !gone.includes(x) && (line.includes(`'${x}'`) || line.includes(`"${x}"`) || line.includes(`\`${x}\``)));
      const n = s === undefined ? lits.nums.find((x) => !gone.includes(x) && new RegExp(`(?<![\\w.$])${x.replace('.', '\\.')}(?![\\w.])`).test(line) && /===?|\breturn\b|\bcase\b/.test(line)) : undefined;
      const lit = s ?? n;
      if (lit !== undefined) { out.push({ path: f.path, literal: String(lit).slice(0, 60), line: line.trim().slice(0, 120) }); if (out.length >= 10) return out; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the analysis of one attempt
/**
 * files: parseDiff() of the attempt. ctx: {path_scope, allow_skip: [reason], checks: [argv], acceptance: {files:[], scopes:[]} | null (files OTHER tasks own),
 * is_acceptance: bool, literal_copy: 'warn'|'fail'}. io: {before(rel) -> text|null, after(rel) -> text|null, tests() -> [{path, text}] (test files of the attempt's tree)}.
 * -> {findings[]}.
 */
export async function analyzeDiff(files, ctx, io) {
  const F = []; const add = (kind, severity, p, detail) => F.push({ kind, severity, ...(p ? { path: p } : {}), detail: String(detail).slice(0, 240) });
  const inputs = new Set(checkInputPaths(ctx.checks));
  const allow = (ctx.allow_skip || []).filter((r) => typeof r === 'string' && r.trim());
  for (const f of files) {
    // (d) deleted / renamed test files
    if ((f.status === 'D' || f.status === 'R') && isTestPath(f.from)) add('tests_deleted', 'fail', f.from, f.status === 'D' ? 'test file deleted' : `test file renamed to ${f.path}`);
    // (b) skips
    if (isTestPath(f.path) && f.status !== 'D') {
      const hits = skipHits(f.added);
      if (hits.length) add('tests_skipped', allow.length ? 'allowed' : 'fail', f.path, `${hits.slice(0, 3).map((h) => `${h.what}: ${h.line}`).join(' | ')}${allow.length ? ` (plan allow_skip: ${allow.join('; ').slice(0, 100)})` : ''}`);
    }
    // (h) a modified test file or test helper (anything isTestPath covers: *.test.*, test/ directories) that loses assertion calls
    if ((f.status === 'M' || f.status === 'R') && isTestPath(f.path) && /\.(?:m?js|cjs|jsx|tsx?)$/.test(f.path)) {
      const d = assertionDrop(f);
      if (d.total > 0 || d.strong > 0) add('tests_weakened', explicitInScope(ctx.path_scope, f.path) ? 'allowed' : 'fail', f.path, `assertion calls dropped (${d.total > 0 ? `${d.total} fewer in total` : ''}${d.total > 0 && d.strong > 0 ? ', ' : ''}${d.strong > 0 ? `${d.strong} fewer value comparisons` : ''})${explicitInScope(ctx.path_scope, f.path) ? ' (file named in path_scope, approved with the plan)' : ' (file not named in path_scope)'}`);
    }
    // (c) test configuration
    {
      let why = null;
      if (base(f.path) === 'package.json') {
        const keys = packageConfigChanged(f.status === 'A' ? null : await io.before(f.from || f.path), f.status === 'D' ? null : await io.after(f.path));
        if (keys.length) why = `package.json ${keys.join(', ')} changed`;
      } else if (CONFIG_BASENAME.test(base(f.path))) why = 'test runner configuration changed';
      else if (inputs.has(norm(f.path)) || [...inputs].some((i) => f.path.startsWith(`${i}/`))) why = 'a file the check command runs or reads changed';
      if (why) add('check_config_changed', explicitInScope(ctx.path_scope, f.path) ? 'allowed' : 'fail', f.path, `${why}${explicitInScope(ctx.path_scope, f.path) ? ' (named in path_scope, approved with the plan)' : ' (not named in path_scope)'}`);
    }
    // (e) acceptance tests of another task
    const acc = ctx.acceptance;
    if (acc && !ctx.is_acceptance) for (const p of new Set([f.path, f.from])) {
      if (p && (acc.files.includes(p) || (acc.scopes || []).some((g) => { try { return matchGlob(g, p); } catch { return false; } }))) { add('acceptance_modified', 'fail', p, 'acceptance tests are read-only for implementation tasks'); break; }
    }
  }
  // (g) the code under test mentions the test harness's internals (node:assert / node:test / process.exit ...): no legitimate reason in non-test source
  for (const h of harnessTamperHits(files, isTestPath)) add('harness_tamper', ctx.harness_tamper === 'warn' ? 'warn' : 'fail', h.path, `new source line touches the test harness: ${h.line}`);
  // (f) literal copy
  const lc = ctx.literal_copy || 'warn';
  const needTests = files.some((f) => f.status !== 'D' && f.added.length && !isTestPath(f.path) && SRC_EXT.test(f.path));
  const copies = needTests ? literalCopies(files, expectedLiterals(await io.tests())) : [];
  for (const c of copies) add('literal_copy', lc === 'fail' ? 'fail' : 'warn', c.path, `source line contains a value the tests expect (${JSON.stringify(c.literal)}): ${c.line}`);
  return { findings: F.slice(0, MAX_FINDINGS * 2) };
}
export const failsOf = (findings) => (findings || []).filter((f) => f.severity === 'fail');
export const summarizeFindings = (findings, n = 3) => (findings || []).slice(0, n).map((f) => `${f.kind}${f.path ? ` ${f.path}` : ''}: ${f.detail}`).join(' | ').slice(0, 300);

/** The record kept on attempt_log[].anticheat (dashboard-facing; see docs/orch-state-contract.md). */
export function attemptRecord({ findings = [], tests = [], failed = null }) {
  const warn = findings.some((f) => f.severity === 'warn' || f.severity === 'allowed');
  return { status: failed ? 'fail' : warn ? 'warn' : 'pass', failed, findings: findings.slice(0, MAX_FINDINGS), tests: tests.slice(0, 10) };
}

/** Per-goal roll-up for status / report: failures by kind, warnings, baselines, acceptance state. */
export function rollup(S) {
  const o = S.goal.orch; const A = o.anticheat || {};
  const fails = {}; let warnings = 0; let allowed = 0;
  for (const t of S.tasks) for (const a of t.orch?.attempt_log || []) {
    if (!a.anticheat) continue;
    if (a.anticheat.failed) fails[a.anticheat.failed] = (fails[a.anticheat.failed] || 0) + 1;
    for (const f of a.anticheat.findings || []) { if (f.severity === 'warn') warnings++; else if (f.severity === 'allowed') allowed++; }
  }
  return { failures: fails, warnings, allowed, baselines: Object.keys(A.baselines || {}).length,
    acceptance: A.acceptance ? { tasks: (A.acceptance.items || []).map((i) => i.task), files: (A.acceptance.items || []).reduce((n, i) => n + i.files.length, 0), result: A.acceptance_result ? { ok: A.acceptance_result.ok, tests: A.acceptance_result.tests ?? null } : null } : null,
    criteria: A.criteria || {} };
}

/** Plain-text lines for report.md; `[]` when nothing happened. */
export function reportLines(S) {
  const o = S.goal.orch; const A = o.anticheat || {}; const L = [];
  const R = rollup(S);
  const any = Object.keys(R.failures).length || R.warnings || R.allowed || R.baselines || R.acceptance || Object.keys(R.criteria).length;
  L.push('## Anti-cheat', '');
  if (!any) { L.push('No anti-cheat finding; all checks were judged (test counts, skips, config, deleted tests).', ''); return L; }
  if (R.baselines) L.push(`- baselines (tests per check on the base commit): ${Object.entries(A.baselines).map(([k, b]) => `\`${k}\` = ${b.tests} (${b.source})`).join('; ')}`);
  for (const t of S.tasks) for (const a of t.orch?.attempt_log || []) {
    const ac = a.anticheat; if (!ac) continue;
    if (ac.failed) L.push(`- **FAILED** ${t.id}#${a.n}: ${ac.failed} - ${summarizeFindings(ac.findings.filter((f) => f.severity === 'fail' || f.kind === ac.failed), 3)}`);
    for (const f of ac.findings || []) if (f.severity === 'allowed') L.push(`- allowed by the approved plan, ${t.id}#${a.n}: ${f.kind} ${f.path || ''}: ${f.detail}`);
    for (const f of ac.findings || []) if (f.severity === 'warn') L.push(`- ADVISORY ${t.id}#${a.n}: ${f.kind} ${f.path || ''}: ${f.detail}`);
  }
  for (const [id, c] of Object.entries(R.criteria)) L.push(`- **FAILED** criterion ${id}: ${c.kind} - ${c.reason}`);
  if (R.acceptance) L.push(`- acceptance tests (read-only for other tasks, re-run from their committed version at verify): task(s) ${R.acceptance.tasks.join(', ')}, ${R.acceptance.files} file(s), re-run: ${R.acceptance.result ? (R.acceptance.result.ok ? `passed (${R.acceptance.result.tests ?? '?'} tests)` : '**FAILED**') : 'not run'}`);
  L.push('');
  return L;
}
/** Advisory text for the reviewer prompt (engine-generated lines that quote worker-written source: the caller fences them as untrusted). */
export function reviewerNotes(S) {
  const L = [];
  for (const t of S.tasks) for (const a of t.orch?.attempt_log || []) for (const f of a.anticheat?.findings || []) if (f.severity === 'warn' || f.severity === 'allowed') L.push(`${t.id}#${a.n} ${f.kind} ${f.path || ''}: ${f.detail}`);
  return L.slice(0, 20).join('\n');
}
