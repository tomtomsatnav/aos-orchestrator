// Control-server credentials. (a) CLI token: 32 random bytes hex in <orch>/control-token (0600, dir 0700). (b) Browser session
// tokens: obtained by exchanging a one-time login code (random, 2 minutes, single use, stored hashed in <orch>/login-codes/);
// sessions are random, expire after 12 h, are kept in MEMORY ONLY (a server restart requires a new login link) and are revocable.
// Plus a per-IP failed-auth limiter with backoff. Tokens are never logged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TOKEN_RE = /^[0-9a-f]{64}$/;
const CODE_RE = /^[0-9a-f]{32}$/;
export const CODE_TTL_MS = 2 * 60 * 1000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const tokenFile = (orchDir) => path.join(orchDir, 'control-token');

/** Create the token file on first use (dir 0700, file 0600, O_EXCL). Existing files are tightened to 0600. Returns the path. */
export function ensureCliToken(orchDir) {
  fs.mkdirSync(orchDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(orchDir, 0o700); } catch { /* not ours */ }
  const f = tokenFile(orchDir);
  try {
    const fd = fs.openSync(f, 'wx', 0o600);
    fs.writeSync(fd, `${crypto.randomBytes(32).toString('hex')}\n`);
    fs.closeSync(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try { fs.chmodSync(f, 0o600); } catch { /* ignore */ }
    if (!TOKEN_RE.test(fs.readFileSync(f, 'utf8').trim())) throw new Error('control-token exists but is not a 64-hex token; delete it to regenerate');
  }
  return f;
}
export const readCliToken = (orchDir) => fs.readFileSync(ensureCliToken(orchDir), 'utf8').trim();

/** Write a one-time login code (hashed) and return the plaintext code. Used by `aos-orch login-link` and by tests. */
export function createLoginCode(orchDir, now = Date.now()) {
  const dir = path.join(orchDir, 'login-codes');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const n of fs.readdirSync(dir)) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); if (!(j.expires_ms > now)) fs.unlinkSync(path.join(dir, n)); } catch { try { fs.unlinkSync(path.join(dir, n)); } catch { /* gone */ } } }
  const code = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, `${sha(code)}.json`), JSON.stringify({ expires_ms: now + CODE_TTL_MS }), { mode: 0o600 });
  return code;
}

export class Auth {
  constructor({ orchDir, clock = { now: () => Date.now() }, maxFailures = 10, windowMs = 60000 }) {
    this.orchDir = orchDir; this.clock = clock; this.maxFailures = maxFailures; this.windowMs = windowMs;
    this.cliDigest = Buffer.from(sha(readCliToken(orchDir)), 'hex');
    this.sessions = new Map(); // sha256(token) -> {id, expires_ms}
    this.ips = new Map(); // ip -> {fails:[ms], lockedUntil, level, lastFail}
  }

  // ---- rate limiting (failed credentials only)
  blocked(ip) {
    const r = this.ips.get(ip); const now = this.clock.now();
    if (r && r.lockedUntil > now) return Math.ceil((r.lockedUntil - now) / 1000);
    return 0;
  }
  fail(ip) {
    const now = this.clock.now();
    let r = this.ips.get(ip);
    if (!r) { if (this.ips.size > 1000) this.ips.clear(); r = { fails: [], lockedUntil: 0, level: 0, lastFail: 0 }; this.ips.set(ip, r); }
    if (now - r.lastFail > 15 * 60000) r.level = 0;
    r.lastFail = now;
    r.fails = r.fails.filter((t) => now - t < this.windowMs); r.fails.push(now);
    if (r.fails.length >= this.maxFailures) { r.lockedUntil = now + Math.min(60000 * 2 ** r.level, 15 * 60000); r.level++; r.fails = []; }
  }

  // ---- bearer
  /** -> {kind:'cli'} | {kind:'session', id} | null. Constant-time for the CLI token. */
  verify(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const d = Buffer.from(sha(token), 'hex');
    if (crypto.timingSafeEqual(d, this.cliDigest)) return { kind: 'cli', id: 'cli' };
    const s = this.sessions.get(d.toString('hex'));
    if (!s) return null;
    if (s.expires_ms <= this.clock.now()) { this.sessions.delete(d.toString('hex')); return null; }
    return { kind: 'session', id: s.id };
  }
  /** Audit identity: a hash of the session id, never the token. */
  auditId(p) { return p.kind === 'cli' ? 'cli' : `sess:${sha(p.id).slice(0, 16)}`; }

  // ---- login codes -> sessions
  exchange(code) {
    if (typeof code !== 'string' || !CODE_RE.test(code)) return null;
    const f = path.join(this.orchDir, 'login-codes', `${sha(code)}.json`);
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
    try { fs.unlinkSync(f); } catch { return null; } // single use: only the first unlink wins
    if (!(j.expires_ms > this.clock.now())) return null;
    const token = crypto.randomBytes(32).toString('hex'); const id = crypto.randomBytes(8).toString('hex');
    const now = this.clock.now();
    for (const [k, s] of this.sessions) if (s.expires_ms <= now) this.sessions.delete(k);
    if (this.sessions.size >= 50) this.sessions.delete(this.sessions.keys().next().value);
    this.sessions.set(sha(token), { id, expires_ms: now + SESSION_TTL_MS });
    return { token, expires_ms: now + SESSION_TTL_MS };
  }
  revoke(token) { return this.sessions.delete(sha(token)); }
  revokeAll() { const n = this.sessions.size; this.sessions.clear(); return n; }
}
