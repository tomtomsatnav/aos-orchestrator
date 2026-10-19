// Table-driven tests for the pure policy function and for the real hook executable (payload in -> decision out).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { evaluate, DEFAULT_POLICY, mergePolicy } from '../lib/policy.mjs';
import { decideForPayload, shapeOutput, realpathDeepest } from '../lib/policy-hook.mjs';
import { listApprovals, decide, createApproval, expireDue, readApproval } from '../lib/approvals.mjs';

const HOOK = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib', 'policy-hook.mjs');
const ctx = { worktree: '/w/t1', path_scope: ['a.txt', 'src/**'], allowed_tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'], allowed_commands: ['make test', 'node heartbeat/test.mjs'], grants: [], home: '/home/u', base_branch: 'main' };
const ev = (tool, input, c = ctx, pol = DEFAULT_POLICY) => evaluate(pol, { tool_name: tool, tool_input: input, cwd: '/w/t1' }, c);

const TABLE = [
  // [name, tool, input, expected decision, expected rule]
  ['write inside scope', 'Write', { file_path: '/w/t1/a.txt' }, 'allow', 'write_in_scope'],
  ['write nested scope glob', 'Edit', { file_path: '/w/t1/src/deep/x.js' }, 'allow'],
  ['relative write', 'Write', { file_path: 'a.txt' }, 'allow'],
  ['write outside worktree', 'Write', { file_path: '/w/escape.txt' }, 'deny', 'outside_worktree'],
  ['.. traversal', 'Write', { file_path: '/w/t1/src/../../x.txt' }, 'deny', 'outside_worktree'],
  ['relative .. traversal', 'Write', { file_path: '../x.txt' }, 'deny', 'outside_worktree'],
  ['inside worktree, outside scope -> ask', 'Write', { file_path: '/w/t1/other.txt' }, 'ask', 'outside_scope'],
  ['.git internals', 'Write', { file_path: '/w/t1/.git/hooks/pre-commit' }, 'deny', 'path_denied'],
  ['settings file', 'Write', { file_path: '/w/t1/.claude/settings.json' }, 'deny', 'path_denied'],
  ['home claude dir', 'Write', { file_path: '/home/u/.claude/settings.json' }, 'deny'],
  ['shell rc', 'Write', { file_path: '/home/u/.zshrc' }, 'deny'],
  ['read inside', 'Read', { file_path: '/w/t1/README.md' }, 'allow'],
  ['read outside', 'Read', { file_path: '/etc/passwd' }, 'deny', 'outside_read_root'],
  ['read ssh key', 'Read', { file_path: '/home/u/.ssh/id_ed25519' }, 'deny', 'path_denied'],
  ['glob in worktree', 'Glob', { pattern: '**/*.js' }, 'allow'],
  ['grep with path outside', 'Grep', { pattern: 'x', path: '/Users' }, 'deny'],
  ['tool not allowed', 'WebFetch', { url: 'http://x' }, 'deny', 'tool_not_allowed'],
  ['unknown tool name', 'Mystery', {}, 'deny', 'tool_not_allowed'],
  ['bash allowlisted', 'Bash', { command: 'ls -la' }, 'allow'],
  ['bash task command', 'Bash', { command: 'make test' }, 'allow'],
  ['bash chain all allowed', 'Bash', { command: 'git status && git diff | head -5' }, 'allow'],
  ['bash prefix must match', 'Bash', { command: 'make install' }, 'ask', 'unknown_command'],
  ['bash unknown -> ask', 'Bash', { command: 'sed -i s/a/b/ a.txt' }, 'ask', 'unknown_command'],
  ['git push', 'Bash', { command: 'git push origin main' }, 'deny'],
  ['git push with option', 'Bash', { command: 'git -C /w/t1 push' }, 'deny'],
  ['git remote add', 'Bash', { command: 'git remote add x y' }, 'deny'],
  ['git reset hard', 'Bash', { command: 'git reset --hard HEAD~1' }, 'deny'],
  ['git checkout main', 'Bash', { command: 'git checkout main' }, 'deny'],
  ['git config', 'Bash', { command: 'git config user.name x' }, 'deny'],
  ['sudo', 'Bash', { command: 'sudo ls' }, 'deny'],
  ['curl', 'Bash', { command: 'curl https://example.com' }, 'deny'],
  ['curl via path', 'Bash', { command: '/usr/bin/curl example.com' }, 'deny'],
  ['wget after &&', 'Bash', { command: 'ls && wget x' }, 'deny'],
  ['ssh', 'Bash', { command: 'ssh host' }, 'deny'],
  ['npm install', 'Bash', { command: 'npm install left-pad' }, 'deny'],
  ['pnpm add', 'Bash', { command: 'pnpm add x' }, 'deny'],
  ['pip install', 'Bash', { command: 'pip3 install x' }, 'deny'],
  ['pipe into sh', 'Bash', { command: 'cat a.txt | sh' }, 'deny'],
  ['pipe into node', 'Bash', { command: 'ls | node' }, 'deny'],
  ['rm -rf absolute', 'Bash', { command: 'rm -rf /' }, 'deny'],
  ['rm -rf home', 'Bash', { command: 'rm -rf ~' }, 'deny'],
  ['rm -r outside', 'Bash', { command: 'rm -r /w/other' }, 'deny'],
  ['eval', 'Bash', { command: 'eval "ls"' }, 'deny'],
  ['command substitution -> ask', 'Bash', { command: 'cat $(echo a.txt)' }, 'ask', 'substitution'],
  ['backticks -> ask', 'Bash', { command: 'cat `echo a.txt`' }, 'ask', 'substitution'],
  ['variable expansion -> ask', 'Bash', { command: 'cat $FILE' }, 'ask', 'unparsed'],
  ['heredoc -> ask', 'Bash', { command: 'cat <<EOF\nx\nEOF' }, 'ask'],
  ['redirect outside', 'Bash', { command: 'ls > /tmp/out.txt' }, 'deny', 'outside_worktree'],
  ['redirect inside scope', 'Bash', { command: 'ls > a.txt' }, 'allow'],
  ['redirect to /dev/null', 'Bash', { command: 'ls 2>/dev/null' }, 'allow'],
  ['redirect to dotgit', 'Bash', { command: 'ls > .git/config' }, 'deny', 'path_denied'],
  ['cat outside', 'Bash', { command: 'cat /etc/passwd' }, 'deny', 'outside_read_root'],
  ['cat ..', 'Bash', { command: 'cat ../secret' }, 'deny'],
  ['cat ssh key', 'Bash', { command: 'cat ~/.ssh/id_rsa' }, 'deny'],
  ['find -exec -> ask', 'Bash', { command: 'find . -name x -exec rm {} ;' }, 'ask'],
  ['env assignment -> ask', 'Bash', { command: 'FOO=1 ls' }, 'ask'],
  ['empty command', 'Bash', { command: '   ' }, 'deny'],
  ['missing command', 'Bash', {}, 'deny'],
  ['missing path', 'Write', {}, 'deny'],
  ['quoted separators are not separators', 'Bash', { command: 'grep "a;b" a.txt' }, 'allow'],
  ['single-quoted dollar is literal', 'Bash', { command: "grep '$x' a.txt" }, 'allow'],
];

for (const [name, tool, input, want, rule] of TABLE) {
  test(`policy: ${name} -> ${want}`, () => {
    const r = ev(tool, input);
    assert.equal(r.decision, want, JSON.stringify(r));
    if (rule) assert.equal(r.rule, rule);
    assert.equal(typeof r.reason, 'string');
  });
}

test('policy: grants lift ask but never deny; on_outside_scope=deny; tools restricted per task', () => {
  const g = { ...ctx, grants: [{ kind: 'command', command: 'sed -i s/a/b/ a.txt' }, { kind: 'path', path: '/w/t1/other.txt' }, { kind: 'command', command: 'git push origin main' }] };
  assert.equal(ev('Bash', { command: 'sed -i s/a/b/ a.txt' }, g).decision, 'allow');
  assert.equal(ev('Bash', { command: 'sed -i s/a/c/ a.txt' }, g).decision, 'ask');
  assert.equal(ev('Write', { file_path: '/w/t1/other.txt' }, g).decision, 'allow');
  assert.equal(ev('Bash', { command: 'git push origin main' }, g).decision, 'deny', 'a grant cannot override a deny rule');
  assert.equal(ev('Write', { file_path: '/w/t1/other.txt' }, ctx, mergePolicy({ paths: { on_outside_scope: 'deny' } })).decision, 'deny');
  assert.equal(ev('Bash', { command: 'ls' }, { ...ctx, allowed_tools: ['Read'] }).decision, 'deny');
  assert.equal(ev('Bash', { command: 'x' }, { ...ctx, worktree: undefined }).decision, 'deny');
  assert.equal(evaluate(DEFAULT_POLICY, null, ctx).decision, 'deny');
  assert.equal(ev('Bash', { command: 'cat $(x)' }, ctx, mergePolicy({ bash: { ask_on: [] } })).decision, 'deny', 'constructs outside ask_on fail closed');
});

test('policy: evaluate is pure (no mutation of inputs, deterministic)', () => {
  const p = JSON.stringify(DEFAULT_POLICY); const c = JSON.stringify(ctx);
  const a = ev('Bash', { command: 'git status && cat a.txt' }); const b = ev('Bash', { command: 'git status && cat a.txt' });
  assert.deepEqual(a, b); assert.equal(JSON.stringify(DEFAULT_POLICY), p); assert.equal(JSON.stringify(ctx), c);
});

// ---------------------------------------------------------------- the hook executable
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hook-')));
  const wt = path.join(root, 'wt'); fs.mkdirSync(wt);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(wt, 'link'));
  const appr = path.join(root, 'approvals'); fs.mkdirSync(appr);
  const policyFile = path.join(root, 'policy.json');
  const write = (over = {}) => fs.writeFileSync(policyFile, JSON.stringify({ policy: mergePolicy({ approval: { wait_in_hook_s: 0.3 } }, over.policy), ctx: { worktree: wt, path_scope: ['a.txt', 'src/**'], allowed_tools: ['Read', 'Write', 'Edit', 'Bash'], allowed_commands: [], grants: [], home: os.homedir(), ...over.ctx } }));
  write();
  const env = { PATH: process.env.PATH, AOS_POLICY_FILE: policyFile, AOS_APPROVALS_DIR: appr, AOS_GOAL_ID: 'g', AOS_TASK_ID: 't1', AOS_ATTEMPT: '1', AOS_APPROVAL_POLL_MS: '30' };
  const run = (payload, e = env, raw) => new Promise((resolve) => {
    const c = spawn(process.execPath, [HOOK], { env: e, cwd: wt }); let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
    c.stdin.end(raw ?? JSON.stringify(payload));
  });
  return { root, wt, appr, env, run, write, policyFile, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const pre = (tool, input, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd, session_id: 's' });

