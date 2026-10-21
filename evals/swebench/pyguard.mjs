// The AOS guard for a Python SWE-bench tree: lib/guard.mjs verifyTree (static anti-cheat diff analysis; its JS-only check and original-test stages find
// nothing to run in a Python repo) PLUS a Python stage that runs inside the instance's own SWE-bench Docker image (the grading env), with no network:
//   baseline  : the ORIGINAL test files related to the changed source files, on the base commit
//   tree      : the agent's patch applied; py_compile of changed .py files; the agent's own added/modified test files (agent version)
//   original  : the same original test files restored over the patched tree and re-run; a test that passed at baseline and does not pass now = rejection
// The guard never sees the hidden tests: it reads only the base commit, the agent's diff, and the instance's install command + test-runner prefix.
// Result shape is compatible with evals/run.mjs escalationPrompt and guard.mjs CAPABILITY_KINDS / INTEGRITY_KINDS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { verifyTree, INTEGRITY_KINDS } from '../../orchestrator/lib/guard.mjs';

export const DOCKER_HOST = process.env.SWEBENCH_DOCKER_HOST || `unix://${os.homedir()}/.docker/run/docker.sock`;
export const dockerEnv = () => ({ ...process.env, DOCKER_HOST });
const MAX_ORIG = 6;
const STATIC_PROFILE = { rules_version: 1, checks: { allowlist: [], protect_existing_tests: false, max_timeout_s: 600 } };
const git = (cwd, args, extraEnv = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });

/** The working tree of `repo` (incl. untracked, minus ignored) as a binary diff against `seed`, without touching the agent's index. */
export function treeDiff(repo, seed, paths = null) {
  const idx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swe-idx-')), 'index');
  try {
    const e = { GIT_INDEX_FILE: idx };
    git(repo, ['read-tree', seed], e); git(repo, ['add', '-A'], e);
    const patch = git(repo, ['diff', '--cached', '--binary', seed, ...(paths ? ['--', ...paths] : [])], e);
    const files = git(repo, ['diff', '--cached', '--name-status', '--no-renames', seed], e).split('\n').filter(Boolean).map((l) => { const [st, p] = l.split('\t'); return { status: st, path: p }; });
    return { patch, files };
  } finally { fs.rmSync(path.dirname(idx), { recursive: true, force: true }); }
}

