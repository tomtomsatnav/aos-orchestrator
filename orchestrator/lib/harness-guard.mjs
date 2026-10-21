// Engine side of the test-harness guard (see harness-preload.mjs / harness-reporter.mjs): prepares the guarded argv + env for an engine-run `node --test`
// check, reads the markers and per-file counts afterwards, and judges them. Also: glob expansion for Node < 21 (which does not expand `test/*.test.mjs`
// itself), and the static `harness_tamper` source rule.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { matchGlob } from './glob.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = ['harness-preload.mjs', 'harness-reporter.mjs'];
let cached = null;

/** A read-only copy of the preload + reporter OUTSIDE every worktree (removed at engine exit). -> {dir, preload, reporter}. */
export function guardFiles() {
  if (cached && fs.existsSync(path.join(cached.dir, FILES[1]))) return cached;
  const texts = FILES.map((f) => fs.readFileSync(path.join(HERE, f)));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-guard-')));
  FILES.forEach((f, i) => fs.writeFileSync(path.join(dir, f), texts[i], { mode: 0o444 }));
  fs.chmodSync(dir, 0o555);
  cached = { dir, preload: path.join(dir, FILES[0]), reporter: path.join(dir, FILES[1]) };
  process.once('exit', () => { try { fs.chmodSync(dir, 0o755); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return cached;
}

export const isNodeTest = (argv) => Array.isArray(argv) && path.basename(String(argv[0])) === 'node' && argv.slice(1).includes('--test');

/** Node < 21 does not expand globs in `node --test <glob>`; the engine runs without a shell, so expand them here (same result on 18 and 22). */
export function expandTestGlobs(argv, cwd, major = Number(process.versions.node.split('.')[0])) {
  if (!isNodeTest(argv) || major >= 21) return argv;
  const i = argv.indexOf('--test'); const out = []; let all = null;
  for (const a of argv.slice(i + 1)) {
    if (a.startsWith('-') || !/[*?{[]/.test(a)) { out.push(a); continue; }
    if (!all) { all = []; const walk = (rel) => { let ents; try { ents = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true }); } catch { return; } for (const e of ents) { if (e.name === 'node_modules' || e.name === '.git') continue; const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(r); else if (all.length < 5000) all.push(r); } }; walk(''); }
    const pat = a.replace(/^\.\//, ''); const hits = all.filter((f) => { try { return matchGlob(pat, f); } catch { return false; } }).sort();
    if (hits.length) out.push(...hits); else out.push(a);
  }
  return [...argv.slice(0, i + 1), ...out];
}

/**
 * Prepare a guarded run of a node --test check. -> null (not a node test) or {argv, env, markerDir, nonce, perFile, extraRead, counted}.
 * `tmpBase` must be writable by the check (its private TMPDIR). The caller adds `env` to the child's environment and calls collect() after it exits.
 */
export function prepare(argv, { tmpBase }) {
  if (!isNodeTest(argv)) return null;
  const g = guardFiles();
  const markerDir = fs.mkdtempSync(path.join(tmpBase, 'aos-hg-'));
  const nonce = crypto.randomBytes(16).toString('hex');
  const perFile = path.join(markerDir, 'perfile.json');
  const out = [argv[0], '--import', g.preload, ...argv.slice(1)];
  const reporters = out.filter((a) => a.startsWith('--test-reporter'));
  let counted = false;
  if (reporters.length === 1 && reporters[0] === '--test-reporter=tap') { // the engine's own forced TAP run: add the per-file counter next to it
    out.splice(out.indexOf('--test-reporter=tap') + 1, 0, '--test-reporter-destination=stdout', `--test-reporter=${g.reporter}`, `--test-reporter-destination=${perFile}`); counted = true;
  }
  // the test files named on the command line: each runs as its own process (unless --test-isolation=none runs them all in one)
  const oneProcess = argv.some((a) => /^--(?:experimental-)?test-isolation=none$/.test(a));
  const listed = argv.slice(argv.indexOf('--test') + 1).filter((a) => !a.startsWith('-') && /\.[cm]?[jt]sx?$/.test(a) && !/[*?{[]/.test(a));
  return { argv: out, env: { AOS_GUARD_DIR: markerDir, AOS_GUARD_NONCE: nonce }, markerDir, nonce, perFile, extraRead: g.dir, counted, listed, oneProcess };
}

const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const toRel = (cwd, f) => {
  const cands = [cwd]; try { cands.push(fs.realpathSync(cwd)); } catch { /* gone */ }
  for (const c of cands) { const r = path.relative(c, String(f)); if (!r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/'); }
  return String(f);
};

/**
 * Read what the run left behind. -> {ok, problems[], processes, checked, files: {relPath: {tests, pass, fail, skipped, todo, file_only}} | null}
 * ok=false (harness_tamper) when: no start marker, a start without a valid end, an end that is not ok, a marker with the wrong nonce / unparsable (forged), or
 * fewer test processes than files the reporter saw (a deleted start marker).
 */
export function collect(prep, cwd, { passed = true } = {}) {
  const problems = []; let ents = [];
  try { ents = fs.readdirSync(prep.markerDir); } catch { problems.push('the marker directory is gone'); }
  const starts = new Map(); const ends = new Map(); let checked = 0;
  for (const n of ents) {
    const m = /^(\d+)\.(start|end)$/.exec(n); if (!m) continue;
    const j = readJSON(path.join(prep.markerDir, n));
    if (!j || j.nonce !== prep.nonce || String(j.pid) !== m[1]) { problems.push(`marker ${n} is unparsable or has the wrong nonce (forged)`); continue; }
    (m[2] === 'start' ? starts : ends).set(m[1], j);
  }
  if (!starts.size && passed) problems.push('no test process left a harness marker (the engine preload did not run, or the markers were removed)');
  for (const [pid, s] of starts) {
    const e = ends.get(pid);
    if (!e) { if (passed) problems.push(`${toRel(cwd, s.file)}: no verification marker at exit (killed, or the exit hooks were bypassed)`); continue; }
    checked += e.checked || 0;
    if (!e.ok) problems.push(`${toRel(cwd, s.file)}: ${(e.problems || ['harness tampered']).slice(0, 3).join('; ')}`);
  }
  for (const pid of ends.keys()) if (!starts.has(pid)) problems.push(`end marker without start (pid ${pid})`);
  let files = null; const pf = prep.counted ? readJSON(prep.perFile) : null;
  if (pf && typeof pf === 'object' && pf.files && typeof pf.files === 'object') {
    files = {}; for (const [f, r] of Object.entries(pf.files)) files[toRel(cwd, f)] = r;
    // Every file the runner started as a test process must have left its own start marker (a deleted marker = an unverified process). Test counts are keyed by
    // where test() was called, so a test file that require()s other test files legitimately yields more `files` than processes: match processes, not counts.
    const procs = new Set((Array.isArray(pf.procs) ? pf.procs : []).map((f) => toRel(cwd, f)));
    for (const f of prep.listed || []) { try { if (fs.statSync(path.join(cwd, f)).isFile()) procs.add(toRel(cwd, path.resolve(cwd, f))); } catch { /* not a file: node reports it */ } }
    const marked = new Set([...starts.values()].map((s) => toRel(cwd, s.file)));
    if (passed && !prep.oneProcess) {
      if (procs.size) { for (const f of procs) if (!marked.has(f)) problems.push(`${f}: ran as a test process but left no harness marker (markers were deleted)`); }
      else if (Object.keys(files).length > starts.size) problems.push(`${Object.keys(files).length} test files ran but only ${starts.size} harness markers exist (markers were deleted)`); // no process list from this Node
    }
  }
  return { ok: problems.length === 0, problems: problems.slice(0, 10), processes: starts.size, checked, files };
}

/** Per-file judge: every baseline file must report >= its baseline count and must not have become a file-only entry. -> {ok, kind?, reason?} */
export function judgePerFile(baseFiles, nowFiles) {
  if (!baseFiles || !nowFiles) return { ok: true };
  for (const [f, b] of Object.entries(baseFiles)) {
    if (!b || !(b.tests > 0)) continue;
    const n = nowFiles[f];
    if (!n) return { ok: false, kind: 'tests_reduced', reason: `${f}: ran no tests, the base commit had ${b.tests}` };
    if (n.file_only) return { ok: false, kind: 'tests_reduced', reason: `${f}: declares no test any more (a file-only entry), the base commit had ${b.tests}` };
    if (n.tests < b.tests) return { ok: false, kind: 'tests_reduced', reason: `${f}: ${n.tests} test(s), fewer than the ${b.tests} on the base commit` };
  }
  return { ok: true };
}
/** Compact per-file record kept in goal state. */
export const compactFiles = (files) => (files ? Object.fromEntries(Object.entries(files).slice(0, 500).map(([f, r]) => [f, { tests: r.tests, pass: r.pass, file_only: !!r.file_only }])) : null);

// ---------------------------------------------------------------- static source rule
const TAMPER_RE = /node:assert|node:test|syncBuiltinESMExports|process\.exit\b|process\.reallyExit|Module\._load|require\.cache|globalThis\.process/;
/** New non-test source lines that mention the test harness's internals. files = parseDiff() output. -> [{path, line}] */
export function harnessTamperHits(files, isTest) {
  const out = [];
  for (const f of files) {
    if (f.status === 'D' || isTest(f.path) || !/\.(?:m?js|cjs|jsx|tsx?)$/.test(f.path)) continue;
    for (const l of f.added) if (!/^\s*(?:\/\/|\*|\/\*)/.test(l) && TAMPER_RE.test(l)) { out.push({ path: f.path, line: l.trim().slice(0, 120) }); if (out.length >= 10) return out; }
  }
  return out;
}
