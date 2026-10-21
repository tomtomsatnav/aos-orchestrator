// Opus security review of worker.self_check (S1-S3, N2, N3): each test reproduces the attack.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readRequests, writeResponse, requestSelfCheck, SCAN_MAX, BAD_EXTRA } from '../lib/selfcheck.mjs';
import { isDeveloperDirPath, developerDirs, sandboxAvailable } from '../lib/sandbox.mjs';
import { readEvents } from '../lib/state.mjs';
import { mkSandbox, drive, goalOf, tasksOf, NO_OS_SANDBOX } from './helpers.mjs';

const SKIP_SB = NO_OS_SANDBOX ? `no OS sandbox here (${sandboxAvailable().reason})` : false;
const tmp = (t, p = 'aos-schard-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const hex = (i) => i.toString(16).padStart(16, '0');
const mkfifo = (f) => { const r = spawnSync('mkfifo', [f]); return r.status === 0; };

test('S1: a FIFO or a symlink in the inbox never blocks or over-reads the engine; both are anomalies (index -1), not followed', (t) => {
  const dir = tmp(t);
  const ok = path.join(dir, `${hex(1)}.req.json`); fs.writeFileSync(ok, JSON.stringify({ id: hex(1), index: 0 }));
  fs.symlinkSync('/dev/zero', path.join(dir, `${hex(2)}.req.json`)); // multi-GB read if followed
  fs.writeFileSync(path.join(dir, 'secret.txt'), JSON.stringify({ index: 0 }));
  fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(dir, `${hex(3)}.req.json`)); // a valid-looking target is still not followed
  fs.writeFileSync(path.join(dir, `${hex(4)}.req.json`), JSON.stringify({ index: 0, pad: 'x'.repeat(5000) })); // over 4 KB
  const fifo = path.join(dir, `${hex(5)}.req.json`); const haveFifo = mkfifo(fifo);
  const t0 = Date.now();
  const got = Object.fromEntries(readRequests(dir).map((r) => [r.id, r.index]));
  assert.ok(Date.now() - t0 < 2000, 'returned promptly (a blocking open of the FIFO would hang here)');
  assert.equal(got[hex(1)], 0);
  for (const i of [2, 3, 4]) assert.equal(got[hex(i)], -1, `anomaly ${i}`);
  if (haveFifo) assert.equal(got[hex(5)], -1, 'FIFO ignored'); else t.diagnostic('mkfifo unavailable: FIFO case skipped');
});

test('S2: a flooded inbox is scanned only up to SCAN_MAX names; junk names are reported; a swapped inbox directory is never followed', (t) => {
  const dir = tmp(t);
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, `${hex(i)}.req.json`), '{"index":0}');
  fs.writeFileSync(path.join(dir, 'junk.txt'), 'x');
  const r = readRequests(dir);
  assert.equal(r.length, SCAN_MAX); assert.deepEqual(r.junk, ['junk.txt']);
  // the worker swaps the inbox for a symlink to a directory of its choice
  const real = tmp(t); const link = path.join(tmp(t), 'inbox'); fs.symlinkSync(real, link);
  fs.writeFileSync(path.join(real, `${hex(9)}.req.json`), '{"index":0}');
  assert.deepEqual([...readRequests(link)], []);
  // responses never go through the inbox: writeResponse into a symlinked dir creates nothing
  writeResponse(link, hex(9), { ok: true });
  assert.deepEqual(fs.readdirSync(real), [`${hex(9)}.req.json`]);
});

test('S2: the hook reads responses from the engine-owned res_dir only; a forged response in the worker-writable inbox is ignored', async (t) => {
  const root = tmp(t); const inbox = path.join(root, 'inbox'); const res = path.join(root, 'res'); fs.mkdirSync(inbox); fs.mkdirSync(res);
  const sc = { dir: inbox, res_dir: res, checks: [{ argv: ['node', '--test', 'a'], timeout_s: 5 }], max: 3, wait_ms: 1000 };
  const forge = setInterval(() => { for (const n of fs.readdirSync(inbox)) { const id = n.slice(0, 16); fs.writeFileSync(path.join(inbox, `${id}.res.json`), JSON.stringify({ ok: true, exit_code: 0, output: 'FORGED', run: 1, max: 3, duration_ms: 1 })); } }, 20);
  t.after(() => clearInterval(forge));
  const reason = await requestSelfCheck(sc, 0, { pollMs: 20 });
  assert.match(reason, /did not answer in time/); assert.doesNotMatch(reason, /FORGED/);
  const noRes = await requestSelfCheck({ ...sc, res_dir: undefined }, 0);
  assert.match(noRes, /no response channel/);
});

