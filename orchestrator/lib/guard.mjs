// Guard mode: judge a finished tree (any agent's work, no orchestration) against its base commit with the engine's own guardrails.
//   1. the tree is copied into a private scratch git repo (bounded; the agent's .git, hooks and config are never used to run anything)
//   2. anti-cheat diff analysis of base..tree (lib/anticheat.mjs analyzeDiff: deleted / skipped / weakened tests, config tamper, harness tamper, literal copy)
//   3. the checks run on the tree, sandboxed (lib/checks.mjs runChecks + lib/sandbox.mjs; fails closed without a sandbox unless `unsandboxed`), judged against
//      baselines recorded on the base commit (judgeRun / judgePerFile: vacuous passes, fewer tests, more skips, harness tamper); the checks must not modify the tree
//   4. the ORIGINAL test files of the base commit (lib/protect.mjs listTestFiles + runnerFor) are written over the tree and re-run, as the engine does at goal verify
// Nothing in the tree is executed except through the sandboxed check path. Result: {accepted, reasons[], rejections[{kind, detail}], integrity, failing_tests[],
// anticheat: {findings[], warnings[]}, checks[], protected, base, files}.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import * as G from './git.mjs';
import { runChecks, runCheck, checkEnv, tail, commandAllowed } from './checks.mjs';
import { sandboxAvailable, DEFAULT_SANDBOX_BIN } from './sandbox.mjs';
import { listTestFiles, runnerFor } from './protect.mjs';
import { attemptDiff, analyzeDiff, failsOf, forceTapArgv, parseTestSummary, summaryOfRun, mergeBaselineRuns, judgeRun, checkKey, isTestRunArgv, staticTestCount, failingTests, failingTestsLine, readTestFiles } from './anticheat.mjs';
import * as HG from './harness-guard.mjs';
import { PROFILES } from './profiles.mjs';
import { DEFAULT_RULES } from './rules.mjs';

export const LIMITS = Object.freeze({ files: 5000, file_bytes: 10 * 1024 * 1024, total_bytes: 200 * 1024 * 1024 });
const BASELINE_RUNS = 2; // as the engine: the larger of two base-commit counts wins
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']; // git in the agent's repo: its config was writable by the agent
/** Rejection kinds that are integrity failures (the agent changed the yardstick), as opposed to capability failures (the work is not done). */
export const INTEGRITY_KINDS = new Set(['tests_deleted', 'tests_skipped', 'tests_weakened', 'tests_edited', 'tests_reduced', 'check_config_changed', 'harness_tamper', 'vacuous_pass', 'acceptance_modified', 'literal_copy', 'worktree_mutated_during_checks']);
export const CAPABILITY_KINDS = new Set(['check_failed', 'protected_tests_failed']);

const gitRaw = (cwd, args, { encoding = 'utf8', maxBuffer = 32 * 1024 * 1024 } = {}) => new Promise((resolve, reject) => execFile('git', [...SAFE, ...args], { cwd, env: G.gitEnv(), encoding, maxBuffer, timeout: 120000 }, (err, out) => (err ? reject(new Error(`git ${args[0]} failed: ${String(err.code ?? err.message).slice(0, 120)}`)) : resolve(out))));

/** The rules for a profile name (or a rules object): {allowlist[], max_timeout_s}. */
export function rulesFor(profile) {
  const r = typeof profile === 'object' && profile ? profile : PROFILES[profile || 'strict'];
  if (profile && typeof profile === 'string' && !(profile in PROFILES)) throw new Error(`unknown profile ${profile} (have: ${Object.keys(PROFILES).join(', ')})`);
  const c = { ...DEFAULT_RULES.checks, ...(r?.checks || {}) };
  return { allowlist: (c.allowlist || []).map((e) => (typeof e === 'string' ? e : e.cmd)), max_timeout_s: c.max_timeout_s, literal_copy: c.literal_copy === 'fail' ? 'fail' : 'warn', harness_tamper: c.harness_tamper === 'warn' ? 'warn' : 'fail', protect_existing_tests: c.protect_existing_tests !== false };
}

/** The test command the rules allow and the base commit can run: `node --test` (JS repo), else `npm test` (package.json has a test script), else none. */
export async function defaultChecks(repo, base, profile) {
  const { allowlist } = rulesFor(profile);
  const sha = await resolveBase(repo, base);
  const pkg = await G.showBlob(repo, sha, 'package.json', { maxBytes: 1024 * 1024 }).catch(() => null);
  const tests = (await listTestFiles(repo, sha)).files;
  if (commandAllowed(['node', '--test'], allowlist) && (pkg || runnerFor(tests).js.length)) return [{ argv: ['node', '--test'], timeout_s: 300 }];
  let scripts = null; try { scripts = JSON.parse(String(pkg)).scripts; } catch { /* none */ }
  if (commandAllowed(['npm', 'test'], allowlist) && scripts && typeof scripts.test === 'string') return [{ argv: ['npm', 'test'], timeout_s: 300 }];
  return [];
}