test('hook: verified JSON decision shapes for PreToolUse and PermissionRequest; exit code is always 0', async (t) => {
  const h = setup(); t.after(h.cleanup);
  let r = await h.run(pre('Write', { file_path: path.join(h.wt, 'a.txt') }, h.wt));
  assert.equal(r.code, 0); assert.deepEqual(r.json.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'AOS policy: allowed' });
  r = await h.run(pre('Write', { file_path: path.join(h.root, 'escape.txt') }, h.wt));
  assert.equal(r.code, 0); assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny'); assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /outside the task worktree/);
  r = await h.run({ ...pre('Bash', { command: 'git push origin main' }, h.wt), hook_event_name: 'PermissionRequest' });
  assert.deepEqual(r.json, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: r.json.hookSpecificOutput.decision.message } } });
  assert.match(r.json.hookSpecificOutput.decision.message, /AOS policy/);
  r = await h.run({ ...pre('Write', { file_path: path.join(h.wt, 'a.txt') }, h.wt), hook_event_name: 'PermissionRequest' });
  assert.deepEqual(r.json, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal(r.err, '');
});

test('hook: symlink and .. escapes are denied, new files under existing dirs resolve correctly', async (t) => {
  const h = setup(); t.after(h.cleanup);
  const d = async (p) => (await h.run(p)).json.hookSpecificOutput.permissionDecision;
  assert.equal(await d(pre('Write', { file_path: path.join(h.wt, 'link', 'x.txt') }, h.wt)), 'deny', 'symlink out of the worktree');
  assert.equal(await d(pre('Write', { file_path: 'link/x.txt' }, h.wt)), 'deny', 'relative symlink escape');
  assert.equal(await d(pre('Write', { file_path: 'src/../../x.txt' }, h.wt)), 'deny');
  assert.equal(await d(pre('Write', { file_path: path.join(h.wt, 'src', 'new', 'deep.js') }, h.wt)), 'allow', 'not-yet-existing path inside scope');
  assert.equal(await d(pre('Bash', { command: 'cat link/secret' }, h.wt)), 'deny', 'bash read through a symlink');
  assert.equal(await d(pre('Bash', { command: 'ls > link/out' }, h.wt)), 'deny');
  assert.equal(realpathDeepest(path.join(h.wt, 'link', 'a', 'b')), path.join(h.root, 'outside', 'a', 'b'));
});