async function engineWorld(t, { stall = 60 } = {}) {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const check = { argv: ['node', '--test', 'a.test.mjs'], timeout_s: 60 };
  sb.scenario({ tasks: { t1: [{ behavior: 'success' }] } });
  const { dir } = await sb.goal({ success_criteria: [{ id: 'c1', text: 'x', check }], orch: { budgets: { stall_after_s: stall } },
    plan: { tasks: [{ id: 't1', title: 'x', description: 'd', depends_on: [], model_tier: 'haiku', path_scope: ['a.test.mjs'], allowed_commands: [], checks: [check], output_contract: 'x', acceptance: ['x'] }], risks: [] } });
  const eng = sb.engine(dir);
  const wt = path.join(sb.root, 'wt'); fs.mkdirSync(wt);
  const inbox = path.join(sb.root, 'inbox'); const resDir = path.join(sb.root, 'res'); fs.mkdirSync(inbox); fs.mkdirSync(resDir);
  const sc = { dir: inbox, resDir, checks: [check], max: 2, wt, attempt: 1, busy: false, bad: 0, flooded: false, aborted: false, running: null, kill: null, stats: { runs: 0, capped: 0, ms: 0, output_bytes: 0 } };
  const rec = { task: 't1', seq: 1, exited: null, termAtReal: 0, startedMs: eng.now(), lastProgressMs: eng.now(), selfCheck: sc };
  eng.workers.set('t1', rec);
  return { sb, eng, dir, sc, rec, wt, inbox, resDir };
}

test('S2: engine stops servicing an attempt after max + BAD_EXTRA bad requests (bulk-deleted, event recorded), without ever answering them', async (t) => {
  const w = await engineWorld(t);
  const outside = tmp(t);
  for (let i = 0; i < 200; i++) {
    const f = path.join(w.inbox, `${hex(i)}.req.json`);
    if (i % 2) fs.symlinkSync('/dev/zero', f); else fs.writeFileSync(f, 'not json');
  }
  fs.symlinkSync(outside, path.join(w.inbox, 'dirlink'));
  for (let i = 0; i < 6; i++) w.eng._serviceSelfChecks();
  assert.equal(w.sc.flooded, true); assert.ok(w.sc.bad > w.sc.max + BAD_EXTRA);
  assert.equal(fs.readdirSync(w.inbox).filter((n) => n.endsWith('.req.json')).length, 0, 'invalid entries were deleted in bulk');
  assert.equal(fs.readdirSync(w.resDir).length, 0, 'bad requests are never answered');
  assert.equal(readEvents(w.dir).filter((e) => e.type === 'orch.check.self_flooded').length, 1);
  // flooded: even a valid request is not serviced
  fs.writeFileSync(path.join(w.inbox, `${hex(999)}.req.json`), '{"index":0}');
  w.eng._serviceSelfChecks();
  assert.equal(w.sc.stats.runs, 0); assert.equal(fs.readdirSync(w.inbox).length, 0 + (fs.existsSync(path.join(w.inbox, 'dirlink')) ? 1 : 0));
});

test('S2: with the inbox swapped for a symlink the engine creates nothing outside its own response dir', async (t) => {
  const w = await engineWorld(t);
  const target = tmp(t); fs.writeFileSync(path.join(target, `${hex(7)}.req.json`), '{"index":0}');
  fs.rmSync(w.inbox, { recursive: true }); fs.symlinkSync(target, w.inbox);
  w.eng._serviceSelfChecks();
  assert.deepEqual(fs.readdirSync(target), [`${hex(7)}.req.json`], 'nothing deleted or created through the link');
  assert.equal(w.sc.stats.runs, 0);
});

