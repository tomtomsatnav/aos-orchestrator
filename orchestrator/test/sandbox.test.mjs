// Condition 4: acceptance checks run under macOS sandbox-exec (deny-default profile, paths as -D parameters).
// macOS only: other platforms skip these tests (and the engine refuses to run checks unless orch.unsandboxed_checks is set).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { runCheck, runChecks, OUTPUT_CAP } from '../lib/checks.mjs';
import { buildProfile, wrapCommand, sandboxAvailable, SANDBOX_EXEC } from '../lib/sandbox.mjs';
import { mkSandbox, drive, goalOf, tasksOf, fakeCalls, ptask, crit, edit, types } from './helpers.mjs';
import { readEvents } from '../lib/state.mjs';

const avail = sandboxAvailable();
const SKIP = process.platform !== 'darwin' ? 'sandbox-exec is macOS only: skipped on this platform' : !avail.ok ? `sandbox-exec unavailable: ${avail.reason}` : false;
const S = { skip: SKIP };
const NODE = process.execPath;
const js = (code, timeout_s = 20) => ({ argv: [NODE, '-e', code], timeout_s });

/** Throwaway world: worktree, goal dir with a private tmp, a fake HOME with canary secrets, engine state files. */
function world(wtName = 'wt') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sbx-')));
  const w = { root, wt: path.join(root, wtName), goal: path.join(root, 'goal'), orch: path.join(root, 'orch'), home: path.join(root, 'home'), outside: path.join(root, 'outside') };
  for (const d of [w.wt, path.join(w.goal, 'tmp', 't1'), path.join(w.goal, 'approvals'), w.orch, w.outside, path.join(w.home, '.ssh'), path.join(w.home, '.aws'), path.join(w.home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  w.tmp = path.join(w.goal, 'tmp', 't1');
  fs.writeFileSync(path.join(w.home, '.ssh', 'id_rsa'), 'CANARY-SSH'); fs.writeFileSync(path.join(w.home, '.aws', 'credentials'), 'CANARY-AWS');
  fs.writeFileSync(path.join(w.home, '.claude', 'settings.json'), 'CANARY-CLAUDE');
  fs.writeFileSync(path.join(w.goal, 'goal.json'), 'CANARY-GOAL'); fs.writeFileSync(path.join(w.goal, 'approvals', 'A-1.json'), 'CANARY-APPROVAL'); fs.writeFileSync(path.join(w.orch, 'policy.default.json'), 'CANARY-POLICY');
  fs.writeFileSync(path.join(w.outside, 'other-worktree.txt'), 'CANARY-OTHER'); fs.writeFileSync(path.join(w.wt, 'in.txt'), 'inside\n');
  w.env = { PATH: ['/usr/bin', '/bin', path.dirname(NODE)].join(':'), HOME: w.home, TERM: 'dumb' };
  w.opts = (extra = {}) => ({ cwd: w.wt, env: { ...w.env, TMPDIR: w.tmp }, sandbox: { worktree: w.wt, tmpDir: w.tmp, goalDir: w.goal, orchDir: w.orch, home: w.home, profileDir: path.join(w.goal, 'sandbox') }, ...extra });
  w.cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return w;
}
const reads = (file) => js(`console.log(require('fs').readFileSync(${JSON.stringify(file)},'utf8'))`);

test('sandbox: a normal node -e check that reads and writes inside the worktree passes (sandboxed)', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  const r = await runCheck(js("const fs=require('fs');fs.writeFileSync('out.txt',fs.readFileSync('in.txt','utf8')+'more');if(fs.readFileSync('out.txt','utf8')!=='inside\\nmore')process.exit(3);console.log('fine')"), w.opts());
  assert.equal(r.ok, true, r.output); assert.equal(r.sandboxed, true); assert.match(r.output, /fine/);
  assert.equal(fs.readFileSync(path.join(w.wt, 'out.txt'), 'utf8'), 'inside\nmore');
});

test('sandbox: writes outside the worktree fail (and leave nothing behind)', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  for (const target of [path.join(w.outside, 'pwn.txt'), path.join(w.root, 'pwn2.txt'), path.join(w.home, 'pwn3.txt'), path.join(w.goal, 'pwn4.txt'), path.join(w.orch, 'pwn5.txt'), '/tmp/aos-sbx-pwn6.txt']) {
    const r = await runCheck(js(`require('fs').writeFileSync(${JSON.stringify(target)},'x')`), w.opts());
    assert.equal(r.ok, false, target); assert.match(r.output, /EPERM|EACCES|not permitted/i);
    assert.equal(fs.existsSync(target), false, target);
  }
});