test('hook: fails closed on garbage payloads, a missing policy file, or a missing approvals dir', async (t) => {
  const h = setup(); t.after(h.cleanup);
  let r = await h.run(null, h.env, 'not json');
  assert.equal(r.code, 0); assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  r = await h.run(pre('Write', { file_path: 'a.txt' }, h.wt), { ...h.env, AOS_POLICY_FILE: '/nonexistent/policy.json' });
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny'); assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /fail closed/);
  const { AOS_APPROVALS_DIR, ...noDir } = h.env;
  r = await h.run(pre('Write', { file_path: path.join(h.wt, 'other.txt') }, h.wt), noDir); // would be 'ask'
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(shapeOutput('PreToolUse', 'deny', 'x').hookSpecificOutput.permissionDecision, 'deny');
});

test('hook: ask waits for a decision (allow), denies on decision=deny, and denies on timeout leaving a pending request', async (t) => {
  const h = setup(); t.after(h.cleanup);
  h.write({ policy: { approval: { wait_in_hook_s: 5 } } });
  const call = pre('Write', { file_path: path.join(h.wt, 'other.txt') }, h.wt);
  // decided in time -> allow
  let p = h.run(call);
  for (let i = 0; i < 100 && !listApprovals(h.appr).length; i++) await new Promise((r) => setTimeout(r, 30));
  const [ap] = listApprovals(h.appr);
  assert.equal(ap.status, 'pending'); assert.equal(ap.tool, 'Write'); assert.equal(ap.task_id, 't1'); assert.equal(ap.rule, 'outside_scope'); assert.equal(fs.statSync(path.join(h.appr, `${ap.id}.json`)).mode & 0o777, 0o600);
  decide(h.appr, ap.id, { decision: 'approve', scope: 'once', by: 'test' });
  let r = await p;
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'allow'); assert.match(r.json.hookSpecificOutput.permissionDecisionReason, new RegExp(ap.id));
  // a second identical request in the same attempt reuses the decision (PreToolUse + PermissionRequest do not double-ask)
  r = await h.run({ ...call, hook_event_name: 'PermissionRequest' });
  assert.equal(r.json.hookSpecificOutput.decision.behavior, 'allow'); assert.equal(listApprovals(h.appr).length, 1);
  // denied -> deny
  const call2 = pre('Bash', { command: 'sed -i s/a/b/ a.txt' }, h.wt);
  p = h.run(call2);
  for (let i = 0; i < 100 && listApprovals(h.appr).length < 2; i++) await new Promise((r2) => setTimeout(r2, 30));
  decide(h.appr, 'A-2', { decision: 'deny', by: 'test' });
  r = await p; assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny'); assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /denied/);
  // nobody decides -> deny after the wait, request stays pending for the engine to see
  h.write({ policy: { approval: { wait_in_hook_s: 0.3 } } });
  const t0 = Date.now();
  r = await h.run(pre('Write', { file_path: path.join(h.wt, 'third.txt') }, h.wt));
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny'); assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /pending; do not retry/);
  assert.ok(Date.now() - t0 >= 250);
  assert.equal(listApprovals(h.appr, { status: 'pending' }).length, 1);
});