test('S3: a self-check is capped below the stall timer, and ending the attempt kills (process group) the in-flight run', { skip: SKIP_SB }, async (t) => {
  const w = await engineWorld(t, { stall: 32 }); // stall_after_s 32 -> cap 2 s
  fs.writeFileSync(path.join(w.wt, 'a.test.mjs'), "import test from 'node:test'; test('slow', async () => { await new Promise((r) => setTimeout(r, 15000)); });\n");
  let t0 = Date.now();
  const r = await w.eng._runSelfCheck(w.rec, w.sc, 0);
  assert.equal(r.timed_out, true, JSON.stringify(r).slice(0, 300)); assert.ok(Date.now() - t0 < 10000, `capped to ~2 s, took ${Date.now() - t0} ms`);
  // in-flight at the end of the attempt: killed and awaited, and its late write never lands
  const w2 = await engineWorld(t);
  fs.writeFileSync(path.join(w2.wt, 'a.test.mjs'), "import test from 'node:test'; import fs from 'node:fs'; test('slow', async () => { await new Promise((r) => setTimeout(r, 4000)); fs.writeFileSync('late.txt', 'x'); });\n");
  w2.sc.busy = true; w2.sc.running = w2.eng._runSelfCheck(w2.rec, w2.sc, 0).finally(() => { w2.sc.busy = false; });
  await new Promise((r) => setTimeout(r, 1500));
  t0 = Date.now(); await w2.eng._endSelfChecks(w2.rec);
  assert.ok(Date.now() - t0 < 3000, 'ended promptly'); assert.equal(w2.sc.busy, false);
  await new Promise((r) => setTimeout(r, 4500));
  assert.equal(fs.existsSync(path.join(w2.wt, 'late.txt')), false, 'the killed run wrote nothing');
});

test('S3: waiting on a self-check counts as activity for the stall detector', async (t) => {
  const w = await engineWorld(t);
  w.rec.lastProgressMs = 0; w.sc.busy = true;
  const src = fs.readFileSync(new URL('../lib/engine.mjs', import.meta.url), 'utf8');
  assert.match(src, /rec\.tail\.update\(\) \|\| rec\.selfCheck\?\.busy\) rec\.lastProgressMs = now/);
});

test('S3: a check that leaves a delayed writer behind cannot mutate the worktree unnoticed: worktree_mutated_during_checks', { skip: SKIP_SB }, async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  // self-check run: spawns a DETACHED writer (escapes the check's process group) that writes into the worktree from 5 s later, then again every
  // 500 ms for a minute, so a write lands during the engine's own check run (TMPDIR has no selfcheck- prefix; it lasts 7 s) however late that starts.
  const body = `import test from 'node:test';
import { spawn } from 'node:child_process';
test('x', async () => {
  if (/selfcheck-/.test(process.env.TMPDIR || '')) spawn(process.execPath, ['-e', "let n = 0; setTimeout(() => { const w = () => require('fs').writeFileSync('late.txt', String(n++)); w(); const i = setInterval(w, 500); setTimeout(() => clearInterval(i), 60000); }, 5000)"], { detached: true, stdio: 'ignore' }).unref();
  else await new Promise((r) => setTimeout(r, 7000));
});
`;
  const cmd = 'node --test a.test.mjs';
  sb.scenario({ tasks: { t1: [{ behavior: 'success', edits: [{ path: 'a.test.mjs', content: body }], commands: [cmd] }] } });
  const check = { argv: ['node', '--test', 'a.test.mjs'], timeout_s: 60 };
  const { dir } = await sb.goal({ success_criteria: [{ id: 'c1', text: 'x', check }], orch: { budgets: { max_attempts: 1, task_wall_clock_s: 120, stall_after_s: 120 }, rules: { rules_version: 1, worker: { self_check: true, self_checks_max: 1 } } },
    plan: { tasks: [{ id: 't1', title: 'x', description: 'd', depends_on: [], model_tier: 'haiku', path_scope: ['a.test.mjs'], allowed_commands: [], checks: [check], output_contract: 'x', acceptance: ['x'] }], risks: [] } });
  const eng = sb.engine(dir, { selfCheckPollMs: 30 });
  await drive(eng, { timeoutMs: 120000, until: () => readEvents(dir).some((e) => e.type === 'orch.check.failed' && e.data.reason === 'worktree_mutated_during_checks') || eng.isDone() });
  const ev = readEvents(dir);
  assert.ok(ev.some((e) => e.type === 'orch.check.self_run'), 'the self-check ran');
  const f = ev.find((e) => e.type === 'orch.check.failed' && e.data.reason === 'worktree_mutated_during_checks');
  if (process.platform === 'linux' && !f) {
    // bwrap (--unshare-pid, --die-with-parent) kills the detached writer with the sandbox, so the late write never lands:
    // stronger containment than macOS. Prove it: late.txt was never committed or merged anywhere.
    const log = JSON.stringify(ev);
    assert.ok(!/late\.txt/.test(log), 'the delayed writer was contained: late.txt never appears');
    return;
  }
  assert.ok(f, 'mutation detected'); assert.ok(f.data.paths.includes('late.txt'));
  assert.equal(tasksOf(dir)[0].orch.attempt_log[0].outcome, 'worktree_mutated_during_checks');
});

