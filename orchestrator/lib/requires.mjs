// Static scan of relative require()/import specifiers in (model-written, untrusted) test files. The text is only matched with
// bounded regular expressions: nothing is executed, sizes and counts are capped, and only plain repo-relative paths come out.
import path from 'node:path';

const MAX_TEXT = 256 * 1024;
const MAX_SPECS = 200;
const SPEC = "(['\"])(\\.{1,2}(?:/[^'\"\\n]{0,300})?)\\1";
const PATTERNS = [
  new RegExp(`\\brequire\\s*\\(\\s*${SPEC}\\s*\\)`, 'g'),
  new RegExp(`\\bimport\\s*\\(\\s*${SPEC}\\s*\\)`, 'g'),
  new RegExp(`\\b(?:import|export)\\s+(?:[\\w*{}\\s,$]{0,500}?\\s*from\\s*)?${SPEC}`, 'g'),
];
/** A repo-relative path that is safe to compare, store and echo: plain characters, no `..`, bounded length. */
export const safeRel = (p) => typeof p === 'string' && /^[\w@+.\-/]{1,200}$/.test(p) && !p.startsWith('/') && !p.split('/').some((s) => s === '..' || s === '.' || s === '');

/** Relative specifiers ('./x', '../y') of a JS source text, comments stripped. Bounded. */
export function relativeSpecifiers(text) {
  const src = String(text ?? '').slice(0, MAX_TEXT).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\w])\/\/[^\n]*/g, '$1');
  const out = new Set();
  for (const re of PATTERNS) { re.lastIndex = 0; let m; while ((m = re.exec(src)) && out.size < MAX_SPECS) out.add(m[2]); }
  return [...out];
}

/** Repo-relative candidate files for a specifier written in `fromRel` (Node's resolution order for a path without extension); [] when it leaves the repo or is not a plain path. */
export function candidatesFor(fromRel, spec) {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (joined.startsWith('..') || joined.startsWith('/')) return [];
  const p = joined === '.' ? '' : joined.replace(/\/+$/, '');
  const list = p ? [p, `${p}.js`, `${p}.mjs`, `${p}.cjs`, `${p}/index.js`, `${p}/index.mjs`, `${p}/index.cjs`] : ['index.js', 'index.mjs', 'index.cjs'];
  return [...new Set(list)].filter(safeRel);
}