test('hook: decideForPayload honours task grants from the policy file', async (t) => {
  const h = setup(); t.after(h.cleanup);
  h.write({ ctx: { grants: [{ kind: 'path', path: path.join(h.wt, 'other.txt') }] } });
  const r = await decideForPayload(pre('Write', { file_path: path.join(h.wt, 'other.txt') }, h.wt), h.env);
  assert.equal(r.decision, 'allow'); assert.equal(listApprovals(h.appr).length, 0);
});

test('approvals: unique ids, O_EXCL create, only pending can be decided, expiry = deny, audit log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-appr-')); const dir = path.join(root, 'approvals');
  try {
    const clock = { t: 1_000_000, now() { return this.t; } };
    const req = (n) => ({ goal_id: 'g', task_id: 't', attempt: 1, tool: 'Bash', input: { command: `c${n}` }, reason: 'r', rule: 'unknown_command' });
    const a = createApproval(dir, req(1), { clock, ttl_s: 10 }); const b = createApproval(dir, req(2), { clock, ttl_s: 10 });
    assert.deepEqual([a.id, b.id], ['A-1', 'A-2']);
    assert.equal(createApproval(dir, req(1), { clock, ttl_s: 10 }).id, 'A-1', 'same call in same attempt is one request');
    decide(dir, 'A-1', { decision: 'approve', scope: 'task', note: 'ok', by: 'cli' }, clock);
    assert.throws(() => decide(dir, 'A-1', { decision: 'deny' }, clock), /already approved/);
    assert.throws(() => decide(dir, 'A-9', { decision: 'deny' }, clock), /no such approval/);
    assert.throws(() => decide(dir, 'A-2', { decision: 'maybe' }, clock), /approve or deny/);
    assert.deepEqual(expireDue(dir, clock), []);
    clock.t += 11_000;
    assert.deepEqual(expireDue(dir, clock).map((x) => [x.id, x.status]), [['A-2', 'expired']]);
    assert.equal(readApproval(dir, 'A-2').decided_by, 'timeout'); assert.equal(readApproval(dir, 'A-1').status, 'approved');
    const audit = fs.readFileSync(path.join(dir, 'audit.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(audit.map((x) => x.event), ['requested', 'requested', 'decided', 'expired']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------
// Security review (phase 1): adversarial inputs. Each case was ALLOWED (or silently mis-resolved) before the fix.
import * as POL from '../lib/policy.mjs';
import * as HOOKMOD from '../lib/policy-hook.mjs';
import * as APPR from '../lib/approvals.mjs';

test('review: shell expansions that hide a path are never allowed (tilde-user, $\'..\', braces, .*, line continuation, cd chains)', () => {
  const broad = { ...ctx, path_scope: ['a.txt', 'src/**', '**/.zshrc', 'settings.json'] };
  for (const [cmd, c] of [
    ['cat ~root/.ssh/id_rsa', ctx], ['cat ~+/x', ctx], ['cat ~-/x', ctx], ['cat a.txt > ~u/.zshrc', broad],
    ["cat $'\\x2fetc\\x2fpasswd'", ctx], ["ls > $'\\x2fhome/u/.zshrc'", broad], ['cat x$[1]', ctx],
    ['cat {/etc/passwd,a.txt}', ctx], ['cat .*/secret', ctx], ['cat src/.?/x', ctx],
    ['ls \\\n/etc', ctx], ['cat a.txt > \\\n/home/u/.zshrc', broad], ['cat "\\\n/etc/passwd"', ctx],
    ['cd .claude && ls > settings.json', broad], ['cd src; cat a.txt > settings.json', broad],
  ]) assert.notEqual(ev('Bash', { command: cmd }, c).decision, 'allow', cmd);
  // ordinary commands keep working
  for (const cmd of ['ls -la', 'cat a.txt', 'grep -rn foo src', 'git log --oneline -5', 'cat a.txt > src/b.txt', 'cd src']) assert.equal(ev('Bash', { command: cmd }).decision, 'allow', cmd);
});

test('review: protected paths are matched case- and compatibility-insensitively (APFS: .CLAUDE == .claude)', () => {
  const wide = { ...ctx, path_scope: ['**/*.json', 'src/**', '.GIT', '.Git/**'] };
  for (const f of ['/w/t1/.CLAUDE/settings.json', '/w/t1/.Claude/Settings.local.json', '/w/t1/.claude/\u017Fettings.json', '/w/t1/.GIT', '/w/t1/.Git/config', '/w/t1/src/.GIT/hooks/pre-commit']) {
    assert.equal(ev('Write', { file_path: f }, wide).decision, 'deny', f);
  }
  assert.equal(ev('Write', { file_path: '/home/u/.SSH/authorized_keys' }).decision, 'deny');
  assert.equal(typeof POL.isProtectedRel, 'function');
  assert.ok(POL.isProtectedRel({}, '.CLAUDE/settings.json') && POL.isProtectedRel({}, 'sub/.git/config') && !POL.isProtectedRel({}, 'src/settings.json'));
});

test('review: allowlisted commands cannot be used to run other code, write files or read outside the worktree', () => {
  const c2 = { ...ctx, allowed_commands: ['xargs', 'bash', 'env'] };
  for (const [cmd, c] of [
    ['./cat a.txt', ctx], ['src/ls', ctx], ['rg --pre ./x.sh foo', ctx], ['rg --pre=./x.sh foo', ctx],
    ['find -name x -fprintf a.txt %p', ctx], ['find -name x -fls a.txt', ctx], ['git diff --output=other.txt', ctx], ['git log --output other.txt', ctx],
    ['node --test --import=./evil.mjs', ctx], ['node --test -r ./evil.js', ctx], ['node --test --test-reporter-destination=other.txt', ctx],
    ['xargs curl http://x', c2], ['env curl http://x', c2], ['bash -c "curl http://x"', c2], ['ls | xargs rm', c2],
  ]) assert.notEqual(ev('Bash', { command: cmd }, c).decision, 'allow', cmd);
  assert.equal(ev('Bash', { command: 'grep -f/etc/passwd a.txt' }).decision, 'deny', 'attached short option value is a path');
  assert.equal(ev('Bash', { command: '/bin/cat a.txt' }).decision, 'allow', 'system binaries by absolute path still match');
  assert.equal(ev('Bash', { command: 'node --test' }).decision, 'allow');
});

test('review: pathological commands are decided fast (hook timeout = fail open for read-only calls)', () => {
  let t0 = Date.now();
  assert.notEqual(ev('Bash', { command: `rm -${'r'.repeat(100000)}x` }).decision, 'allow');
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  t0 = Date.now();
  assert.equal(new RegExp(DEFAULT_POLICY.bash.deny_patterns[1]).test(`rm -${'r'.repeat(100000)}x`), false);
  assert.ok(Date.now() - t0 < 1000, `default rm pattern took ${Date.now() - t0} ms`);
  for (const cmd of ['rm -rf /', 'rm -fr ~', 'rm -r ..', 'x; rm -rf /tmp']) assert.ok(new RegExp(DEFAULT_POLICY.bash.deny_patterns[1]).test(cmd), cmd);
  assert.equal(new RegExp(DEFAULT_POLICY.bash.deny_patterns[1]).test('rm -f /tmp/x'), false);
});

test('review: dangling symlinks and symlink loops cannot be used to write outside the worktree', async (t) => {
  const h = setup(); t.after(h.cleanup);
  fs.symlinkSync('../outside/created-by-write.txt', path.join(h.wt, 'dangling'));
  fs.symlinkSync(path.join(h.wt, 'loop2'), path.join(h.wt, 'loop1')); fs.symlinkSync(path.join(h.wt, 'loop1'), path.join(h.wt, 'loop2'));
  assert.equal(realpathDeepest(path.join(h.wt, 'dangling')), path.join(h.root, 'outside', 'created-by-write.txt'));
  h.write({ ctx: { path_scope: ['dangling', 'loop1/**', 'a.txt'] } });
  const d = async (p) => (await h.run(p)).json.hookSpecificOutput.permissionDecision;
  assert.equal(await d(pre('Write', { file_path: path.join(h.wt, 'dangling') }, h.wt)), 'deny', 'dangling symlink to outside');
  assert.equal(await d(pre('Write', { file_path: path.join(h.wt, 'loop1', 'x') }, h.wt)), 'deny', 'symlink loop');
  assert.equal(await d(pre('Write', { file_path: path.join(h.wt, 'a.txt') }, h.wt)), 'allow');
});

test('review: the hook never waits past its own 30 s registration timeout (a killed hook falls back to the CLI flow)', () => {
  assert.equal(typeof HOOKMOD.hookWaitMs, 'function');
  assert.equal(HOOKMOD.hookWaitMs({ approval: { wait_in_hook_s: 600 } }), 25000);
  assert.equal(HOOKMOD.hookWaitMs({ approval: {} }), 20000);
  assert.equal(HOOKMOD.hookWaitMs({ approval: { wait_in_hook_s: 'x' } }), 0);
});

test('review: an approval is bound to the cwd it was requested in (same command elsewhere is a new request)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-appr-'));
  try {
    const base = { goal_id: 'g', task_id: 't1', attempt: 1, tool: 'Bash', input: { command: 'rm -r build' }, reason: 'r', rule: 'unknown_command' };
    const a = APPR.createApproval(dir, { ...base, cwd: '/w/t1/src' });
    APPR.decide(dir, a.id, { decision: 'approve' });
    const b = APPR.createApproval(dir, { ...base, cwd: '/w/t1' });
    assert.notEqual(b.id, a.id); assert.equal(b.status, 'pending'); assert.equal(b.cwd, '/w/t1');
    assert.equal(APPR.createApproval(dir, { ...base, cwd: '/w/t1/src' }).status, 'approved', 'same call, same cwd: the decision applies');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('review: Glob patterns cannot list files outside the worktree (absolute, ~ or .. patterns)', () => {
  for (const pattern of ['/home/u/.ssh/*', '~/.aws/*', '../../**/*.pem', '/etc/**']) assert.equal(ev('Glob', { pattern }).decision, 'deny', pattern);
  for (const pattern of ['src/**/*.js', '/w/t1/src/*.js', '**/*.md']) assert.equal(ev('Glob', { pattern }).decision, 'allow', pattern);
});