/** pytest's default test-file pattern: what can actually be run as a test (fixture files under tests/ are not). */
export const isPyTestFile = (p) => /(^|\/)test_[^/]*\.py$|_test\.py$/.test(p);
export const isTest = (p) => /(^|\/)(tests?|testing)\//.test(p) || /(^|\/)test_[^/]*\.py$|_test\.py$/.test(p);
/** Original (base-commit) Python test files related to the changed source files: name match, else mention of the module, else all when there are <= 3. */
export async function relatedTests(repo, seed, changed) {
  // own listing (listTestFiles caps at 500 paths, which sphinx's tests/roots fixtures exhaust); fixture trees are not part of the suite
  const FIXTURE = /(^|\/)(roots|example_scripts|fixtures?|data)\//;
  const depth = (f) => f.split('/').length;
  const tests = git(repo, ['ls-tree', '-r', '--name-only', seed]).split('\n').filter((f) => isPyTestFile(f) && !FIXTURE.test(f)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  const stems = [...new Set(changed.filter((f) => f.endsWith('.py') && !isTest(f)).map((f) => { const b = path.posix.basename(f, '.py'); return b === '__init__' ? path.posix.basename(path.posix.dirname(f)) : b; }).filter((s) => s.length >= 3))];
  const pick = new Set();
  for (const s of stems) for (const t of tests) { const b = path.posix.basename(t, '.py'); if (b === `test_${s}` || b === `${s}_test`) pick.add(t); } // exact names first
  for (const s of stems) for (const t of tests) { const b = path.posix.basename(t, '.py'); if (b.includes(s)) pick.add(t); }
  if (!pick.size && stems.length) {
    const scored = tests.map((t) => { const txt = git(repo, ['show', `${seed}:${t}`]); return [t, stems.reduce((n, s) => n + (txt.match(new RegExp(`\\b${s}\\b`, 'g')) || []).length, 0)]; }).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
    for (const [t] of scored.slice(0, 3)) pick.add(t);
  }
  if (!pick.size && tests.length <= 3) for (const t of tests) pick.add(t);
  return { files: [...pick].slice(0, MAX_ORIG), how: pick.size ? 'related' : 'none', all_test_files: tests.length };
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const offline = (cmd) => cmd.replace(/\bpip install\b/, 'pip install --no-build-isolation --no-deps --no-index');
function script(inst, orig, agentTests, compile) {
  const pt = [...inst.guard_env.test_prefix, '-p', 'no:cacheprovider'].join(' ');
  const install = inst.guard_env.install.map(offline).join(' && ') || 'true';
  const run = (files) => (files.length ? `timeout 900 ${pt} ${files.map(q).join(' ')} 2>&1 | tail -n 4000` : 'echo "(no files)"');
  return `export PY_COLORS=0 NO_COLOR=1 TERM=dumb; source /opt/miniconda3/bin/activate; conda activate testbed; cd /testbed; git config --global --add safe.directory /testbed
echo "@@INSTALL_BASE"; (${install}) > /tmp/i0.log 2>&1; echo "@@EXIT $?"; tail -5 /tmp/i0.log
echo "@@BASELINE"; ${run(orig)}
git apply --whitespace=nowarn /guard/patch.diff 2>&1; echo "@@APPLY $?"
echo "@@INSTALL_TREE"; (${install}) > /tmp/i1.log 2>&1; echo "@@EXIT $?"; tail -20 /tmp/i1.log
echo "@@COMPILE"; ${compile.length ? `python -m py_compile ${compile.map(q).join(' ')} 2>&1; echo "@@EXIT $?"` : 'echo "@@EXIT 0"'}
echo "@@AGENT_TESTS"; ${run(agentTests)}
${orig.length ? `git checkout ${inst.base_commit} -- ${orig.map(q).join(' ')} 2>&1` : ''}
echo "@@ORIGINAL"; ${run(orig)}
echo "@@END"
`;
}
const section = (out, name) => { const m = new RegExp(`@@${name}\\n([\\s\\S]*?)(?=\\n@@(?:INSTALL_BASE|BASELINE|APPLY|INSTALL_TREE|COMPILE|AGENT_TESTS|ORIGINAL|END)\\b|$)`).exec(out); return m ? m[1] : ''; };
/** pytest -rA short summary -> {id: status}; the last status of an id wins. */
export function parsePytest(text) {
  const r = {};
  for (const m of String(text).replace(/\x1b\[[0-9;]*m/g, '').matchAll(/^(PASSED|FAILED|ERROR|XPASS|XFAIL|SKIPPED)\s+(\S+)/gm)) if (!m[2].startsWith('[')) r[m[2]] = m[1];
  return r;
}
const tail = (s, n = 2000) => String(s).slice(-n);

function docker(args, input, timeoutMs) {
  return new Promise((resolve) => {
    const c = spawn('docker', args, { env: dockerEnv(), stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = ''; let timedOut = false;
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    if (input) c.stdin.end(input);
    const t = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, timeoutMs);
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out, timedOut }); });
  });
}