test('sandbox: reads of secrets (fake HOME canaries), engine state and other worktrees fail', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  for (const f of [path.join(w.home, '.ssh', 'id_rsa'), path.join(w.home, '.aws', 'credentials'), path.join(w.home, '.claude', 'settings.json'), path.join(w.goal, 'goal.json'),
    path.join(w.goal, 'approvals', 'A-1.json'), path.join(w.orch, 'policy.default.json'), path.join(w.outside, 'other-worktree.txt')]) {
    const r = await runCheck(reads(f), w.opts());
    assert.equal(r.ok, false, f); assert.doesNotMatch(r.output, /CANARY/, f); assert.match(r.output, /EPERM|EACCES|not permitted/i);
  }
  const ls = await runCheck(js(`console.log(require('fs').readdirSync(${JSON.stringify(path.join(w.home, '.ssh'))}))`), w.opts());
  assert.equal(ls.ok, false);
  const ok = await runCheck(reads(path.join(w.wt, 'in.txt')), w.opts()); assert.equal(ok.ok, true, 'control: the worktree itself is readable');
});

test('sandbox: the profile also protects secrets when the worktree itself sits under HOME (explicit denies come after the allows)', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  const wt2 = path.join(w.home, 'proj'); fs.mkdirSync(wt2);
  const o = w.opts(); o.cwd = wt2; o.sandbox = { ...o.sandbox, worktree: wt2 };
  assert.equal((await runCheck(reads(path.join(w.home, '.ssh', 'id_rsa')), o)).ok, false);
  assert.equal((await runCheck(js("require('fs').writeFileSync('x','1')"), o)).ok, true);
});

test('sandbox: network is denied, including 127.0.0.1 on a test-owned port, unless the goal names the port', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  let hits = 0;
  const srv = net.createServer((sock) => { hits++; sock.on('error', () => {}); sock.end('hello'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); t.after(() => srv.close());
  const { port } = srv.address();
  const dial = (p) => js(`const s=require('net').connect(${p},'127.0.0.1');s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.error('ERR '+e.code);process.exit(7)})`);
  const denied = await runCheck(dial(port), w.opts());
  assert.equal(denied.ok, false); assert.match(denied.output, /EPERM|EACCES/); assert.equal(hits, 0, 'the server must not have seen a connection');
  const udp = await runCheck(js("const s=require('dgram').createSocket('udp4');s.send('x',9,'127.0.0.1',(e)=>{console.log(e?'ERR '+e.code:'SENT');process.exit(e?7:0)})"), w.opts());
  assert.equal(udp.ok, false);
  const o = w.opts(); o.sandbox.ports = [port];
  const allowed = await runCheck(dial(port), o);
  assert.equal(allowed.ok, true, allowed.output); assert.equal(hits, 1);
  const other = await runCheck(dial(port === 65535 ? 65534 : port + 1), o); assert.equal(other.ok, false, 'only the named port is open');
  const external = await runCheck(js("const s=require('net').connect(443,'1.1.1.1');s.on('connect',()=>process.exit(0));s.on('error',e=>{console.error(e.code);process.exit(7)});setTimeout(()=>process.exit(8),3000)"), w.opts());
  assert.equal(external.ok, false);
});

test('sandbox: TMPDIR is a private per-check directory under the goal dir, writable, and nothing else under /tmp is', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  const r = await runChecks([js("const fs=require('fs');const t=process.env.TMPDIR;fs.writeFileSync(t+'/scratch','1');console.log('TMP='+t);console.log('OS='+require('os').tmpdir())")], w.opts());
  assert.equal(r.ok, true, r.results[0].output);
  const tmp = /TMP=(.*)/.exec(r.results[0].output)[1];
  assert.ok(tmp.startsWith(path.join(w.tmp, 'check-')), tmp); assert.equal(/OS=(.*)/.exec(r.results[0].output)[1], tmp);
  assert.equal(fs.existsSync(tmp), false, 'per-check dir removed afterwards');
  fs.mkdirSync(path.join(w.goal, 'tmp', 'other-task')); fs.writeFileSync(path.join(w.goal, 'tmp', 'other-task', 'f'), 'CANARY-SIBLING');
  const sib = await runCheck(reads(path.join(w.goal, 'tmp', 'other-task', 'f')), w.opts()); assert.equal(sib.ok, false); assert.doesNotMatch(sib.output, /CANARY/);
  const shared = await runCheck(js("require('fs').writeFileSync('/private/tmp/aos-sbx-shared','1')"), w.opts()); assert.equal(shared.ok, false);
  // the default (no explicit sandbox config) is sandboxed too, with its own throwaway TMPDIR
  const d = await runCheck(js("console.log(process.env.TMPDIR);require('fs').writeFileSync(process.env.TMPDIR+'/x','1')"), { cwd: w.wt, env: w.env });
  assert.equal(d.ok, true, d.output); assert.equal(d.sandboxed, true);
});

