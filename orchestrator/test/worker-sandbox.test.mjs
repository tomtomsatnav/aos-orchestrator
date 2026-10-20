// Opt-in OS sandbox for WORKER processes (orch.sandbox_workers / --sandbox-workers): sandbox-exec with a deny-default
// profile whose writes are limited to the task worktree, the goal tmp dir, the approvals inbox + decision log, Claude's own
// session files and system temp. macOS only: other platforms skip. The real `claude` probe is documented in the README;
// these tests use /bin/sh and the fake claude only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildWorkerProfile, wrapWorkerCommand, sandboxAvailable, projectSlug } from '../lib/sandbox.mjs';
import { mkSandbox, drive, goalOf, fakeCalls, ptask, crit, edit, allowAllHook, HERE } from './helpers.mjs';
import { readEvents, readJSON } from '../lib/state.mjs';

const avail = sandboxAvailable();
const SKIP = process.platform !== 'darwin' ? 'sandbox-exec is macOS only: skipped on this platform' : !avail.ok ? `sandbox-exec unavailable: ${avail.reason}` : false;
const S = { skip: SKIP };

/** repo + two worktrees + goal dir + fake HOME with canaries; sysTmp is a private dir so $TMPDIR does not mask the test. */
function world(name = 'w') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-wsbx-')));
  const w = { root, repo: path.join(root, 'repo'), wt: path.join(root, 'repo-aos-worktrees', 'g', name), other: path.join(root, 'repo-aos-worktrees', 'g', 'other'),
    goal: path.join(root, 'goal'), home: path.join(root, 'home'), sysTmp: path.join(root, 'systmp'), hookDir: path.join(root, 'hook') };
  fs.mkdirSync(w.repo, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: w.repo, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(w.repo, 'README.md'), 'x\n'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@x.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'i');
  g('worktree', 'add', '-q', '-b', 'b1', w.wt); g('worktree', 'add', '-q', '-b', 'b2', w.other);
  for (const d of ['tmp/t1', 'approvals', 'workers', 'sandbox']) fs.mkdirSync(path.join(w.goal, d), { recursive: true });
  for (const d of ['.ssh', '.aws', '.claude/projects', '.claude/sessions', 'Library/Keychains', w.sysTmp, w.hookDir, '.claude/shell-snapshots', '.claude/session-env/other-session']) fs.mkdirSync(path.isAbsolute(d) ? d : path.join(w.home, d), { recursive: true });
  fs.writeFileSync(path.join(w.home, '.ssh', 'id_rsa'), 'CANARY-SSH'); fs.writeFileSync(path.join(w.home, '.claude', 'settings.json'), '{}');
  fs.writeFileSync(path.join(w.home, '.claude', 'sessions', '1.key'), 'CANARY-SESSION-KEY');
  for (const f of ['workers/t1.policy.json', 'workers/settings.json']) fs.writeFileSync(path.join(w.goal, f), '{}');
  w.cfg = { sessionId: SID, worktree: w.wt, tmpDir: path.join(w.goal, 'tmp/t1'), approvalsDir: path.join(w.goal, 'approvals'), decisionLog: path.join(w.goal, 'workers/decisions.ndjson'),
    policyFile: path.join(w.goal, 'workers/t1.policy.json'), settingsFile: path.join(w.goal, 'workers/settings.json'), hookDir: w.hookDir,
    gitCommon: path.join(w.repo, '.git'), home: w.home, sysTmp: w.sysTmp, profileDir: path.join(w.goal, 'sandbox') };
  /** run `sh -c script` inside the worker sandbox; exit code 0 = the script succeeded */
  w.sh = (script) => { const x = wrapWorkerCommand(['/bin/sh', '-c', script], w.cfg); return spawnSync(x.bin, x.args, { cwd: w.wt, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: w.home } }); };
  w.cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return w;
}
const SID = '11111111-2222-3333-4444-555555555555';
const q = (p) => `'${p.replace(/'/g, "'\\''")}'`;

test('worker sandbox: profile is static text, every path travels as a -D parameter', (t) => {
  const w = world('we ird "q\'uote) (allow default)'); t.after(w.cleanup);
  const x = wrapWorkerCommand(['/bin/echo', 'hi'], w.cfg);
  const profile = fs.readFileSync(x.profileFile, 'utf8');
  assert.equal(profile, buildWorkerProfile());
  for (const needle of [w.root, w.home, os.homedir(), 'we ird', 'allow default)']) assert.equal(profile.includes(needle), false, `profile leaks ${needle}`);
  assert.match(profile, /\(deny default\)/); assert.match(profile, /\(allow network\*\)/);
  assert.ok(x.args.includes(`WORKTREE=${w.wt}`)); assert.ok(x.args.includes(`PROJECT_DIR=${path.join(w.home, '.claude', 'projects', projectSlug(w.wt))}`));
  assert.deepEqual(x.args.slice(-2), ['/bin/echo', 'hi']);
  assert.throws(() => wrapWorkerCommand(['-x'], w.cfg), /must not start/);
  assert.throws(() => wrapWorkerCommand(['/bin/echo'], { ...w.cfg, approvalsDir: undefined }), /approvalsDir missing/);
  assert.equal(projectSlug('/private/var/folders/kv/a_b/T/x.y'), '-private-var-folders-kv-a-b-T-x-y');
});