async function resolveBase(repo, base) {
  if (!/^[\w./@^~-]{1,200}$/.test(String(base)) || String(base).startsWith('-')) throw new Error(`invalid base ref ${JSON.stringify(String(base).slice(0, 60))}`);
  return String(await gitRaw(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])).trim();
}

/** Extract `ref` of `repo` (git archive, bounded) into `dest`. */
async function extractRef(repo, ref, dest, tarFile) {
  // `git archive` runs filter.<name>.smudge/process drivers named by the tree's .gitattributes: blank every driver the repo config defines
  const names = new Set(String(await gitRaw(repo, ['config', '--name-only', '--get-regexp', '^filter\\.']).catch(() => '')).split('\n').map((l) => /^(filter\..+)\.[^.]+$/.exec(l)?.[1]).filter(Boolean));
  const blank = [...names].flatMap((n) => ['smudge', 'clean', 'process', 'required'].flatMap((k) => ['-c', `${n}.${k}=${k === 'required' ? 'false' : ''}`]));
  await gitRaw(repo, [...blank, 'archive', '--format=tar', '-o', tarFile, ref]);
  if (fs.statSync(tarFile).size > LIMITS.total_bytes) throw new Error(`the tree of ${ref} is larger than ${LIMITS.total_bytes} bytes`);
  await new Promise((resolve, reject) => execFile('tar', ['-xf', tarFile, '-C', dest], { timeout: 120000 }, (e) => (e ? reject(new Error(`tar failed: ${e.message.slice(0, 120)}`)) : resolve())));
  fs.rmSync(tarFile, { force: true });
}

/** Copy a working tree (no .git, no node_modules; symlinks kept only when relative and inside the tree), bounded. -> {files, bytes} */
function copyWorkingTree(src, dest) {
  let files = 0; let bytes = 0;
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const r = rel ? path.join(rel, e.name) : e.name; const from = path.join(src, r); const to = path.join(dest, r);
      const st = fs.lstatSync(from);
      if (st.isDirectory()) { fs.mkdirSync(to, { recursive: true }); walk(r); continue; }
      if (++files > LIMITS.files) throw new Error(`the tree has more than ${LIMITS.files} files`);
      if (st.isSymbolicLink()) {
        const t = fs.readlinkSync(from);
        if (path.isAbsolute(t) || path.normalize(path.join(path.dirname(r), t)).split(path.sep)[0] === '..') throw new Error(`${r} is a symlink that points outside the tree`);
        fs.symlinkSync(t, to); continue;
      }
      if (!st.isFile()) continue; // sockets, fifos
      if (st.size > LIMITS.file_bytes) throw new Error(`${r} is larger than ${LIMITS.file_bytes} bytes`);
      if ((bytes += st.size) > LIMITS.total_bytes) throw new Error(`the tree is larger than ${LIMITS.total_bytes} bytes`);
      fs.copyFileSync(from, to); fs.chmodSync(to, st.mode & 0o755);
    }
  };
  walk('');
  return { files, bytes };
}
const emptyDir = (d) => { for (const n of fs.readdirSync(d)) if (n !== '.git') fs.rmSync(path.join(d, n), { recursive: true, force: true }); };

/**
 * opts: {repo, base='main', tree=null (null: the repo's working tree incl. untracked files; else a commit-ish of repo), checks=[{argv, timeout_s}] (default: defaultChecks),
 * profile='node-library' | rules object, allowlist? (extra allowed commands; the given checks are always allowed, like success criteria in the engine),
 * unsandboxed=false (the orch.unsandboxed_checks opt-out), sandboxBin?, env=process.env}
 */