test('sandbox: timeouts kill the whole group and output is still capped', S, async (t) => {
  const w = world(); t.after(w.cleanup);
  const slow = await runCheck(js("require('child_process').spawn('sleep',['30']);setInterval(()=>{},1000)", 0.6), w.opts());
  assert.equal(slow.timed_out, true); assert.equal(slow.ok, false); assert.equal(slow.sandboxed, true);
  const big = await runCheck(js('process.stdout.write("x".repeat(300000))'), w.opts());
  assert.ok(big.output.length < OUTPUT_CAP + 100 && /truncated/.test(big.output)); assert.equal(big.ok, true);
  const bad = await runCheck(js('console.error("boom");process.exit(3)'), w.opts()); assert.equal(bad.exit_code, 3); assert.match(bad.output, /boom/);
  const missing = await runCheck({ argv: ['/nonexistent/bin'], timeout_s: 5 }, w.opts()); assert.equal(missing.ok, false);
});

test('sandbox: no path from a user-controlled string is interpolated into the profile (spaces, quotes, parens in the worktree path)', S, async (t) => {
  const evil = 'we ird "q\'uote) (allow default) ;x';
  const w = world(evil); t.after(w.cleanup);
  const cfg = w.opts().sandbox;
  const wrapped = wrapCommand([NODE, '-e', '0'], { ...cfg, bin: SANDBOX_EXEC });
  const profile = fs.readFileSync(wrapped.profileFile, 'utf8');
  for (const needle of [evil, 'we ird', w.root, w.home, w.goal, 'quote', 'allow default) ;x', os.homedir()]) assert.equal(profile.includes(needle), false, `profile leaks ${needle}`);
  assert.equal(profile, buildProfile({ ports: 0 }), 'profile is static');
  assert.ok(wrapped.args.includes(`WORKTREE=${w.wt}`), 'the path travels as a -D parameter, untouched');
  const r = await runCheck(js("require('fs').writeFileSync('ok.txt','1');console.log(process.cwd())"), w.opts());
  assert.equal(r.ok, true, r.output); assert.ok(fs.existsSync(path.join(w.wt, 'ok.txt')));
  assert.equal((await runCheck(js(`require('fs').writeFileSync(${JSON.stringify(path.join(w.root, 'escaped'))},'1')`), w.opts())).ok, false);
  // the profile differs only by the number of ports, never by caller data
  assert.equal(wrapCommand([NODE], { ...cfg, ports: [1234] }).args.includes('PORT0=1234'), true);
  assert.throws(() => wrapCommand([NODE], { ...cfg, ports: ['1;2'] }), /invalid localhost port/);
  assert.throws(() => wrapCommand(['-p', 'x'], cfg), /must not start/);
});