test('worker sandbox: writes succeed in the worktree, goal tmp, approvals, decision log, claude project dir, system temp', S, (t) => {
  const w = world(); t.after(w.cleanup);
  const proj = path.join(w.home, '.claude', 'projects', projectSlug(w.wt));
  const scratch = `/tmp/claude-${process.getuid()}/${projectSlug(w.wt)}`; t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const targets = [path.join(w.wt, 'ok.txt'), path.join(w.goal, 'tmp/t1', 'ok'), path.join(w.goal, 'approvals', 'A-1.json'), w.cfg.decisionLog,
    path.join(proj, 's.jsonl'), path.join(w.home, '.claude', 'session-env', SID, 'hook.sh'), path.join(scratch, 'sid', 'scratchpad', 'ok')];
  const r = w.sh(targets.map((f) => `mkdir -p ${q(path.dirname(f))} && echo ok > ${q(f)}`).join(' && '));
  assert.equal(r.status, 0, r.stderr);
  for (const f of targets) assert.equal(fs.readFileSync(f, 'utf8'), 'ok\n', f);
  assert.equal(w.sh(`cat ${q(path.join(w.repo, '.git', 'HEAD'))} && git status --short`).status, 0, 'the repo .git is readable: git works in the worktree');
});

test('worker sandbox: cannot touch shell snapshots, ~/.claude.json, other sessions\' session-env or other scratchpads (S1)', S, (t) => {
  const w = world(); t.after(w.cleanup);
  const snap = path.join(w.home, '.claude', 'shell-snapshots', 'snapshot-zsh-1-abc.sh'); fs.writeFileSync(snap, 'echo real\n');
  const cj = path.join(w.home, '.claude.json'); fs.writeFileSync(cj, '{"mcpServers":{}}');
  const other = path.join(w.home, '.claude', 'session-env', 'other-session', 'env'); fs.writeFileSync(other, 'x');
  const sc = `/tmp/claude-${process.getuid()}/aos-wsbx-other-${process.pid}`; fs.mkdirSync(sc, { recursive: true }); t.after(() => fs.rmSync(sc, { recursive: true, force: true }));
  const denied = [snap, path.join(w.home, '.claude', 'shell-snapshots', 'new.sh'), cj, `${cj}.tmp.1.2`, other, path.join(w.home, '.claude', 'session-env', 'other-session', 'new'), path.join(sc, 'pwn')];
  for (const f of denied) { const r = w.sh(`echo pwn >> ${q(f)}`); assert.notEqual(r.status, 0, f); assert.match(r.stderr, /not permitted/, f); }
  assert.equal(fs.readFileSync(snap, 'utf8'), 'echo real\n'); assert.equal(fs.readFileSync(cj, 'utf8'), '{"mcpServers":{}}'); assert.equal(fs.readFileSync(other, 'utf8'), 'x');
  assert.equal(w.sh(`rm ${q(snap)}`).status !== 0 && fs.existsSync(snap), true, 'cannot delete a snapshot either');
});

test('worker sandbox: writes are denied to the main repo, other worktrees, HOME, ~/.ssh, ~/.claude/settings.json, .git, keychains', S, (t) => {
  const w = world(); t.after(w.cleanup);
  const denied = [path.join(w.repo, 'pwn.txt'), path.join(w.repo, 'README.md'), path.join(w.other, 'pwn.txt'), path.join(w.home, 'aos-sandbox-probe'), path.join(w.home, '.ssh', 'authorized_keys'),
    path.join(w.home, '.claude', 'settings.json'), path.join(w.home, '.claude', 'CLAUDE.md'), path.join(w.home, '.claude', 'projects', projectSlug(w.repo), 'memory.md'),
    path.join(w.repo, '.git', 'hooks', 'pre-commit'), path.join(w.home, 'Library', 'Keychains', 'x.keychain-db'), path.join(w.goal, 'goal.json'), path.join(w.goal, 'workers', 't1.policy.json'),
    path.join(w.goal, 'tmp', 'other-task'), path.join(w.home, '.zshrc')];
  fs.mkdirSync(path.join(w.home, '.claude', 'projects', projectSlug(w.repo)), { recursive: true }); fs.mkdirSync(path.join(w.repo, '.git', 'hooks'), { recursive: true });
  for (const f of denied) {
    const r = w.sh(`echo pwn >> ${q(f)}`);
    assert.notEqual(r.status, 0, f); assert.match(r.stderr, /not permitted/, f);
    assert.notEqual(fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('pwn'), true, f);
  }
  for (const f of [path.join(w.home, '.ssh', 'id_rsa'), path.join(w.home, '.claude', 'sessions', '1.key'), path.join(w.repo, 'README.md')]) {
    const r = w.sh(`cat ${q(f)}`); assert.notEqual(r.status, 0, f); assert.doesNotMatch(r.stdout, /CANARY|^x$/m, f);
  }
});

