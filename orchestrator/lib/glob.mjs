// Tiny glob helpers (no dependencies). Paths are POSIX style and relative unless stated otherwise.
const cache = new Map();

/**
 * glob -> RegExp. `*` (no slash), `**` (any depth), `?`, `[abc]` / `[!abc]` classes and `{a,b}` alternation (nested; an unbalanced `{` or `[` is a literal).
 * A class never matches `/`.
 */
export function globToRegex(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let i = 0;
  const seq = (inBrace) => {
    let re = '';
    while (i < glob.length) {
      const c = glob[i];
      if (inBrace && (c === ',' || c === '}')) break;
      if (c === '*') {
        if (glob[i + 1] === '*') {
          i++;
          if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
        } else re += '[^/]*';
        i++;
      } else if (c === '?') { re += '[^/]'; i++; } else if (c === '[') {
        let j = i + 1; const neg = glob[j] === '!' || glob[j] === '^'; if (neg) j++;
        const from = j; if (glob[j] === ']') j++;
        while (j < glob.length && glob[j] !== ']') j++;
        if (j >= glob.length) { re += '\\['; i++; } else {
          const body = glob.slice(from, j).replace(/[\\\]^]/g, '\\$&');
          re += neg ? `[^/${body}]` : `(?!/)[${body}]`; i = j + 1;
        }
      } else if (c === '{') {
        const save = i; i++;
        const alts = [seq(true)];
        while (glob[i] === ',') { i++; alts.push(seq(true)); }
        if (glob[i] === '}') { i++; re += `(?:${alts.join('|')})`; } else { i = save + 1; re += '\\{'; }
      } else { re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); i++; }
    }
    return re;
  };
  const rx = new RegExp(`^${seq(false)}$`);
  cache.set(glob, rx);
  return rx;
}

const hasWild = (s) => /[*?[{]/.test(s);

/** A scope entry without wildcards names a file or a whole directory. */
export function matchGlob(glob, rel) {
  const g = glob.replace(/\/+$/, '');
  if (!hasWild(g)) return rel === g || rel.startsWith(`${g}/`);
  return globToRegex(g).test(rel);
}

export const matchAny = (globs, rel) => (globs || []).some((g) => matchGlob(g, rel));

const staticPrefix = (g) => {
  const out = [];
  for (const seg of g.replace(/\/+$/, '').split('/')) { if (hasWild(seg)) break; out.push(seg); }
  return out;
};

/** Conservative overlap test: true when two scopes could touch the same file. */
export function globsOverlap(a, b) {
  const pa = staticPrefix(a); const pb = staticPrefix(b);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) if (pa[i] !== pb[i]) return false;
  return true;
}

const sampleOf = (g) => g.replace(/\*\*\//g, 'x/').replace(/\*\*/g, 'x').replace(/[*?]/g, 'x').replace(/\[[^\]]*\]/g, 'x');
/**
 * Can a path_scope entry and a deny glob name a common file? Heuristic (no regex-language intersection): tries a few concrete paths built from both globs
 * (the scope's samples, the deny's samples, and each glob's directory prefix joined with the other's tail) and asks whether both match one. Conservative for
 * directory scopes (a scope that names `docs` covers everything under it), so a plan that could write a denied file is rejected rather than approved.
 */
export function scopeHitsDeny(scope, deny) {
  const s = scope.replace(/^\.\//, '').replace(/\/+$/, ''); const d = deny.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!hasWild(s) && /\.[^/]+$/.test(s)) return matchGlob(d, s); // a literal name with an extension is a file, not a directory
  const dir = (g) => staticPrefix(g).join('/'); const tail = (g) => sampleOf(g.replace(/^(\*\*\/)+/, ''));
  const join = (a, b) => (a ? `${a}/${b}` : b);
  const cands = [sampleOf(s), `${sampleOf(s)}/x`, sampleOf(d), `${sampleOf(d)}/x`, join(dir(s), tail(d)), join(dir(d), tail(s)), join(dir(s), `${tail(d)}/x`), ...(hasWild(d) ? [] : [d, `${d}/x`])];
  return cands.some((c) => matchGlob(s, c) && matchGlob(d, c));
}

export function scopesOverlap(as, bs) {
  return (as || []).some((a) => (bs || []).some((b) => globsOverlap(a, b)));
}
