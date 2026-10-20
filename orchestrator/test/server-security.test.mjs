// Control server security: auth matrix, rate limiting, Host/Origin/CORS/preflight, one-time login codes, content-type, body limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkSandbox, fakeClock } from './helpers.mjs';
import { startStack } from './server-helpers.mjs';
import { createLoginCode, CODE_TTL_MS, SESSION_TTL_MS } from '../server/auth.mjs';
import { parsePort } from '../server/index.mjs';

const H = (token) => ({ Authorization: `Bearer ${token}` });
const J = { 'Content-Type': 'application/json' };

async function setup(t, o = {}) {
  const sb = mkSandbox('aos-srv'); const clock = fakeClock();
  const s = await startStack(sb, { ...o, srv: { clock, ...(o.srv || {}) } });
  t.after(async () => { for (const st of sb.stacks) await st.stop().catch(() => {}); sb.cleanup(); });
  return { sb, s, clock };
}
const exchange = async (s, code, extra = {}) => s.req({ method: 'POST', path: '/auth/exchange', headers: J, body: { code }, ...extra });

test('server binds 127.0.0.1 only; token file is 0600 in a 0700 dir; ports are validated', async (t) => {
  const { sb, s } = await setup(t);
  assert.equal(s.srv.server.address().address, '127.0.0.1');
  assert.equal(fs.statSync(path.join(sb.orch, 'control-token')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(sb.orch).mode & 0o777, 0o700);
  assert.match(fs.readFileSync(path.join(sb.orch, 'control-token'), 'utf8').trim(), /^[0-9a-f]{64}$/);
  for (const bad of [80, 1023, 65536, 'x', '4319.5', -1, '']) assert.throws(() => parsePort(bad), /invalid port/);
  assert.equal(parsePort('4319'), 4319); assert.equal(parsePort(1024), 1024); assert.equal(parsePort(65535), 65535);
});

test('auth matrix: none / bad / CLI token / session token / expired session / logout; uniform error bodies', async (t) => {
  const { sb, s, clock } = await setup(t);
  const none = await s.req({ path: '/api/health' });
  assert.equal(none.status, 401); assert.deepEqual(none.json, { error: { code: 'unauthorized', message: 'authentication required' } });
  const bad = await s.req({ path: '/api/health', headers: H('0'.repeat(64)) });
  const garbage = await s.req({ path: '/api/health', headers: H('nope') });
  const basic = await s.req({ path: '/api/health', headers: { Authorization: 'Basic abc' } });
  for (const r of [bad, garbage, basic]) { assert.equal(r.status, 401); assert.equal(r.text, none.text, 'identical body whatever the failure'); }
  const cli = await s.req({ path: '/api/health', headers: H(s.token) });
  assert.equal(cli.status, 200); assert.equal(cli.json.ok, true); assert.deepEqual(Object.keys(cli.json).sort(), ['goals', 'governor', 'ok', 'version', 'workers']);
  assert.deepEqual(Object.keys(cli.json.governor).sort(), ['five_hour', 'paused', 'reason', 'resume_at', 'seven_day']);
  const ex = await exchange(s, createLoginCode(sb.orch, clock.now()));
  assert.equal(ex.status, 200); assert.match(ex.json.token, /^[0-9a-f]{64}$/); assert.equal(ex.json.expires_in_s, 43200);
  assert.notEqual(ex.json.token, s.token);
  assert.equal((await s.req({ path: '/api/goals', headers: H(ex.json.token) })).status, 200);
  assert.equal((await s.req({ method: 'POST', path: '/auth/logout', headers: { ...H(ex.json.token), ...J } })).status, 200);
  assert.equal((await s.req({ path: '/api/goals', headers: H(ex.json.token) })).status, 401, 'revoked');
  const ex2 = await exchange(s, createLoginCode(sb.orch, clock.now()));
  clock.advance(SESSION_TTL_MS - 1000);
  assert.equal((await s.req({ path: '/api/goals', headers: H(ex2.json.token) })).status, 200);
  clock.advance(2000);
  assert.equal((await s.req({ path: '/api/goals', headers: H(ex2.json.token) })).status, 401, 'expired after 12h');
  assert.equal((await s.req({ path: '/api/goals', headers: H(s.token) })).status, 200, 'the CLI token does not expire');
});

test('rate limit: 10 failures lock the IP out (even for a valid token) with Retry-After, then it recovers', async (t) => {
  const { s, clock } = await setup(t);
  for (let i = 0; i < 10; i++) assert.equal((await s.req({ path: '/api/goals', headers: H(String(i).repeat(64).slice(0, 64)) })).status, 401);
  const locked = await s.req({ path: '/api/goals', headers: H(s.token) });
  assert.equal(locked.status, 429); assert.equal(locked.json.error.code, 'rate_limited'); assert.ok(Number(locked.headers['retry-after']) > 0);
  assert.equal((await exchange(s, 'a'.repeat(32))).status, 429, 'login exchange is locked too');
  clock.advance(61000);
  assert.equal((await s.req({ path: '/api/goals', headers: H(s.token) })).status, 200);
  for (let i = 0; i < 10; i++) await s.req({ path: '/api/goals', headers: H('f'.repeat(64)) });
  const again = await s.req({ path: '/api/goals', headers: H(s.token) });
  assert.equal(again.status, 429); assert.ok(Number(again.headers['retry-after']) >= 100, 'backoff doubles');
});

test('Host header: only 127.0.0.1:<port> / localhost:<port> (DNS rebinding defence)', async (t) => {
  const { s } = await setup(t);
  const p = s.port;
  for (const host of [`localhost:${p}`, `LOCALHOST:${p}`, `127.0.0.1:${p}`]) assert.equal((await s.req({ path: '/api/health', host, headers: H(s.token) })).status, 200, host);
  for (const host of ['evil.example', `evil.example:${p}`, `127.0.0.1.evil.example:${p}`, '127.0.0.1', 'localhost', `127.0.0.1:${p + 1}`, `[::1]:${p}`, `0.0.0.0:${p}`, `localhost.:${p}`, '']) {
    const r = await s.req({ path: '/api/health', host, headers: H(s.token) });
    assert.equal(r.status, 403, `host "${host}"`); assert.equal(r.json.error.code, 'forbidden_host');
  }
  assert.equal((await s.req({ path: '/auth/login?code=x', host: 'evil.example' })).status, 403);
  assert.equal((await s.req({ method: 'OPTIONS', path: '/api/goals', host: 'evil.example', headers: { Origin: 'http://127.0.0.1:4318', 'Access-Control-Request-Method': 'GET' } })).status, 403);
});

test('Origin allowlist, CORS headers (no wildcard) and preflight', async (t) => {
  const { s } = await setup(t);
  const p = s.port;
  for (const origin of ['http://127.0.0.1:4318', 'http://localhost:4318', `http://127.0.0.1:${p}`, `http://localhost:${p}`]) {
    const r = await s.req({ path: '/api/goals', headers: { ...H(s.token), Origin: origin } });
    assert.equal(r.status, 200, origin); assert.equal(r.headers['access-control-allow-origin'], origin); assert.equal(r.headers['access-control-allow-headers'], 'Authorization, Content-Type'); assert.match(r.headers.vary, /Origin/);
  }
  for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:4319x', 'https://127.0.0.1:4318', 'http://127.0.0.1:4318.evil.example', 'http://127.0.0.1:9999', 'http://127.0.0.1:4318/']) {
    const r = await s.req({ path: '/api/goals', headers: { ...H(s.token), Origin: origin } });
    assert.equal(r.status, 403, origin); assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  const plain = await s.req({ path: '/api/goals', headers: H(s.token) });
  assert.equal(plain.headers['access-control-allow-origin'], undefined, 'no CORS headers without an Origin');
  const pre = (extra = {}) => s.req({ method: 'OPTIONS', path: '/api/goals', headers: { Origin: 'http://127.0.0.1:4318', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type', ...extra } });
  const ok = await pre();
  assert.equal(ok.status, 204); assert.equal(ok.headers['access-control-allow-origin'], 'http://127.0.0.1:4318'); assert.equal(ok.headers['access-control-allow-headers'], 'Authorization, Content-Type');
  assert.match(ok.headers['access-control-allow-methods'], /PATCH/); assert.ok(!Object.values(ok.headers).includes('*'));
  assert.equal((await pre({ Origin: 'http://evil.example' })).status, 403);
  assert.equal((await pre({ 'Access-Control-Request-Headers': 'x-evil' })).status, 403);
  assert.equal((await pre({ 'Access-Control-Request-Method': 'DELETE' })).status, 403);
  assert.equal((await s.req({ method: 'OPTIONS', path: '/api/goals', headers: { 'Access-Control-Request-Method': 'GET' } })).status, 403, 'preflight without Origin');
  const post = await s.req({ method: 'POST', path: '/api/goals', headers: { ...H(s.token), ...J, Origin: 'http://evil.example' }, body: {} });
  assert.equal(post.status, 403, 'a mutating cross-origin request is refused before anything runs');
});

test('login: GET does not consume the code, exchange is single use, expires after 2 minutes, stored hashed, no cookies, fragment redirect', async (t) => {
  const { sb, s, clock } = await setup(t, { srv: { dashboardUrl: 'http://127.0.0.1:4318/' } });
  const code = createLoginCode(sb.orch, clock.now());
  for (const n of fs.readdirSync(path.join(sb.orch, 'login-codes'))) assert.ok(!n.includes(code) && !fs.readFileSync(path.join(sb.orch, 'login-codes', n), 'utf8').includes(code), 'only a hash is stored');
  for (let i = 0; i < 3; i++) {
    const page = await s.req({ path: `/auth/login?code=${code}` });
    assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/); assert.equal(page.headers['set-cookie'], undefined);
    assert.match(page.text, /#aos_token=/); assert.ok(!page.text.includes(code), 'the page never embeds the code');
    assert.match(page.text, /http:\/\/127\.0\.0\.1:4318\//);
  }
  const own = { Origin: `http://127.0.0.1:${s.port}` };
  const ex = await s.req({ method: 'POST', path: '/auth/exchange', headers: { ...J, ...own }, body: { code } });
  assert.equal(ex.status, 200); assert.equal(ex.headers['set-cookie'], undefined); assert.match(ex.headers['access-control-allow-origin'], /127\.0\.0\.1/);
  assert.equal((await exchange(s, code)).status, 401, 'single use');
  const c2 = createLoginCode(sb.orch, clock.now());
  clock.advance(CODE_TTL_MS + 1000);
  assert.equal((await exchange(s, c2)).status, 401, 'expired');
  for (const bad of ['', 'zz', 'a'.repeat(31), 'A'.repeat(32), 123, null]) assert.ok([400, 401].includes((await exchange(s, bad)).status));
  assert.equal((await s.req({ method: 'POST', path: '/auth/exchange', headers: { 'Content-Type': 'text/plain' }, body: `code=${code}` })).status, 415);
  assert.equal((await s.req({ method: 'GET', path: '/auth/exchange' })).status, 405);
  const dash = await setup(t, { srv: { dashboardUrl: 'http://127.0.0.1:5173/app' } });
  assert.match((await dash.s.req({ path: '/auth/login?code=x' })).text, /127\.0\.0\.1:5173\/app/);
  assert.equal((await dash.s.api('GET', '/api/goals', undefined, { headers: { Origin: 'http://127.0.0.1:5173' } })).status, 200, 'the configured dashboard origin is allowed');
});

test('mutations need application/json; body limit 64 KB; strict JSON; 404 / 405', async (t) => {
  const { s } = await setup(t);
  const post = (headers, body, extra = {}) => s.req({ method: 'POST', path: '/api/goals', headers: { ...H(s.token), ...headers }, body, ...extra });
  for (const ct of [{}, { 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/x-www-form-urlencoded' }, { 'Content-Type': 'multipart/form-data; boundary=x' }, { 'Content-Type': 'application/jsonp' }]) {
    const r = await post(ct, 'title=x'); assert.equal(r.status, 415, JSON.stringify(ct)); assert.equal(r.json.error.code, 'unsupported_media_type');
  }
  assert.equal((await post(J, '{not json')).status, 400);
  assert.equal((await post({ 'Content-Type': 'application/json; charset=utf-8' }, '[]')).status, 400);
  const big = JSON.stringify({ title: 'x'.repeat(70000) });
  const r1 = await post(J, big); assert.equal(r1.status, 413);
  const r2 = await post(J, big, { chunked: true }); assert.equal(r2.status, 413, 'no content-length');
  assert.equal((await post(J, JSON.stringify({ title: 'x'.repeat(63000) }))).status, 400, 'under the limit it reaches validation');
  assert.equal((await s.req({ path: '/api/nope', headers: H(s.token) })).status, 404);
  assert.equal((await s.req({ path: '/nope' })).status, 404);
  assert.equal((await s.req({ path: '/api/nope' })).status, 401, 'routes are not revealed to unauthenticated callers');
  const m = await s.req({ method: 'DELETE', path: '/api/goals', headers: H(s.token) });
  assert.equal(m.status, 405); assert.match(m.headers.allow, /GET/); assert.match(m.headers.allow, /POST/);
  assert.equal((await s.req({ method: 'GET', path: '/api/goals/g-x/pause', headers: H(s.token) })).status, 405);
  assert.equal((await s.req({ path: '/api/goals/..%2f..', headers: H(s.token) })).status, 400);
  assert.equal((await s.req({ path: '/api/goals/g-nope', headers: H(s.token) })).status, 404);
  assert.equal((await s.req({ path: '//evil', headers: H(s.token) })).status, 400);
});

test('tokens, session ids and login codes never reach the logs', async (t) => {
  const { sb, s, clock } = await setup(t);
  const code = createLoginCode(sb.orch, clock.now());
  await s.req({ path: `/auth/login?code=${code}` });
  const ex = await exchange(s, code);
  await s.req({ path: '/api/goals', headers: H(ex.json.token) });
  await s.req({ path: '/api/goals', headers: H('9'.repeat(64)) });
  const all = s.logs.join('\n');
  assert.ok(s.logs.length >= 4);
  for (const secret of [s.token, ex.json.token, code, '9'.repeat(64)]) assert.ok(!all.includes(secret));
  assert.ok(!all.includes('?'), 'query strings are never logged');
});