test('sandbox: sandbox-exec missing or failing -> checks REFUSE to run; unsandboxed override runs them and says so', async (t) => {
  const w = world(); t.after(w.cleanup);
  const marker = path.join(w.wt, 'ran.txt');
  const check = js("require('fs').writeFileSync('ran.txt','1')");
  const refused = await runCheck(check, w.opts({ sandboxBin: '/nonexistent/sandbox-exec' }));
  assert.equal(refused.ok, false); assert.equal(refused.rejected, true); assert.match(refused.output, /sandbox unavailable.*refusing to run/); assert.equal(fs.existsSync(marker), false);
  const viaRunChecks = await runChecks([check], w.opts({ sandboxBin: '/nonexistent/sandbox-exec' }));
  assert.equal(viaRunChecks.ok, false); assert.equal(fs.existsSync(marker), false);
  assert.equal(sandboxAvailable({ platform: 'linux', fresh: true }).ok, false); assert.match(sandboxAvailable({ platform: 'linux' }).reason, /macOS only/);
  const open = await runCheck(check, w.opts({ sandboxBin: '/nonexistent/sandbox-exec', unsandboxed: true }));
  assert.equal(open.ok, true, open.output); assert.equal(open.sandboxed, false); assert.equal(fs.existsSync(marker), true);
});

test('sandbox: engine integration, checks are sandboxed by default and a check that writes outside the worktree fails the attempt', S, async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const escape = path.join(sb.root, 'escaped.txt');
  const bad = { ...ptask('t1', 'a.txt', 'alpha'), checks: [{ argv: [NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(escape)},'x')`], timeout_s: 20 }] };
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: { tasks: [bad], risks: [] }, orch: { budgets: { max_attempts: 1 } } });
  await drive(sb.engine(dir));
  assert.equal(tasksOf(dir)[0].status, 'failed'); assert.equal(fs.existsSync(escape), false);
  const ev = readEvents(dir).find((e) => e.type === 'orch.check.failed'); assert.equal(ev.data.checks[0].sandboxed, true);

  const sb2 = mkSandbox(); t.after(() => sb2.cleanup());
  sb2.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const g2 = await sb2.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] } });
  await drive(sb2.engine(g2.dir));
  assert.equal(goalOf(g2.dir).status, 'achieved', goalOf(g2.dir).blocked_reason);
  assert.equal(readEvents(g2.dir).find((e) => e.type === 'orch.check.passed').data.checks[0].sandboxed, true);
});

test('sandbox: engine without a working sandbox dispatches nothing (blocked) unless the goal sets unsandboxed_checks, which is event-logged', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const g = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] } });
  await drive(sb.engine(g.dir, { sandboxBin: '/nonexistent/sandbox-exec' }));
  assert.match(goalOf(g.dir).blocked_reason, /OS sandbox unavailable/); assert.equal(fakeCalls(sb, 't1').length, 0);

  const sb2 = mkSandbox(); t.after(() => sb2.cleanup());
  sb2.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const g2 = await sb2.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] }, orch: { unsandboxed_checks: true } });
  assert.ok(g2.notices.some((n) => /^WARNING: unsandboxed_checks/.test(n)));
  await drive(sb2.engine(g2.dir, { sandboxBin: '/nonexistent/sandbox-exec' }));
  assert.equal(goalOf(g2.dir).status, 'achieved', goalOf(g2.dir).blocked_reason);
  assert.ok(types(g2.dir).includes('orch.sandbox.disabled'));
  assert.equal(readEvents(g2.dir).find((e) => e.type === 'orch.check.passed').data.checks[0].sandboxed, false);
});
