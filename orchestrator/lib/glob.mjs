// Tiny glob helpers (no dependencies). Paths are POSIX style and relative unless stated otherwise.
const cache = new Map();
/** Longest path (or glob) the matcher will look at; longer ones are "no match" for allow-style checks and "match" for deny-style ones (fail closed). */
export const MAX_MATCH_LEN = 4096;
export const MAX_BRACE_VARIANTS = 64;
export const MAX_GLOB_WILDCARDS = 8;

/** Parse the inside of a [...] class into inclusive code-unit ranges. A reversed range like `z-a` throws (the regex engine used to). */
export function classRanges(body) {
  const r = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i + 1] === '-' && i + 2 < body.length) {
      if (body.charCodeAt(i) > body.charCodeAt(i + 2)) throw new Error(`invalid range ${body.slice(i, i + 3)} in character class`);
      r.push([body.charCodeAt(i), body.charCodeAt(i + 2)]); i += 2;
    } else r.push([body.charCodeAt(i), body.charCodeAt(i)]);
  }
  return r;
}
const inRanges = (rs, c) => rs.some(([lo, hi]) => c >= lo && c <= hi);

/**
 * glob -> list of token sequences, one per brace alternative (at most MAX_BRACE_VARIANTS, else throws). Syntax: `*` (no slash), `**` (any depth),
 * `**` + `/` (zero or more directories: an optional `<anything>/`), `?`, `[abc]` / `[!abc]` classes and nested `{a,b}` alternation (an unbalanced `{` or `[` is a literal). A class never matches `/`.
 */
function parseGlob(glob) {
  let i = 0;
  const tooMany = () => new Error(`more than ${MAX_BRACE_VARIANTS} brace alternatives`);
  const cross = (xs, ys) => {
    if (xs.length * ys.length > MAX_BRACE_VARIANTS) throw tooMany();
    const out = []; for (const x of xs) for (const y of ys) out.push(x.concat(y)); return out;
  };
  const seq = (inBrace) => {
    let vs = [[]];
    const push = (t) => { for (const v of vs) v.push(t); };
    while (i < glob.length) {
      const c = glob[i];
      if (inBrace && (c === ',' || c === '}')) break;
      if (c === '*') {
        if (glob[i + 1] === '*') {
          i++;
          if (glob[i + 1] === '/') { i++; push({ t: 'dso' }); push({ t: 'ds' }); push({ t: 'c', ch: '/' }); } else push({ t: 'ds' });
        } else push({ t: 's' });
        i++;
      } else if (c === '?') { push({ t: 'q' }); i++; } else if (c === '[') {
        let j = i + 1; const neg = glob[j] === '!' || glob[j] === '^'; if (neg) j++;
        const from = j; if (glob[j] === ']') j++;
        while (j < glob.length && glob[j] !== ']') j++;
        if (j >= glob.length) { push({ t: 'c', ch: '[' }); i++; } else { push({ t: 'cls', neg, rs: classRanges(glob.slice(from, j)) }); i = j + 1; }
      } else if (c === '{') {
        const save = i; i++;
        let alts = seq(true);
        while (glob[i] === ',') { i++; alts = alts.concat(seq(true)); if (alts.length > MAX_BRACE_VARIANTS) throw tooMany(); }
        if (glob[i] === '}') { i++; vs = cross(vs, alts); } else { i = save + 1; push({ t: 'c', ch: '{' }); }
      } else { push({ t: 'c', ch: c }); i++; }
    }
    return vs;
  };
  return seq(false);
}

