// Also soft hyphen, combining grapheme joiner, Hangul fillers, Mongolian vowel separator, invisible operators (U+2061-2064), the deprecated format controls U+206A-206F,
// interlinear annotation marks and lone surrogates.
// Characters that could erase or rewrite what a human reads on an approval screen: C0, DEL, C1, bidi controls and marks (LRM RLM ALM, embeddings,
// overrides, isolates), zero-width characters, word joiner, BOM, line/paragraph separators and the tag block. Refused at validation, quoted at render time.
export const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}\ud800-\udfff]/u; // /u: a surrogate class matches only LONE surrogates
const CTRL_G = new RegExp(CTRL_RE.source, 'gu');
export const escCtrl = (s) => String(s).replace(CTRL_G, (c) => { const n = c.codePointAt(0); return n > 0xffff ? `\\u{${n.toString(16)}}` : `\\u${n.toString(16).padStart(4, '0')}`; });
/** A value for display: unchanged when plain, else JSON-quoted with every control/bidi character escaped. */
/** Escape only what JSON.stringify leaves raw: C1, bidi, invisible and surrogate characters (C0 is already escaped by JSON.stringify). For JSON output. */
export const escBeyondC0 = (s) => String(s).replace(CTRL_G, (c) => { const n = c.codePointAt(0); return n <= 0x1f ? c : n > 0xffff ? `\\u{${n.toString(16)}}` : `\\u${n.toString(16).padStart(4, '0')}`; });
export const q = (v) => { const s = String(v); return CTRL_RE.test(s) ? escCtrl(JSON.stringify(s)) : s; };
