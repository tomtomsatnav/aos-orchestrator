// Linux check sandbox (bubblewrap). Skips on other platforms and on Linux hosts where bwrap is missing or cannot create
// namespaces (e.g. a container without user namespaces). The fail-closed worker tests run on every platform that is not macOS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCheck, runChecks, OUTPUT_CAP } from '../lib/checks.mjs';
import { wrapCommand, sandboxAvailable, workerSandboxAvailable } from '../lib/sandbox.mjs';
import { HERE } from './helpers.mjs';

const avail = process.platform === 'linux' ? sandboxAvailable() : { ok: false, reason: 'not Linux' };
const S = { skip: process.platform !== 'linux' ? 'bubblewrap sandbox is Linux only' : !avail.ok ? `bwrap unavailable: ${avail.reason}` : false };
const NODE = process.execPath;
const js = (code, timeout_s = 20) => ({ argv: [NODE, '-e', code], timeout_s });

function world(wtName = 'wt') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-bw-')));
  const w = { root, wt: path.join(root, wtName), goal: path.join(root, 'goal'), orch: path.join(root, 'orch'), home: path.join(root, 'home'), outside: path.join(root, 'outside') };
  for (const d of [w.wt, path.join(w.goal, 'tmp', 't1'), w.orch, w.outside, path.join(w.home, '.ssh'), path.join(w.home, '.aws')]) fs.mkdirSync(d, { recursive: true });
  w.tmp = path.join(w.goal, 'tmp', 't1');
  fs.writeFileSync(path.join(w.home, '.ssh', 'id_rsa'), 'CANARY-SSH'); fs.writeFileSync(path.join(w.goal, 'goal.json'), 'CANARY-GOAL');
  fs.writeFileSync(path.join(w.outside, 'other.txt'), 'CANARY-OTHER'); fs.writeFileSync(path.join(w.wt, 'in.txt'), 'inside\n');
  w.env = { PATH: ['/usr/bin', '/bin', path.dirname(NODE)].join(':'), HOME: w.home, TERM: 'dumb' };
  w.opts = (extra = {}) => ({ cwd: w.wt, env: { ...w.env, TMPDIR: w.tmp }, sandbox: { worktree: w.wt, tmpDir: w.tmp, goalDir: w.goal, orchDir: w.orch, home: w.home, profileDir: path.join(w.goal, 'sandbox') }, ...extra });
  w.cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return w;
}
const reads = (file) => js(`console.log(require('fs').readFileSync(${JSON.stringify(file)},'utf8'))`);

test('bwrap: a normal check reads and writes inside the worktree and is reported sandboxed', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  const r = await runCheck(js("const fs=require('fs');fs.writeFileSync('out.txt',fs.readFileSync('in.txt','utf8')+'more');console.log('fine')"), w.opts());
  assert.equal(r.ok, true, r.output); assert.equal(r.sandboxed, true);
  assert.equal(fs.readFileSync(path.join(w.wt, 'out.txt'), 'utf8'), 'inside\nmore');
});

test('bwrap: writes outside the worktree fail and leave nothing behind', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  for (const target of [path.join(w.outside, 'pwn.txt'), path.join(w.root, 'pwn2.txt'), path.join(w.home, 'pwn3.txt'), path.join(w.goal, 'pwn4.txt'), '/usr/pwn5', '/etc/pwn6']) {
    const r = await runCheck(js(`require('fs').writeFileSync(${JSON.stringify(target)},'x')`), w.opts());
    // a path under the host /tmp can be "written" inside the sandbox: it lands in the sandbox's private tmpfs, never on the host
    if (target !== path.join(w.root, 'pwn2.txt') && target !== path.join(w.goal, 'pwn4.txt')) { assert.equal(r.ok, false, target); assert.match(r.output, /EROFS|EACCES|ENOENT|EPERM/); }
    assert.equal(fs.existsSync(target), false, target);
  }
});

test('bwrap: secrets, engine state and other worktrees are not visible', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  for (const f of [path.join(w.home, '.ssh', 'id_rsa'), path.join(w.goal, 'goal.json'), path.join(w.outside, 'other.txt')]) {
    const r = await runCheck(reads(f), w.opts());
    assert.equal(r.ok, false, f); assert.doesNotMatch(r.output, /CANARY/, f);
  }
  assert.equal((await runCheck(reads(path.join(w.wt, 'in.txt')), w.opts())).ok, true, 'control: the worktree is readable');
});