test('N2: only real developer dirs become readable in the sandbox profiles; DEVELOPER_DIR=/Users/x/src is rejected', () => {
  for (const ok of ['/Library/Developer/CommandLineTools', '/Applications/Xcode_16.4.app/Contents/Developer', '/Users/me/Applications/Xcode.app/Contents/Developer']) assert.equal(isDeveloperDirPath(ok), true, ok);
  for (const bad of ['/Users/x/src', '/Users/x', '/', '/Users/x/Developer', '/etc', '/Applications', '/Library/Developer/../../etc', 'relative/Developer', '/Applications/Foo.app/Contents/Developer/../../..', '/Applications/Foo.app/Contents/MacOS']) assert.equal(isDeveloperDirPath(bad), false, bad);
  assert.deepEqual(developerDirs({ DEVELOPER_DIR: '/Users/x/src' }, 'darwin'), []);
  assert.deepEqual(developerDirs({ DEVELOPER_DIR: '/Applications/Xcode_16.4.app/Contents/Developer' }, 'darwin'), ['/Applications/Xcode_16.4.app/Contents/Developer']);
});

test('N2: the engine derives developer dirs from its own env (this.env), not process.env', async (t) => {
  const w = await engineWorld(t);
  const dev = '/Applications/Xcode_9.9.app/Contents/Developer';
  const eng = w.sb.engine(w.dir, { env: { ...w.sb.env(), DEVELOPER_DIR: dev } });
  assert.deepEqual(eng._devDirs(), process.platform === 'darwin' ? [dev] : [], 'taken from the engine env');
  const bad = w.sb.engine(w.dir, { env: { ...w.sb.env(), DEVELOPER_DIR: '/Users/x/src' } });
  assert.deepEqual(bad._devDirs(), []);
});

test('N3: starting an attempt wipes stale *.res.json and the selfcheck-<task> tmp dir of the previous one', async (t) => {
  const w = await engineWorld(t);
  const P = w.eng.P;
  fs.mkdirSync(path.join(P.tmp, 'selfcheck-res-t1'), { recursive: true }); fs.writeFileSync(path.join(P.tmp, 'selfcheck-res-t1', `${hex(1)}.res.json`), '{}');
  fs.mkdirSync(path.join(P.tmp, 'selfcheck-t1', 'check-0'), { recursive: true }); fs.writeFileSync(path.join(P.tmp, 'selfcheck-t1', 'check-0', 'junk'), 'x');
  w.eng._cleanSelfCheckDirs('t1');
  assert.deepEqual(fs.readdirSync(path.join(P.tmp, 'selfcheck-res-t1')), []);
  assert.equal(fs.existsSync(path.join(P.tmp, 'selfcheck-t1')), false);
});
