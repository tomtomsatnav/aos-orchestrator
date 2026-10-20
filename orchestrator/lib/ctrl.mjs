// Characters that could erase or rewrite what a human reads on an approval screen: C0, DEL, C1, bidi controls and marks (LRM RLM ALM, embeddings,
// overrides, isolates), zero-width characters, word joiner, BOM, line/paragraph separators and the tag block. Refused at validation, quoted at render time.
export const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u;
const CTRL_G = new RegExp(CTRL_RE.source, 'gu');
export const escCtrl = (s) => String(s).replace(CTRL_G, (c) => { const n = c.codePointAt(0); return n > 0xffff ? `\\u{${n.toString(16)}}` : `\\u${n.toString(16).padStart(4, '0')}`; });
/** A value for display: unchanged when plain, else JSON-quoted with every control/bidi character escaped. */
export const q = (v) => { const s = String(v); return CTRL_RE.test(s) ? escCtrl(JSON.stringify(s)) : s; };