test('bwrap: secrets stay hidden when the worktree itself sits under HOME or contains the goal dir', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  const wt2 = path.join(w.home, 'proj'); fs.mkdirSync(wt2);
  const o = w.opts(); o.cwd = wt2; o.sandbox = { ...o.sandbox, worktree: wt2 };
  assert.equal((await runCheck(reads(path.join(w.home, '.ssh', 'id_rsa')), o)).ok, false);
  // worktree == HOME: .ssh exists inside the bind and must be masked
  const o2 = w.opts(); o2.cwd = w.home; o2.sandbox = { ...o2.sandbox, worktree: w.home };
  const r = await runCheck(js(`const fs=require('fs');let s='';try{s=fs.readFileSync(${JSON.stringify(path.join(w.home, '.ssh', 'id_rsa'))},'utf8')}catch(e){}console.log('GOT='+s)`), o2);
  assert.equal(r.ok, true, r.output); assert.doesNotMatch(r.output, /CANARY/);
});

test('bwrap: no network, not even the host loopback (named ports do not open host ports on Linux)', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  let hits = 0;
  const srv = net.createServer((sock) => { hits++; sock.on('error', () => {}); sock.end('hello'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); t.after(() => srv.close());
  const { port } = srv.address();
  const dial = (p) => js(`const s=require('net').connect(${p},'127.0.0.1');s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.error('ERR '+e.code);process.exit(7)})`);
  const denied = await runCheck(dial(port), w.opts());
  assert.equal(denied.ok, false); assert.equal(hits, 0, 'the host server must not have seen a connection');
  const o = w.opts(); o.sandbox.ports = [port];
  assert.equal((await runCheck(dial(port), o)).ok, false, 'a named port still cannot reach the HOST loopback'); assert.equal(hits, 0);
  // inside its own network namespace a check can still run and use a private loopback server
  const own = await runCheck(js("const n=require('net');const s=n.createServer(c=>c.end('x')).listen(0,'127.0.0.1',()=>{const c=n.connect(s.address().port,'127.0.0.1');c.on('data',()=>{console.log('SELF-OK');process.exit(0)});c.on('error',e=>{console.error(e.code);process.exit(7)})})"), w.opts());
  assert.equal(own.ok, true, own.output); assert.match(own.output, /SELF-OK/);
  const external = await runCheck(js("const s=require('net').connect(443,'1.1.1.1');s.on('connect',()=>process.exit(0));s.on('error',e=>{console.error(e.code);process.exit(7)});setTimeout(()=>process.exit(8),3000)"), w.opts());
  assert.equal(external.ok, false);
});

test('bwrap: TMPDIR is the private per-check dir, /tmp is a fresh tmpfs, environment is cleared to the given minimum', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  const marker = `/tmp/aos-bw-marker-${process.pid}`; fs.writeFileSync(marker, 'host'); t.after(() => fs.rmSync(marker, { force: true }));
  const r = await runChecks([js(`const fs=require('fs');fs.writeFileSync(process.env.TMPDIR+'/scratch','1');fs.writeFileSync('/tmp/inner','1');console.log('TMP='+process.env.TMPDIR);console.log('SEES='+fs.existsSync(${JSON.stringify(marker)}));console.log('ENV='+Object.keys(process.env).sort().join(','))`)], w.opts());
  assert.equal(r.ok, true, r.results[0].output);
  const out = r.results[0].output;
  assert.ok(/TMP=(.*)/.exec(out)[1].startsWith(path.join(w.tmp, 'check-'))); assert.match(out, /SEES=false/);
  assert.equal(fs.existsSync('/tmp/inner'), false, 'a /tmp write does not reach the host');
  assert.doesNotMatch(/ENV=(.*)/.exec(out)[1], /AOS_|SSH_|AWS_|TOKEN/);
});

test('bwrap: timeouts kill the whole group, output is capped, exit codes pass through', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  const slow = await runCheck(js("require('child_process').spawn('sleep',['30']);setInterval(()=>{},1000)", 0.8), w.opts());
  assert.equal(slow.timed_out, true); assert.equal(slow.ok, false); assert.equal(slow.sandboxed, true);
  const big = await runCheck(js('process.stdout.write("x".repeat(300000))'), w.opts());
  assert.ok(big.output.length < OUTPUT_CAP + 100 && /truncated/.test(big.output)); assert.equal(big.ok, true);
  const bad = await runCheck(js('console.error("boom");process.exit(3)'), w.opts()); assert.equal(bad.exit_code, 3); assert.match(bad.output, /boom/);
  const ps = spawnSync('pgrep', ['-f', 'sleep 30'], { encoding: 'utf8' });
  assert.ok(!/\d/.test(ps.stdout || ''), 'no straggler `sleep 30` outlives the timed-out check');
});

