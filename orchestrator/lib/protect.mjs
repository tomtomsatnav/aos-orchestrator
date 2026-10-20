// Protection of EXISTING tests and a heuristic for checks that need a server.
// The guarantee is structural: at goal creation the test files of base_commit are listed; at verify the engine writes the ORIGINAL contents of those files over
// the integration tree and runs them, so a task that deleted, weakened or rewrote an existing test cannot make the goal pass. The plan-approval WARNING (a
// path_scope that includes an existing test) is only a hint to the human; this re-run is what cannot be bypassed.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { matchGlob } from './glob.mjs';
import { gitEnv } from './git.mjs';

export const MAX_PROTECTED = 500;
/** Heuristic: *test* / *spec* file names, or anything under test/ tests/ __tests__/. */
export function isTestPath(rel) {
  const base = path.posix.basename(rel);
  return /(^|\/)(tests?|__tests__)\//i.test(rel) || /(^|[._-])(test|tests|spec|specs)([._-]|$)/i.test(base);
}
/** Test files of a commit: {files[], truncated}. */
export function listTestFiles(repo, ref) {
  return new Promise((resolve, reject) => execFile('git', ['ls-tree', '-r', '--name-only', '-z', ref], { cwd: repo, env: gitEnv(), maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
    if (err) return reject(new Error(`git ls-tree failed: ${String(err.code ?? err.message).slice(0, 80)}`));
    const all = String(out).split('\0').filter((f) => f && !f.startsWith('node_modules/') && !f.includes('/node_modules/') && !f.split('/').includes('..') && !path.isAbsolute(f) && isTestPath(f));
    resolve({ files: all.slice(0, MAX_PROTECTED), truncated: all.length > MAX_PROTECTED });
  }));
}
/** The runner for the protected files: node's built-in runner for JS; other languages have no runner here and are reported as not executed. */
export function runnerFor(files) {
  const js = files.filter((f) => /\.(m?js|cjs)$/.test(f));
  return { js, other: files.filter((f) => !js.includes(f)) };
}
/** Existing test files a task's path_scope can write. */
export const scopeHitsTests = (scope, files) => files.filter((f) => (scope || []).some((g) => { try { return matchGlob(g, f); } catch { return false; } }));

export const SERVER_RE = /createServer\s*\(|\.listen\s*\(|http\.request\s*\(|https?\.get\s*\(|fetch\(\s*['"`]https?:\/\/(127\.|localhost)/;
/** Warnings for check argvs naming a source file that looks like it starts / calls a local server. `read(rel)` -> text|null. Only when allow_loopback is false. */
export async function serverWarnings(argvs, read, { label = (i) => `check ${i + 1}` } = {}) {
  const out = [];
  for (const [i, argv] of argvs.entries()) for (const a of argv.slice(1)) {
    if (!/\.(m?js|cjs|ts|py)$/.test(a) || a.startsWith('-') || path.isAbsolute(a) || a.split('/').includes('..')) continue;
    let text = null; try { text = await read(a); } catch { text = null; }
    if (typeof text === 'string' && SERVER_RE.test(text)) out.push(`${label(i)} runs ${a}, which looks like it starts or calls a local server (createServer/listen/http.request/fetch 127...), but checks.allow_loopback is false: the sandboxed check will fail with EPERM. If this is intended, a human sets checks.allow_loopback: true in the rules.`);
  }
  return out;
}