export async function verifyTree(opts) {
  const { repo, base = 'main', tree = null, profile = 'node-library', unsandboxed = false, env = process.env } = opts;
  const sandboxBin = opts.sandboxBin || DEFAULT_SANDBOX_BIN;
  const R = rulesFor(profile);
  const res = { accepted: false, reasons: [], rejections: [], integrity: false, failing_tests: [], anticheat: { findings: [], warnings: [] }, checks: [], protected: null, base: null, files: [], sandboxed: !unsandboxed };
  const reject = (kind, detail) => { res.rejections.push({ kind, detail: String(detail).slice(0, 600) }); res.reasons.push(`${kind}: ${String(detail).slice(0, 600)}`); };
  const done = () => { res.integrity = res.rejections.some((r) => INTEGRITY_KINDS.has(r.kind)); res.accepted = res.rejections.length === 0; return res; };
  if (!unsandboxed) { const av = sandboxAvailable({ bin: sandboxBin }); if (!av.ok) { reject('sandbox_unavailable', `OS sandbox unavailable (${av.reason}): refusing to run checks on agent-written code unsandboxed; pass unsandboxed (--unsandboxed-checks) to override`); return done(); } }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-verify-')));
  const S = path.join(root, 'tree'); const tmp = path.join(root, 'tmp'); fs.mkdirSync(S); fs.mkdirSync(tmp, { mode: 0o700 });
  let n = 0; const tmpFor = (name) => { const d = path.join(tmp, `${name}-${n++}`); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
  const sbx = (name) => ({ sandbox: { worktree: S, tmpDir: tmpFor(name), home: env.HOME, profileDir: path.join(root, 'sandbox') }, sandboxBin, unsandboxed, harnessMode: R.harness_tamper });
  const cenv = (name) => checkEnv({ base: env, tmpDir: tmpFor(`${name}-env`) });
  try {
    // ---- 1. scratch repo: base commit on branch guard-base, the tree as one commit on top of it
    let sha;
    try { sha = await resolveBase(repo, base); } catch (e) { reject('bad_base', `cannot resolve base ${base} in ${repo}: ${e.message}`); return done(); }
    res.base = sha;
    await G.git(S, ['init', '-q', '-b', 'guard-base']);
    try { await extractRef(repo, sha, S, path.join(root, 'base.tar')); } catch (e) { reject('tree_unreadable', `base: ${e.message}`); return done(); }
    await G.git(S, ['add', '-A', '-f']); await G.git(S, ['commit', '-q', '--allow-empty', '-m', 'base']);
    const baseSha = await G.head(S);
    await G.git(S, ['checkout', '-q', '-b', 'guard-tree']);
    emptyDir(S);
    try {
      if (tree) { await extractRef(repo, String(await gitRaw(repo, ['rev-parse', '--verify', '--quiet', `${tree}^{commit}`])).trim(), S, path.join(root, 'tree.tar')); await G.git(S, ['add', '-A', '-f']); }
      else { copyWorkingTree(repo, S); await G.git(S, ['add', '-A']); await G.git(S, ['clean', '-fdxq']); } // ignored untracked files do not count (and are not run)
    } catch (e) { reject('tree_unreadable', e.message); return done(); }
    await G.git(S, ['commit', '-q', '--allow-empty', '-m', 'tree']);
    const checks = (opts.checks && opts.checks.length ? opts.checks : await defaultChecks(S, baseSha, profile)).map((c) => ({ argv: c.argv, timeout_s: Math.min(c.timeout_s || 300, R.max_timeout_s || 600) }));
    const allowlist = [...R.allowlist, ...(opts.allowlist || []), ...checks.map((c) => c.argv)];
    const protectedFiles = R.protect_existing_tests ? (await listTestFiles(S, baseSha)).files : [];
    const { js: protJs, other: protOther } = runnerFor(protectedFiles);

    // ---- 2. baselines on the base commit (as the engine's _ensureBaselines / _ensureProtectedCounts)
    await G.git(S, ['checkout', '-q', 'guard-base']);
    const baselines = {};
    for (const c of checks.filter((x) => isTestRunArgv(x.argv))) {
      const runs = [];
      for (let i = 0; i < BASELINE_RUNS; i++) {
        try { const r = await runCheck({ argv: forceTapArgv(c.argv), timeout_s: c.timeout_s }, { cwd: S, env: cenv('baseline'), ...sbx('baseline') }); const sm = r.rejected ? null : summaryOfRun(r);
          runs.push(sm ? { tests: sm.tests, pass: sm.pass, skipped: sm.skipped, todo: sm.todo, source: 'run', ...(r.test_files ? { files: HG.compactFiles(r.test_files) } : {}) } : null);
        } catch { runs.push(null); } finally { await G.discardChanges(S).catch(() => {}); }
        if (!runs[i]) break;
      }
      baselines[checkKey(c.argv)] = mergeBaselineRuns(runs) || { tests: staticTestCount(c.argv, await readTestFiles(S)), source: 'static' };
    }
    let protCounts = null;
    if (protJs.length) {
      const runs = [];
      for (let i = 0; i < BASELINE_RUNS; i++) {
        try { const r = await runCheck({ argv: forceTapArgv(['node', '--test', ...protJs]), timeout_s: Math.min(R.max_timeout_s || 600, 600) }, { cwd: S, env: cenv('baseline'), ...sbx('baseline') }); if (!r.test_files) break; runs.push({ tests: 0, files: HG.compactFiles(r.test_files) }); } catch { break; } finally { await G.discardChanges(S).catch(() => {}); }
      }
      protCounts = mergeBaselineRuns(runs)?.files || null;
    }
    await G.git(S, ['checkout', '-q', 'guard-tree']);

    // ---- 3. anti-cheat diff analysis, before any tree code runs (as the engine's _anticheatDiff; no plan, so nothing is approved by a path_scope)
    const { files } = await attemptDiff(S, 'guard-base');
    res.files = files.map((f) => ({ path: f.path, status: f.status, ...(f.status === 'R' ? { from: f.from } : {}) })).slice(0, 200);
    const ctx = { path_scope: [], allow_skip: [], checks: checks.map((c) => c.argv), acceptance: null, is_acceptance: false, literal_copy: R.literal_copy, harness_tamper: R.harness_tamper };
    const io = { before: async (p) => { const b = await G.showBlob(S, baseSha, p, { maxBytes: LIMITS.file_bytes }).catch(() => null); return b ? b.toString('utf8') : null; },
      after: async (p) => { try { const abs = path.join(S, p); return fs.statSync(abs).size <= LIMITS.file_bytes ? fs.readFileSync(abs, 'utf8') : null; } catch { return null; } }, tests: () => readTestFiles(S) };
    try {
      const { findings } = await analyzeDiff(files, ctx, io);
      res.anticheat.findings = findings;
      for (const f of failsOf(findings)) reject(f.kind, `${f.path ? `${f.path}: ` : ''}${f.detail}`);
      res.anticheat.warnings = findings.filter((f) => f.severity !== 'fail');
    } catch (e) { reject('anticheat_error', `anti-cheat analysis failed: ${String(e.message).slice(0, 200)}`); }
    const editedTests = files.filter((f) => f.status === 'M' && protectedFiles.includes(f.path)).map((f) => f.path);

    // ---- 4. the checks on the tree (sandboxed), judged against the baselines; the tree must not change while they run
    const before = await G.head(S);
    const run = checks.length ? await runChecks(checks, { cwd: S, env: cenv('checks'), allowlist, ...sbx('checks') }) : { ok: true, results: [] };
    const dirty = await G.changedPaths(S).catch((e) => [`(git status failed: ${String(e.message).slice(0, 80)})`]);
    if (dirty.length || (await G.head(S).catch(() => null)) !== before) reject('worktree_mutated_during_checks', `the tree changed while the checks ran: ${dirty.slice(0, 5).join(', ') || 'HEAD moved'}`);
    await G.git(S, ['reset', '-q', '--hard', before], { allowFail: true }); await G.discardChanges(S).catch(() => {});
    for (const r of run.results) {
      const sm = summaryOfRun(r); const b = baselines[checkKey(r.argv)] || null;
      const rec = { argv: r.argv, ok: r.ok, exit_code: r.exit_code, timed_out: r.timed_out, sandboxed: r.sandboxed ?? null, duration_ms: r.duration_ms, ...(sm ? { tests: sm.tests, pass: sm.pass, skipped: sm.skipped, todo: sm.todo } : {}), baseline: b ? b.tests : null, output_tail: tail(r.output || '', 2000) };
      res.checks.push(rec);
      if (r.harness_tamper) { reject('harness_tamper', `\`${r.argv.join(' ')}\`: ${r.harness_problems.slice(0, 3).join(' | ')}`); continue; }
      if (!r.ok) {
        const ft = failingTests(r.output, [S, root]); res.failing_tests.push(...ft.map((t) => ({ ...t, in: 'check' })));
        const line = failingTestsLine(r.output, [S, root]);
        reject('check_failed', `\`${r.argv.join(' ')}\` failed${r.rejected ? ' (refused)' : r.timed_out ? ' (timed out)' : ''}: ${line ? `failing: ${line}` : String(r.output || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)}`);
        continue;
      }
      let v = judgeRun(r.argv, sm, b);
      if (v.ok) v = HG.judgePerFile(b?.files, r.test_files);
      if (!v.ok) reject(v.kind, `\`${r.argv.join(' ')}\`: ${v.reason}`);
    }

    // ---- 5. the ORIGINAL test files of the base commit, written over the tree and re-run (as the engine's _runProtectedTests)
    if (protJs.length) {
      const pr = { ok: true, files: protJs.length, not_executed: protOther.slice(0, 20) };
      try {
        for (const f of protJs) { const b = await G.showBlob(S, baseSha, f); if (b) { fs.mkdirSync(path.dirname(path.join(S, f)), { recursive: true }); fs.writeFileSync(path.join(S, f), b); } }
        const r = await runCheck({ argv: forceTapArgv(['node', '--test', ...protJs]), timeout_s: Math.min(R.max_timeout_s || 600, 600) }, { cwd: S, env: cenv('protected'), ...sbx('protected') });
        const sm = parseTestSummary(r.summary_text ?? r.output);
        pr.ok = r.ok; if (sm) { pr.tests = sm.tests; pr.pass = sm.pass; }
        if (!r.ok) { pr.output_tail = tail(r.output || '', 2000); pr.failing = failingTestsLine(r.output, [S, root]); pr.failing_tests = failingTests(r.output, [S, root]); res.failing_tests.push(...pr.failing_tests.map((t) => ({ ...t, in: 'original' }))); }
        if (r.harness_tamper) { pr.ok = false; pr.kind = 'harness_tamper'; }
        else if (r.ok && !(sm && sm.tests > 0 && sm.pass > 0)) { pr.ok = false; pr.kind = 'vacuous_pass'; pr.output_tail = `the original tests ran ${sm ? `${sm.tests} test(s) of which ${sm.pass} passed` : 'with no countable test summary'}`; }
        else if (r.ok) { const v = HG.judgePerFile(protCounts, r.test_files); if (!v.ok) { pr.ok = false; pr.kind = v.kind; pr.output_tail = v.reason; } }
      } catch (e) { pr.ok = false; pr.output_tail = `could not run the original tests: ${String(e.message).slice(0, 300)}`; } finally { await G.discardChanges(S).catch(() => {}); }
      res.protected = pr;
      if (!pr.ok) {
        const why = pr.failing ? `failing: ${pr.failing}` : String(pr.output_tail || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);
        if (pr.kind) reject(pr.kind, `the ORIGINAL existing tests: ${why}`);
        else reject('protected_tests_failed', `the ORIGINAL existing tests fail against the tree (a test was deleted, weakened or the code broke it): ${why}`);
        // an existing test file was rewritten and its ORIGINAL version now fails: the tree passes only its own edited copy of the test
        const failFiles = new Set((pr.failing_tests || []).map((t) => t.file).filter(Boolean));
        const edited = editedTests.filter((f) => !failFiles.size || failFiles.has(f));
        if (edited.length) reject('tests_edited', `${edited.slice(0, 5).join(', ')}: an existing test file was modified and its original version fails against the tree`);
      }
    }
    for (const f of editedTests) if (!res.rejections.some((r) => r.kind === 'tests_edited')) res.anticheat.warnings.push({ kind: 'tests_modified', severity: 'warn', path: f, detail: 'an existing test file was modified (its original version still passes)' });
    res.checks_run = checks.map((c) => c.argv.join(' '));
    if (!checks.length) res.anticheat.warnings.push({ kind: 'no_checks', severity: 'warn', detail: 'no check command was given or derivable: only the diff analysis and the original tests judged this tree' });
    return done();
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
}

/** Human summary of a verifyTree result. */
export function renderVerify(r) {
  const L = [r.accepted ? 'ACCEPTED: the tree passes the guardrails' : `REJECTED${r.integrity ? ' (integrity)' : ''}: ${r.rejections.length} reason(s)`];
  if (r.base) L.push(`base ${r.base.slice(0, 12)}, ${r.files.length} changed file(s)${r.sandboxed ? '' : ', checks UNSANDBOXED'}`);
  for (const c of r.checks) L.push(`check \`${c.argv.join(' ')}\`: ${c.ok ? 'passed' : 'FAILED'}${c.tests != null ? ` (${c.tests} tests, baseline ${c.baseline ?? '?'})` : ''}`);
  if (r.protected) L.push(`original tests (${r.protected.files} file(s)): ${r.protected.ok ? 'passed' : 'FAILED'}`);
  for (const x of r.reasons) L.push(`- ${x}`);
  for (const w of r.anticheat.warnings) L.push(`  advisory ${w.kind}${w.path ? ` ${w.path}` : ''}: ${w.detail}`);
  return L.join('\n');
}