/** Linear-time match of one token sequence: a state-set (NFA) simulation, O(path length x tokens), no backtracking. */
function runTokens(tk, s) {
  const n = tk.length;
  let cur = new Uint8Array(n + 1);
  const close = (set) => { for (let k = 0; k < n; k++) if (set[k] && (tk[k].t === 's' || tk[k].t === 'ds' || tk[k].t === 'dso')) { set[k + 1] = 1; if (tk[k].t === 'dso') set[k + 3] = 1; } };
  cur[0] = 1; close(cur);
  for (let p = 0; p < s.length; p++) {
    const ch = s.charCodeAt(p); const slash = ch === 47; const nx = new Uint8Array(n + 1); let any = 0;
    for (let k = 0; k < n; k++) {
      if (!cur[k]) continue;
      const t = tk[k];
      switch (t.t) {
        case 'c': if (s[p] === t.ch) { nx[k + 1] = 1; any = 1; } break;
        case 'q': if (!slash) { nx[k + 1] = 1; any = 1; } break;
        case 'cls': if (!slash && inRanges(t.rs, ch) !== t.neg) { nx[k + 1] = 1; any = 1; } break;
        case 's': if (!slash) { nx[k] = 1; any = 1; } break;
        case 'ds': nx[k] = 1; any = 1; break;
      }
    }
    if (!any) return false;
    close(nx); cur = nx;
  }
  return cur[n] === 1;
}

/** Compile (cached) to {test(s)}; throws on an invalid glob (reversed class range, too many brace alternatives). */
export function compileGlob(glob) {
  let m = cache.get(glob);
  if (!m) {
    try { const variants = parseGlob(glob); m = { test: (s) => variants.some((tk) => runTokens(tk, s)) }; } catch (e) { m = { err: e }; }
    if (cache.size > 2000) cache.clear();
    cache.set(glob, m);
  }
  if (m.err) throw m.err;
  return m;
}
/** Why a glob is unusable (too long, too many wildcards or brace alternatives, does not compile), else null. */
export function globCompileProblem(glob) {
  if (typeof glob !== 'string') return 'is not a string';
  if (glob.length > MAX_MATCH_LEN) return 'is too long';
  if ((glob.match(/\*+/g) || []).length > MAX_GLOB_WILDCARDS) return `has more than ${MAX_GLOB_WILDCARDS} wildcards`;
  try { compileGlob(glob); } catch (e) { return `does not compile (${e.message})`; }
  return null;
}
/** Match a glob against a string. `bad` is the answer when the glob does not compile or the string is longer than MAX_MATCH_LEN: false for allow-style checks, true for deny-style ones. Never throws. */
export function globTest(glob, s, bad = false) {
  if (typeof s !== 'string' || s.length > MAX_MATCH_LEN) return bad;
  try { return compileGlob(glob).test(s); } catch { return bad; }
}