test('worker sandbox: engine wraps workers only when orch.sandbox_workers is set; a worker shell write outside its worktree fails', S, async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  const escape = path.join(sb.repo, 'escaped.txt');
  // allow-all hook: simulates a policy bypass, so only the OS sandbox stands between the worker and the main repo
  sb.scenario({ tasks: { t1: [{ ...edit('a.txt', 'alpha'), commands: [{ command: `echo x > ${q(escape)}; echo inside > in.txt`, run: true }] }] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: { tasks: [ptask('t1', 'a.txt', 'alpha', { scope: ['a.txt', 'in.txt'] })], risks: [] }, orch: { sandbox_workers: true } });
  // fake-claude keeps its own state in sb.fakeState: give it the role of "system temp" so nothing else under $TMPDIR is writable
  await drive(sb.engine(dir, { hookScript: allowAllHook(sb.root), workerSandbox: { sysTmp: sb.fakeState } }));
  assert.equal(goalOf(dir).status, 'achieved', goalOf(dir).blocked_reason);
  assert.equal(fs.existsSync(escape), false, 'the main repo working tree was written');
  assert.equal(readEvents(dir).find((e) => e.type === 'orch.worker.started' && e.task_id === 't1').data.sandboxed, true);
  assert.equal(fakeCalls(sb, 't1').length, 1);
  assert.equal(readJSON(path.join(dir, 'workers', 't1.1.pid.json')).sandboxed, true);
  assert.ok(fs.readdirSync(path.join(dir, 'sandbox')).some((f) => /^worker-.*\.sb$/.test(f)));

  // default: unchanged, unsandboxed worker (the same escape succeeds)
  const sb2 = mkSandbox(); t.after(() => sb2.cleanup());
  const escape2 = path.join(sb2.repo, 'escaped.txt');
  sb2.scenario({ tasks: { t1: [{ ...edit('a.txt', 'alpha'), commands: [{ command: `echo x > ${q(escape2)}`, run: true }] }] } });
  const g2 = await sb2.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] } });
  await drive(sb2.engine(g2.dir, { hookScript: allowAllHook(sb2.root) }));
  assert.equal(readEvents(g2.dir).find((e) => e.type === 'orch.worker.started' && e.task_id === 't1').data.sandboxed, false);
  assert.equal(fs.existsSync(escape2), true, 'control: without the worker sandbox the escape works');
});

test('worker sandbox: sandbox_workers with no working sandbox-exec starts no worker (never silently unsandboxed)', async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ tasks: { t1: [edit('a.txt', 'alpha')] } });
  const { dir } = await sb.goal({ success_criteria: [crit('a.txt', 'alpha')], plan: { tasks: [ptask('t1', 'a.txt', 'alpha')], risks: [] }, orch: { sandbox_workers: true, unsandboxed_checks: true } });
  const e = sb.engine(dir, { sandboxBin: '/nonexistent/sandbox-exec' });
  await drive(e, { until: () => !!goalOf(dir).orch.halt_reason || goalOf(dir).status === 'blocked', timeoutMs: 20000 });
  assert.match(goalOf(dir).orch.halt_reason || goalOf(dir).blocked_reason || '', /worker OS sandbox unavailable/);
  assert.equal(fakeCalls(sb, 't1').length, 0);
  await assert.rejects(sb.goal({ id: 'g-bad', orch: { sandbox_workers: 'yes' } }), /sandbox_workers must be a boolean/);
});

test('worker sandbox: `aos-orch run goal.json --sandbox-workers` records the field and runs the planner inside the sandbox', S, async (t) => {
  const sb = mkSandbox(); t.after(() => sb.cleanup());
  sb.scenario({ planner: { behavior: 'success', plan: { tasks: [ptask('t1', 'a.txt', 'alpha')] } }, tasks: { t1: [edit('a.txt', 'alpha')] } });
  const spec = { id: 'g-cli-sbx', title: 'CLI sandboxed', success_criteria: [crit('a.txt', 'alpha')], orch: { repo: sb.repo, base_branch: 'main', check_allowlist: ['node'] } };
  const gf = path.join(sb.root, 'goal.json'); fs.writeFileSync(gf, JSON.stringify(spec));
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'bin', 'aos-orch.mjs'), 'run', gf, '--sandbox-workers', '--poll-ms', '50', '--interval-s', '0.2'], { env: sb.env(), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 4, r.stderr); assert.equal(JSON.parse(r.stdout).plan_state, 'awaiting_approval');
  const dir = path.join(sb.orch, 'goals', 'g-cli-sbx');
  assert.equal(goalOf(dir).orch.sandbox_workers, true);
  assert.equal(readEvents(dir).find((e) => e.type === 'orch.worker.started' && e.data.role === 'planner').data.sandboxed, true);
});
