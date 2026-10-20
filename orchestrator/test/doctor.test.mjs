import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDoctor, renderDoctor, classifyClaude, checkNode, checkGit, checkClaude, checkAuth, checkStateDir, checkPort, validateStream, checkSandbox, REQUIRED_FLAGS, KNOWN_GOOD } from '../lib/doctor.mjs';

const HELP = `Usage: claude\n  -p, --print\n  --output-format <f> (stream-json)\n  --verbose\n  --settings <f>\n  --tools <t>\n  --allowedTools, --allowed-tools <t>\n  --session-id <u>\n  --max-budget-usd <n>\n  --no-session-persistence\n  --setting-sources <s>\n  --strict-mcp-config\n`;
const ok = (stdout = '', extra = {}) => ({ code: 0, stdout, stderr: '', ...extra });
/** exec stub keyed by "bin args" */
const stub = (table) => async (bin, args) => { const k = `${bin.split('/').pop()} ${args.join(' ')}`; for (const [p, v] of table) if (k.startsWith(p)) return typeof v === 'function' ? v(bin, args) : v; return { code: 127, stdout: '', stderr: 'nope', error: 'ENOENT' }; };
const mkDeps = (over = {}) => ({ platform: 'linux', nodeVersion: '22.1.0', env: {}, fs, os, which: () => '/bin/claude', portFree: async () => true, httpGet: async () => null,
  exec: stub([['git --version', ok('git version 2.40.0')], ['git worktree', { code: 129, stdout: '', stderr: 'usage: git worktree add [<options>] <path>' }],
    ['claude --version', ok('2.1.304 (Claude Code)')], ['claude --help', ok(HELP)], ['claude auth --help', ok('Commands:\n status')], ['claude auth status', ok('{"loggedIn":true,"authMethod":"claude.ai"}')]]), ...over });
const tmpOrch = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doc-')), 'orch');
const statusOf = (res, name) => res.find((x) => x.name === name || x.name.startsWith(name))?.status;

