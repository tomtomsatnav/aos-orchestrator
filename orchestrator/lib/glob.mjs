// Tiny glob helpers (no dependencies). Paths are POSIX style and relative unless stated otherwise.
const cache = new Map();

export function globToRegex(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const rx = new RegExp(`^${re}$`);
  cache.set(glob, rx);
  return rx;
}

const hasWild = (s) => /[*?[]/.test(s);

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

export function scopesOverlap(as, bs) {
  return (as || []).some((a) => (bs || []).some((b) => globsOverlap(a, b)));
}