test('bwrap: worktree paths with spaces/quotes are passed as plain argv entries; the wrapper sets die-with-parent, new-session, unshare-all, clearenv', S, async (t) => {
  const evil = 'we ird "q\'uote) $(x) ;y';
  const w = world(evil); t.after(w.cleanup);
  const wrapped = wrapCommand([NODE, '-e', '0'], { ...w.opts().sandbox, env: w.env });
  for (const f of ['--die-with-parent', '--new-session', '--unshare-all', '--clearenv']) assert.ok(wrapped.args.includes(f), f);
  assert.ok(!wrapped.args.includes('--share-net'));
  const r = await runCheck(js("require('fs').writeFileSync('ok.txt','1')"), w.opts());
  assert.equal(r.ok, true, r.output); assert.ok(fs.existsSync(path.join(w.wt, 'ok.txt')));
  assert.throws(() => wrapCommand(['-p', 'x'], { ...w.opts().sandbox, platform: 'linux' }), /must not start/);
});

test('bwrap: missing bwrap -> checks REFUSE; the explicit unsandboxed override runs them and says so', async (t) => {
  const w = world(); t.after(w.cleanup);
  const marker = path.join(w.wt, 'ran.txt'); const check = js("require('fs').writeFileSync('ran.txt','1')");
  const refused = await runCheck(check, w.opts({ sandboxBin: '/nonexistent/bwrap' }));
  if (process.platform !== 'linux') return; // the refusal path itself is platform-independent but the probe differs
  assert.equal(refused.rejected, true); assert.match(refused.output, /sandbox unavailable.*refusing to run/); assert.equal(fs.existsSync(marker), false);
  const open = await runCheck(check, w.opts({ sandboxBin: '/nonexistent/bwrap', unsandboxed: true }));
  assert.equal(open.ok, true, open.output); assert.equal(open.sandboxed, false); assert.equal(fs.existsSync(marker), true);
});

test('worker sandbox fails CLOSED off macOS (Linux: not yet supported), whatever sandbox binaries exist', () => {
  for (const platform of ['linux', 'win32']) { const r = workerSandboxAvailable({ platform }); assert.equal(r.ok, false); assert.match(r.reason, /not yet supported/); }
  assert.match(workerSandboxAvailable({ platform: 'linux' }).reason, /Linux/);
});

test('aos-orch run --sandbox-workers exits non-zero off macOS and creates no goal', { skip: process.platform === 'darwin' && 'macOS supports it' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-swl-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gf = path.join(root, 'goal.json'); fs.writeFileSync(gf, JSON.stringify({ id: 'g-x', title: 't', success_criteria: [{ id: 'c1', text: 'x', verify: 'human' }], orch: { repo: root } }));
  const r = spawnSync(NODE, [path.join(HERE, '..', 'bin', 'aos-orch.mjs'), 'run', gf, '--sandbox-workers'], { env: { ...process.env, AOS_ORCH_DIR: path.join(root, 'orch') }, encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /not yet supported on Linux/);
  assert.equal(fs.existsSync(path.join(root, 'orch', 'goals', 'g-x')), false);
});

test('aos-orch run off macOS: worker sandbox defaults OFF with a notice that checks stay sandboxed', { skip: process.platform === 'darwin' && 'macOS defaults it on' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-swn-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gf = path.join(root, 'goal.json'); fs.writeFileSync(gf, JSON.stringify({ id: 'g-n', title: 't', success_criteria: [{ id: 'c1', text: 'x', verify: 'human' }], orch: { repo: root } }));
  const r = spawnSync(NODE, [path.join(HERE, '..', 'bin', 'aos-orch.mjs'), 'run', gf, '--no-wait'], { env: { ...process.env, AOS_ORCH_DIR: path.join(root, 'orch') }, encoding: 'utf8' });
  assert.match(r.stderr, /worker OS sandbox is not supported on Linux: workers run unsandboxed \(policy hook only\); acceptance checks and self-checks still run in the OS check sandbox/);
});