test('node version', () => {
  assert.equal(checkNode({ nodeVersion: '18.0.0' }).status, 'PASS');
  assert.equal(checkNode({ nodeVersion: '16.20.0' }).status, 'FAIL');
});
test('git version and worktree', async () => {
  assert.deepEqual((await checkGit(mkDeps())).map((x) => x.status), ['PASS', 'PASS']);
  assert.equal((await checkGit(mkDeps({ exec: stub([['git --version', ok('git version 2.3.0')]]) })))[0].status, 'FAIL');
  assert.equal((await checkGit(mkDeps({ exec: stub([]) })))[0].status, 'FAIL');
  assert.equal((await checkGit(mkDeps({ exec: stub([['git --version', ok('git version 2.40.0')], ['git worktree', { code: 1, stdout: '', stderr: 'git: not a command' }]]) })))[1].status, 'FAIL');
});
test('claude version table: FAIL older, PASS verified, WARN newer', () => {
  const [lo, hi] = [KNOWN_GOOD[0].version, KNOWN_GOOD.at(-1).version];
  assert.equal(classifyClaude('2.0.1 (Claude Code)').status, 'FAIL');
  assert.equal(classifyClaude(`${lo} (Claude Code)`).status, 'PASS');
  assert.equal(classifyClaude(`${hi}`).status, 'PASS');
  assert.equal(classifyClaude('2.9.0').status, 'WARN');
  assert.equal(classifyClaude('garbage').status, 'WARN');
});
test('claude missing / flags missing', async () => {
  assert.equal((await checkClaude(mkDeps({ which: () => null }))).results[0].status, 'FAIL');
  const good = await checkClaude(mkDeps());
  assert.deepEqual(good.results.map((x) => x.status), ['PASS', 'PASS', 'PASS']);
  const bad = await checkClaude(mkDeps({ exec: stub([['claude --version', ok('2.1.304')], ['claude --help', ok(HELP.replace('--strict-mcp-config', '').replace('--session-id <u>', ''))]]) }));
  const f = bad.results.find((x) => x.name === 'claude flags');
  assert.equal(f.status, 'FAIL'); assert.match(f.detail, /--strict-mcp-config/); assert.match(f.detail, /--session-id/);
  assert.equal(REQUIRED_FLAGS.length, 12);
  const nostream = await checkClaude(mkDeps({ exec: stub([['claude --version', ok('2.1.304')], ['claude --help', ok(HELP.replace('stream-json', 'json'))]]) }));
  assert.match(nostream.results.find((x) => x.name === 'claude flags').detail, /stream-json/);
});
test('AOS_CLAUDE_BIN overrides PATH', async () => {
  let used; const d = mkDeps({ env: { AOS_CLAUDE_BIN: '/x/fake' }, which: () => { throw new Error('no'); }, exec: async (b, a) => { used = b; return ok('2.1.304 ' + HELP); } });
  await checkClaude(d); assert.equal(used, '/x/fake');
});
test('auth: logged in / out / not detectable', async () => {
  assert.equal((await checkAuth(mkDeps(), '/bin/claude')).status, 'PASS');
  assert.equal((await checkAuth(mkDeps({ exec: stub([['claude auth --help', ok('status')], ['claude auth status', ok('{"loggedIn":false}')]]) }), '/bin/claude')).status, 'FAIL');
  assert.equal((await checkAuth(mkDeps({ exec: stub([['claude auth --help', { code: 1, stdout: '', stderr: '' }]]) }), '/bin/claude')).status, 'WARN');
  assert.equal((await checkAuth(mkDeps({ exec: stub([['claude auth --help', ok('status')], ['claude auth status', ok('not json')]]) }), '/bin/claude')).status, 'WARN');
  assert.equal((await checkAuth(mkDeps(), null)).status, 'WARN');
});
test('auth never runs a model call', async () => {
  const calls = []; const d = mkDeps({ exec: async (b, a) => { calls.push(a.join(' ')); return ok('status {"loggedIn":true}'); } });
  await checkAuth(d, '/bin/claude'); assert.ok(calls.every((c) => c.startsWith('auth')));
});
test('sandbox: non-darwin WARN, missing binary WARN, probes via exec stub', async () => {
  assert.equal((await checkSandbox(mkDeps()))[0].status, 'WARN');
  const fakeFs = { ...fs, existsSync: () => false, mkdtempSync: fs.mkdtempSync };
  assert.equal((await checkSandbox(mkDeps({ platform: 'darwin', fs: { ...fs, existsSync: () => false } })))[0].status, 'WARN');
  const seen = [];
  const res = await checkSandbox(mkDeps({ platform: 'darwin', fs: { ...fs, existsSync: () => true }, exec: async (b, a) => { seen.push(a); return ok(); } }));
  assert.deepEqual(res.map((x) => x.status), ['PASS', 'PASS', 'PASS']); assert.equal(seen.length, 2);
  assert.ok(seen.every((a) => a.slice(-3).join(' ') === '/bin/sh -c true'.split(' ').join(' ') || a.at(-1) === 'true'));
  const bad = await checkSandbox(mkDeps({ platform: 'darwin', fs: { ...fs, existsSync: () => true }, exec: async () => ({ code: 71, stdout: '', stderr: 'sandbox_apply: Operation not permitted' }) }));
  assert.equal(bad.filter((x) => x.status === 'FAIL').length, 2);
});
test('state dir: ok, loose mode WARN, unwritable FAIL', () => {
  const o = tmpOrch(); assert.equal(checkStateDir(mkDeps(), o).status, 'PASS');
  fs.chmodSync(o, 0o755); assert.equal(checkStateDir(mkDeps(), o).status, 'WARN');
  const file = path.join(path.dirname(o), 'afile'); fs.writeFileSync(file, 'x');
  assert.equal(checkStateDir(mkDeps(), path.join(file, 'sub')).status, 'FAIL');
});
test('port: free / ours / foreign / untestable', async () => {
  assert.equal((await checkPort(mkDeps(), 4319)).status, 'PASS');
  const busy = { portFree: async () => false };
  assert.match((await checkPort(mkDeps({ ...busy, httpGet: async () => ({ status: 200, body: '{"ok":true,"version":"1","workers":{},"governor":{}}' }) }), 4319)).detail, /aos-orch serve/);
  assert.equal((await checkPort(mkDeps({ ...busy, httpGet: async () => ({ status: 200, body: '<html>' }) }), 4319)).status, 'FAIL');
  assert.equal((await checkPort(mkDeps({ ...busy }), 4319)).status, 'FAIL');
  assert.equal((await checkPort(mkDeps({ portFree: async () => null }), 4319)).status, 'WARN');
});
const GOOD_STREAM = [
  { type: 'system', subtype: 'init', model: 'claude-haiku-5-5', session_id: 'abcdef012345' },
  { type: 'assistant', message: { usage: { output_tokens: 4 } } },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } },
  { type: 'result', subtype: 'success', is_error: false, session_id: 's', result: 'ok', total_cost_usd: 0.001, permission_denials: [], usage: { input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
].map((o) => JSON.stringify(o)).join('\n');
test('validateStream: good, missing result, missing usage, bad rate limit, junk', () => {
  assert.ok(validateStream(GOOD_STREAM).every((x) => x.status === 'PASS'));
  assert.equal(validateStream(GOOD_STREAM.split('\n').slice(0, 3).join('\n')).at(-1).name, 'live: result line');
  const noUsage = GOOD_STREAM.replace('"cache_read_input_tokens":0', '"x":0');
  assert.equal(statusOf(validateStream(noUsage), 'live: usage fields'), 'FAIL');
  assert.equal(statusOf(validateStream(GOOD_STREAM.replace('"status":"allowed"', '"s":1')), 'live: rate_limit_event'), 'FAIL');
  assert.equal(statusOf(validateStream(GOOD_STREAM.split('\n').filter((l) => !l.includes('rate_limit')).join('\n')), 'live: rate_limit_event'), 'PASS');
  assert.equal(validateStream('not json')[0].status, 'FAIL');
});
test('runDoctor: all green, exit codes, --live only when asked', async () => {
  const live = []; const base = mkDeps();
  const deps = { ...base, exec: async (b, a) => { if (a.includes('--max-turns')) { live.push(a); return ok(GOOD_STREAM); } return base.exec(b, a); } };
  const rep = await runDoctor({ orch: tmpOrch(), deps });
  assert.equal(rep.exitCode, 0); assert.equal(live.length, 0);
  assert.match(renderDoctor(rep), /^PASS  node: v22/);
  const rep2 = await runDoctor({ orch: tmpOrch(), deps, live: true });
  assert.equal(live.length, 1); assert.deepEqual(live[0].slice(0, 7), ['-p', '--model', 'haiku', '--max-turns', '1', '--output-format', 'stream-json']);
  assert.equal(rep2.exitCode, 0);
  const rep3 = await runDoctor({ orch: tmpOrch(), deps: mkDeps({ which: () => null }) });
  assert.equal(rep3.exitCode, 1); assert.match(renderDoctor(rep3), /FAIL  claude on PATH/);
  const rep4 = await runDoctor({ orch: tmpOrch(), deps: mkDeps({ exec: stub([['git --version', ok('git version 2.40.0')], ['git worktree', { code: 129, stdout: '', stderr: 'git worktree add' }], ['claude --version', ok('2.9.0')], ['claude --help', ok(HELP)], ['claude auth', ok('status')]]) }) });
  assert.equal(rep4.exitCode, 0); assert.ok(rep4.warns >= 1);
});