/** The Python stage. -> {ok, rejections[], checks[], protected, orig_tests, agent_tests, duration_s, raw_tail} */
export async function pyStage(inst, repo, seed, { patch, files }) {
  const t0 = Date.now();
  const changed = files.map((f) => f.path);
  const { files: orig, how, all_test_files } = await relatedTests(repo, seed, changed);
  const agentTests = files.filter((f) => f.status !== 'D' && isPyTestFile(f.path)).map((f) => f.path);
  const compile = files.filter((f) => f.status !== 'D' && f.path.endsWith('.py')).map((f) => f.path);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-guard-'));
  const res = { ok: true, rejections: [], checks: [], protected: null, orig_tests: orig, orig_selection: how, repo_test_files: all_test_files, agent_tests: agentTests };
  const reject = (kind, detail) => { res.ok = false; res.rejections.push({ kind, detail: String(detail).slice(0, 600) }); };
  try {
    fs.writeFileSync(path.join(dir, 'patch.diff'), patch || '');
    fs.writeFileSync(path.join(dir, 'guard.sh'), script(inst, orig, agentTests, compile));
    const r = await docker(['run', '--rm', '--network', 'none', '--platform', 'linux/amd64', '--memory', '3g', '--cpus', '4', '-v', `${dir}:/guard:ro`, inst.image, 'bash', '/guard/guard.sh'], null, 40 * 60 * 1000);
    const out = r.out; res.raw_tail = tail(out, 4000);
    if (r.timedOut || !out.includes('@@END')) { reject('guard_error', `the Docker guard run did not finish (${r.timedOut ? 'timeout' : `exit ${r.code}`}): ${tail(out, 300)}`); return res; }
    const exitOf = (name) => Number((/@@EXIT (\d+)/.exec(section(out, name)) || [])[1] ?? -1);
    const base = parsePytest(section(out, 'BASELINE'));
    if (exitOf('INSTALL_BASE') !== 0) reject('guard_error', `offline install of the base commit failed: ${tail(section(out, 'INSTALL_BASE'), 300)}`);
    const applyCode = Number((/@@APPLY (\d+)/.exec(out) || [])[1] ?? -1);
    if (applyCode !== 0) { reject('check_failed', `the patch does not apply to the base commit: ${tail(out.split('@@APPLY')[0], 300)}`); return res; }
    if (exitOf('INSTALL_TREE') !== 0 && exitOf('INSTALL_BASE') === 0) reject('check_failed', `\`pip install\` of the patched tree failed: ${tail(section(out, 'INSTALL_TREE'), 600)}`);
    const comp = section(out, 'COMPILE'); res.checks.push({ argv: `python -m py_compile <${compile.length} changed .py files>`, ok: exitOf('COMPILE') === 0, output_tail: tail(comp, 1500) });
    if (exitOf('COMPILE') !== 0) reject('check_failed', `py_compile failed: ${tail(comp, 400)}`);
    if (agentTests.length) {
      const txt = section(out, 'AGENT_TESTS'); const st = parsePytest(txt);
      const bad = Object.entries(st).filter(([id, s]) => (s === 'FAILED' || s === 'ERROR') && !(base[id] === 'FAILED' || base[id] === 'ERROR')).map(([id]) => id);
      const ran = Object.keys(st).length;
      res.checks.push({ argv: `${inst.guard_env.test_prefix.join(' ')} ${agentTests.join(' ')}`, ok: !bad.length && ran > 0, tests: ran, output_tail: tail(txt, 1500) });
      if (bad.length) reject('check_failed', `the agent's own tests fail: ${bad.slice(0, 8).join(', ')}`);
      else if (!ran) reject('check_failed', `the agent's test files ran no test: ${tail(txt, 300)}`);
    }
    if (orig.length) {
      const txt = section(out, 'ORIGINAL'); const now = parsePytest(txt);
      const passedBefore = Object.keys(base).filter((id) => base[id] === 'PASSED');
      const broke = passedBefore.filter((id) => now[id] !== 'PASSED');
      res.protected = { ok: !broke.length, files: orig.length, baseline_passed: passedBefore.length, now_passed: Object.values(now).filter((s) => s === 'PASSED').length, failing: broke.slice(0, 20).join(', '), output_tail: tail(txt, 2000) };
      if (!passedBefore.length) res.protected.note = 'no original test passed at baseline (offline): the original-tests stage judged nothing';
      if (broke.length) reject('protected_tests_failed', `the ORIGINAL existing tests that passed on the base commit fail against the tree: ${broke.slice(0, 8).join(', ')}${broke.length > 8 ? ` (+${broke.length - 8})` : ''}`);
    }
    return res;
  } finally { res.duration_s = Math.round((Date.now() - t0) / 100) / 10; fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * The full guard on an agent's working tree: verifyTree (static anti-cheat; no JS checks exist here) then, unless that already rejected on integrity,
 * the Docker Python stage. -> {accepted, integrity, reasons[], rejections[], checks[], protected, static, py, patch_bytes, files}
 */
export async function guardTree(inst, repo, seed) {
  const t0 = Date.now();
  // static stage only: an empty allowlist makes defaultChecks derive nothing (sphinx ships a package.json and tests/js), and the JS original-tests
  // re-run is off; the Python original tests are protected by pyStage instead
  const v = await verifyTree({ repo, base: seed, profile: STATIC_PROFILE, checks: [] });
  const d = treeDiff(repo, seed);
  const g = { rejections: [...v.rejections], checks: [], protected: null, static: { accepted: v.accepted, reasons: v.reasons.slice(0, 10), warnings: v.anticheat.warnings.map((w) => `${w.kind}${w.path ? ` ${w.path}` : ''}`).slice(0, 10) }, py: null, files: d.files.map((f) => `${f.status} ${f.path}`).slice(0, 50), patch_bytes: d.patch.length };
  if (!d.files.length) g.rejections.push({ kind: 'check_failed', detail: 'the tree has no change against the base commit' });
  else if (!v.rejections.some((r) => INTEGRITY_KINDS.has(r.kind))) {
    const p = await pyStage(inst, repo, seed, d);
    g.py = { ...p, raw_tail: undefined }; g.rejections.push(...p.rejections); g.checks = p.checks; g.protected = p.protected;
  }
  g.reasons = g.rejections.map((r) => `${r.kind}: ${r.detail}`);
  g.integrity = g.rejections.some((r) => INTEGRITY_KINDS.has(r.kind)); g.accepted = g.rejections.length === 0;
  g.failing_tests = []; g.duration_s = Math.round((Date.now() - t0) / 100) / 10;
  return g;
}

// ---------------------------------------------------------------- best-of-N with reproduction tests
// an attempt's reproduction = its NEW test files (pytest pattern, run) plus any other new files under test dirs (fixtures, copied along, not run)
const isRepro = (f) => f.status === 'A' && isTest(f.path) && !/conftest\.py$/.test(f.path);
/** An attempt's parts: its source-only patch (no test files), its NEW test files (the reproduction), and its normalised changed source lines. */
export function attemptParts(repo, seed) {
  const { files } = treeDiff(repo, seed);
  const src = files.filter((f) => !isTest(f.path)).map((f) => f.path);
  const srcPatch = src.length ? treeDiff(repo, seed, src).patch : '';
  const repro = files.filter(isRepro).map((f) => ({ path: f.path, run: isPyTestFile(f.path), text: fs.readFileSync(path.join(repo, f.path), 'utf8') }));
  const lines = [...new Set(srcPatch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).map((l) => `${l[0]}${l.slice(1).replace(/\s+/g, ' ').trim()}`).filter((l) => l.length > 1))];
  return { srcPatch, repro, lines };
}
export const jaccard = (a, b) => { const A = new Set(a); const B = new Set(b); const inter = [...A].filter((x) => B.has(x)).length; const uni = new Set([...A, ...B]).size; return uni ? inter / uni : 0; };

/**
 * Cross-check matrix in the instance image (no network): every attempt's reproduction test(s) run against the ORIGINAL code and each attempt's
 * source-only patch. -> {cells: {[i]: {base: {pass, passed, failed, rc}, [j]: {...}}}, duration_s, error?}. Hidden tests are never used.
 */
export async function reproMatrix(inst, parts) {
  const t0 = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-repro-'));
  const install = inst.guard_env.install.map(offline).join(' && ') || 'true';
  const pt = [...inst.guard_env.test_prefix, '-p', 'no:cacheprovider'].join(' ');
  const variants = ['base', ...parts.map((_, j) => String(j))];
  let sh = 'export PY_COLORS=0 NO_COLOR=1 TERM=dumb; source /opt/miniconda3/bin/activate; conda activate testbed; cd /testbed; git config --global --add safe.directory /testbed\n';
  try {
    parts.forEach((p, j) => { fs.writeFileSync(path.join(dir, `p${j}.diff`), p.srcPatch || ''); p.repro.forEach((f, k) => { fs.mkdirSync(path.join(dir, `r${j}`), { recursive: true }); fs.writeFileSync(path.join(dir, `r${j}`, `${k}.py`), f.text); }); });
    for (const v of variants) {
      const patched = v !== 'base' && parts[Number(v)].srcPatch;
      sh += `echo "@@VARIANT ${v}"\n${patched ? `git apply --whitespace=nowarn /guard/p${v}.diff > /dev/null 2>&1; echo "@@APPLY ${v} $?"\n` : ''}(${install}) > /dev/null 2>&1\n`;
      parts.forEach((p, i) => {
        const run = p.repro.filter((f) => f.run).map((f) => f.path); const paths = p.repro.map((f) => f.path);
        if (!run.length) return;
        sh += p.repro.map((f, k) => `mkdir -p ${q(path.posix.dirname(f.path))}; cp /guard/r${i}/${k}.py ${q(f.path)}`).join('\n');
        sh += `\necho "@@CELL ${i} ${v}"; timeout 600 ${pt} ${run.map(q).join(' ')} 2>&1 | tail -n 300; echo "@@RC ${i} ${v} \${PIPESTATUS[0]}"\nrm -f ${paths.map(q).join(' ')}\n`;
      });
      if (patched) sh += `git apply -R --whitespace=nowarn /guard/p${v}.diff > /dev/null 2>&1\n`;
    }
    sh += 'echo "@@END"\n';
    fs.writeFileSync(path.join(dir, 'matrix.sh'), sh);
    const r = await docker(['run', '--rm', '--network', 'none', '--platform', 'linux/amd64', '--memory', '3g', '--cpus', '4', '-v', `${dir}:/guard:ro`, inst.image, 'bash', '/guard/matrix.sh'], null, 60 * 60 * 1000);
    const cells = {};
    for (const m of r.out.matchAll(/@@CELL (\d+) (\w+)\n([\s\S]*?)\n@@RC \1 \2 (\d+)/g)) {
      const st = Object.values(parsePytest(m[3]));
      const passed = st.filter((x) => x === 'PASSED').length; const failed = st.filter((x) => x === 'FAILED' || x === 'ERROR').length;
      (cells[m[1]] ||= {})[m[2]] = { pass: Number(m[4]) === 0 && passed > 0 && failed === 0, passed, failed, rc: Number(m[4]) };
    }
    const applied = Object.fromEntries([...r.out.matchAll(/@@APPLY (\d+) (\d+)/g)].map((m) => [m[1], Number(m[2]) === 0]));
    return { cells, applied, duration_s: Math.round((Date.now() - t0) / 100) / 10, ...(r.out.includes('@@END') ? {} : { error: `matrix run did not finish: ${tail(r.out, 300)}` }) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Repro-based selection. A reproduction is VALID when it fails on the original code and passes on its own patch. Pool = attempts the guard accepted
 * AND whose own reproduction is valid; when that is empty, the guard-accepted attempts (fallback). Rank: most VALID reproductions passed (own +
 * others'), then agreement (sum of Jaccard similarity of normalised changed source lines with the other attempts: the majority cluster), then
 * completion order. -> {chosen, pool, fallback, ranking[], why{}}
 */
export function selectByRepro(cands, parts, matrix) {
  const cell = (i, v) => matrix.cells?.[i]?.[v];
  const valid = cands.map((c) => parts[c.copy].repro.some((f) => f.run) && cell(c.copy, 'base')?.pass === false && cell(c.copy, String(c.copy))?.pass === true);
  const why = {};
  const info = cands.map((c) => {
    const j = c.copy; const passes = cands.filter((o) => valid[o.copy] && cell(o.copy, String(j))?.pass).map((o) => o.copy);
    const agreement = Math.round(cands.filter((o) => o.copy !== j).reduce((a, o) => a + jaccard(parts[j].lines, parts[o.copy].lines), 0) * 1000) / 1000;
    return { copy: j, finished_order: c.finished_order, accepted: c.guard.accepted, repro_valid: valid[j], repro_files: parts[j].repro.filter((f) => f.run).map((f) => f.path), passes_valid_repros: passes, score: passes.length, agreement };
  });
  let pool = info.filter((x) => x.accepted && x.repro_valid); let fallback = false;
  if (!pool.length) { pool = info.filter((x) => x.accepted); fallback = pool.length > 0; }
  const ranking = [...pool].sort((a, b) => b.score - a.score || b.agreement - a.agreement || a.finished_order - b.finished_order);
  for (const x of info) {
    if (!x.accepted) why[x.copy] = 'rejected by the guard';
    else if (!x.repro_valid && !fallback) why[x.copy] = !x.repro_files.length ? 'no reproduction test written' : `reproduction invalid (on original: ${cell(x.copy, 'base')?.pass ? 'passes' : cell(x.copy, 'base') ? 'fails' : 'not run'}; on own patch: ${cell(x.copy, String(x.copy))?.pass ? 'passes' : 'fails'})`;
    else { const rank = ranking.findIndex((r) => r.copy === x.copy); why[x.copy] = `${rank === 0 ? 'CHOSEN' : `ranked ${rank + 1}`}: passes ${x.score} valid repro(s) [${x.passes_valid_repros.join(',')}], agreement ${x.agreement}, finished #${x.finished_order + 1}${fallback ? ' (fallback: no attempt had a valid repro)' : ''}`; }
  }
  return { chosen: ranking.length ? ranking[0].copy : null, fallback, ranking: info, why };
}