const hasWild = (s) => /[*?[{]/.test(s);

/** A scope entry without wildcards names a file or a whole directory. */
export function matchGlob(glob, rel, bad = false) {
  const g = glob.replace(/\/+$/, '');
  if (!hasWild(g)) return rel === g || rel.startsWith(`${g}/`);
  return globTest(g, rel, bad);
}

export const matchAny = (globs, rel, bad = false) => (globs || []).some((g) => matchGlob(g, rel, bad));

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

/** Expand `{a,b}` alternation into plain globs (nested; at most `cap` results; an unbalanced brace stays literal). */
export function expandBraces(g, cap = 64) {
  const open = g.indexOf('{');
  if (open < 0) return [g];
  let depth = 0; let close = -1; const cuts = [];
  for (let i = open; i < g.length; i++) {
    if (g[i] === '{') depth++;
    else if (g[i] === '}' && --depth === 0) { close = i; break; } else if (g[i] === ',' && depth === 1) cuts.push(i);
  }
  if (close < 0) return [g];
  const pre = g.slice(0, open); const post = g.slice(close + 1); const alts = []; let from = open + 1;
  for (const c of [...cuts, close]) { alts.push(g.slice(from, c)); from = c + 1; }
  const out = [];
  for (const a of alts) for (const rest of expandBraces(pre + a + post, cap)) { out.push(rest); if (out.length >= cap) return out; }
  return out;
}
/** Expand each `[...]` class into one variant per sample member (range ends and midpoint; a negated class contributes up to two characters NOT in it), at most `cap` results. */
function expandClasses(g, cap = 64, hint = '') {
  const m = /\[([!^]?)([^\]]+)\]/.exec(g);
  if (!m) return [g];
  const chars = new Set();
  let rs = null; try { rs = classRanges(m[2]); } catch { /* invalid class: sampled as plain characters below */ }
  if (m[1]) { for (const c of [...new Set([...hint, 'x', 'y', 'a', '0', '_'])]) if (chars.size < 6 && !(rs && inRanges(rs, c.charCodeAt(0)))) chars.add(c); } else if (rs) {
    for (const [lo, hi] of rs) for (const c of [lo, hi, lo + ((hi - lo) >> 1)]) if (c !== 47) chars.add(String.fromCharCode(c));
  } else for (const c of m[2]) chars.add(c);
  const out = [];
  for (const c of chars) for (const rest of expandClasses(g.slice(0, m.index) + c + g.slice(m.index + m[0].length), cap, hint)) { out.push(rest); if (out.length >= cap) return out; }
  return out;
}
const fold = (s) => String(s).normalize('NFKC').toLowerCase();
/** A concrete string a brace-free glob matches: `*` -> x, `?` -> x, a [] class -> a character from inside it (a negated class -> one that is not in it). */
const sampleOf = (g) => g.replace(/\*\*\//g, 'x/').replace(/\*\*/g, 'x').replace(/[*?]/g, 'x').replace(/\[([!^]?)([^\]]*)\]/g, (m, neg, body) => (neg ? (body.includes('x') ? 'y' : 'x') : body[0] || 'x'));
/**
 * Can a path_scope entry and a deny glob name a common file? Heuristic (no regex-language intersection): tries a few concrete paths built from both globs
 * (the scope's samples, the deny's samples, and each glob's directory prefix joined with the other's tail) and asks whether both match one. Both are
 * case- and NFKC-folded (like the runtime deny check) and brace alternatives are expanded. Conservative for directory scopes (a scope that names `docs`
 * covers everything under it), so a plan that could write a denied file is rejected rather than approved. The sampler is not exhaustive: the runtime
 * policy hook (and the post-task scope check) is the authority and enforces scope_deny on every write whatever the plan-time answer was.
 */
export function scopeHitsDeny(scope, deny) {
  const clean = (x) => fold(x).replace(/^\.\//, '').replace(/\/+$/, '');
  const hintOf = (x) => [...new Set(clean(x).replace(/[^a-z0-9_.-]/g, ''))].join('');
  const variants = (x, other) => expandBraces(clean(x)).flatMap((v) => expandClasses(v, 64, hintOf(other)));
  for (const s of variants(scope, deny)) for (const d of variants(deny, scope)) if (scopeHitsDenyPlain(s, d)) return true;
  return false;
}
function scopeHitsDenyPlain(s, d) {
  if (!hasWild(s) && /\.[^/]+$/.test(s)) return matchGlob(d, s, true); // a literal name with an extension is a file, not a directory
  const dir = (g) => staticPrefix(g).join('/'); const tail = (g) => sampleOf(g.replace(/^(\*\*\/)+/, ''));
  const join = (a, b) => (a ? `${a}/${b}` : b);
  const cands = [sampleOf(s), `${sampleOf(s)}/x`, sampleOf(d), `${sampleOf(d)}/x`, join(dir(s), tail(d)), join(dir(d), tail(s)), join(dir(s), `${tail(d)}/x`), ...(hasWild(d) ? [] : [d, `${d}/x`])];
  return cands.some((c) => matchGlob(s, c) && matchGlob(d, c, true));
}

export function scopesOverlap(as, bs) {
  return (as || []).some((a) => (bs || []).some((b) => globsOverlap(a, b)));
}
