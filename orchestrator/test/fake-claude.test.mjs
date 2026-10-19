// Tests for fake-claude.mjs. Run: node --test orchestrator/test/fake-claude.test.mjs   (or: node orchestrator/test/fake-claude.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fake-claude.mjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE = ['-p', 'do the thing', '--model', 'haiku', '--output-format', 'stream-json', '--verbose'];

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-test-'));
  const cwd = path.join(root, 'wt'); const state = path.join(root, 'state');
  fs.mkdirSync(cwd); fs.mkdirSync(state);
  return { root, cwd: fs.realpathSync(cwd), state, scen: path.join(root, 'scenario.json') };
}
function writeScenario(sb, obj) { fs.writeFileSync(sb.scen, typeof obj === 'string' ? obj : JSON.stringify(obj)); }
function envFor(sb, extra = {}) {
  const e = { ...process.env, AOS_FAKE_SCENARIO: sb.scen, AOS_FAKE_STATE: sb.state, ...extra };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}
function run(sb, args, { env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [FAKE, ...args], { cwd: sb.cwd, env: envFor(sb, env), input, encoding: 'utf8', timeout: 20000 });
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } });
  return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, lines, result: lines.find((l) => l && l.type === 'result') };
}
const types = (lines) => lines.map((l) => (l.type === 'system' ? `system/${l.subtype}` : l.type));
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function startAsync(sb, args, env = {}) {
  const child = spawn(process.execPath, [FAKE, ...args], { cwd: sb.cwd, env: envFor(sb, env), stdio: ['ignore', 'pipe', 'pipe'] });
  const h = { child, out: '', err: '', exit: null };
  child.stdout.on('data', (d) => { h.out += d; });
  child.stderr.on('data', (d) => { h.err += d; });
  h.closed = new Promise((res) => child.on('close', (code, signal) => { h.exit = { code, signal }; res(h.exit); }));
  h.waitFor = async (re, ms = 10000) => { const t0 = Date.now(); while (!re.test(h.out)) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + re + ' in ' + h.out); await new Promise((r) => setTimeout(r, 20)); } };
  return h;
}

test('success: stream shape, exit 0, result fields, edits land in cwd', () => {
  const sb = sandbox();
  writeScenario(sb, { default: { behavior: 'success', edits: [{ path: 'dir/sub/a.txt', content: 'hello\n' }, { path: 'dir/sub/a.txt', content: 'more\n', append: true }],
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 }, cost_usd: 0.123, turns: 3, message: 'all done' } });
  const r = run(sb, BASE, { env: { AOS_TASK_ID: 't1' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(sb.cwd, 'dir/sub/a.txt'), 'utf8'), 'hello\nmore\n');
  const t = types(r.lines);
  assert.equal(t[0], 'system/init');
  assert.equal(t.at(-1), 'result');
  assert.ok(t.includes('rate_limit_event'), 'benign rate_limit_event emitted by default');
  assert.ok(t.includes('assistant') && t.includes('user'));
  const init = r.lines[0];
  assert.equal(init.cwd, sb.cwd); assert.equal(init.model, 'claude-haiku-5-5'); assert.deepEqual(init.mcp_servers, []);
  const res = r.result;
  assert.equal(res.subtype, 'success'); assert.equal(res.is_error, false); assert.equal(res.result, 'all done');
  assert.match(res.session_id, UUID); assert.equal(res.num_turns, 3); assert.equal(res.total_cost_usd, 0.123);
  assert.equal(res.terminal_reason, 'completed'); assert.equal(res.api_error_status, null);
  assert.deepEqual(res.permission_denials, []);
  assert.equal(res.usage.input_tokens, 10); assert.equal(res.usage.output_tokens, 20);
  assert.equal(res.usage.cache_read_input_tokens, 300); assert.equal(res.usage.cache_creation_input_tokens, 40);
  assert.equal(res.modelUsage['claude-haiku-5-5'].costUSD, 0.123);
  // per-message usage, deduped by message id, sums to the result usage
  const byId = new Map();
  for (const l of r.lines) if (l.type === 'assistant') byId.set(l.message.id, l.message.usage);
  assert.equal(byId.size, 3);
  assert.equal([...byId.values()].reduce((a, u) => a + u.output_tokens, 0), 20);
  assert.equal(r.lines.every((l) => typeof l === 'object' && (l.session_id === res.session_id)), true);
});

test('rate_limit_event shape (benign default and configured)', () => {
  const sb = sandbox();
  writeScenario(sb, { default: { behavior: 'success', rate_limit: { five_hour_utilization: 0.85, seven_day_utilization: 0.4, five_hour_resets_at: 1900000000, seven_day_resets_at: 1900900000 } } });
  const ev = run(sb, BASE).lines.find((l) => l.type === 'rate_limit_event');
  const i = ev.rate_limit_info;
  assert.equal(i.status, 'allowed_warning'); assert.equal(i.rateLimitType, 'five_hour'); assert.equal(i.utilization, 0.85); assert.equal(i.resetsAt, 1900000000);
  assert.deepEqual(i.unifiedWindows, { five_hour: { utilization: 0.85, resetsAt: 1900000000 }, seven_day: { utilization: 0.4, resetsAt: 1900900000 } });
  writeScenario(sb, { default: {} });
  const benign = run(sb, BASE).lines.find((l) => l.type === 'rate_limit_event').rate_limit_info;
  assert.equal(benign.status, 'allowed'); assert.ok(benign.resetsAt > Date.now() / 1000);
});

test('--output-format json prints only the result object; text prints the message', () => {
  const sb = sandbox();
  writeScenario(sb, { default: { message: 'hi there' } });
  const j = run(sb, ['-p', 'x', '--output-format', 'json']);
  assert.equal(j.lines.length, 1); assert.equal(j.lines[0].type, 'result'); assert.equal(j.lines[0].result, 'hi there');
  const t = run(sb, ['-p', 'x']);
  assert.equal(t.stdout, 'hi there\n');
});

test('stream-json without --verbose fails like the real CLI', () => {
  const sb = sandbox(); writeScenario(sb, {});
  const r = run(sb, ['-p', 'x', '--output-format', 'stream-json']);
  assert.equal(r.code, 1); assert.match(r.stderr, /requires --verbose/); assert.equal(r.stdout, '');
});

test('fail_checks applies the scenario edits and still exits 0', () => {
  const sb = sandbox();
  writeScenario(sb, { default: { behavior: 'fail_checks', edits: [{ path: 'a.txt', content: 'WRONG\n' }] } });
  const r = run(sb, BASE);
  assert.equal(r.code, 0); assert.equal(r.result.subtype, 'success');
  assert.equal(fs.readFileSync(path.join(sb.cwd, 'a.txt'), 'utf8'), 'WRONG\n');
});

test('commit:true commits edits in cwd', () => {
  const sb = sandbox();
  spawnSync('git', ['init', '-q'], { cwd: sb.cwd });
  writeScenario(sb, { default: { edits: [{ path: 'a.txt', content: 'x\n' }], commit: true } });
  assert.equal(run(sb, BASE).code, 0);
  const log = spawnSync('git', ['log', '--format=%an %s'], { cwd: sb.cwd, encoding: 'utf8' });
  assert.match(log.stdout, /^fake-claude /);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: sb.cwd, encoding: 'utf8' }).stdout, '');
});

test('error: exit 1, is_error, error_during_execution', () => {
  const sb = sandbox();
  writeScenario(sb, { default: { behavior: 'error', message: 'kaboom' } });
  const r = run(sb, BASE);
  assert.equal(r.code, 1); assert.equal(r.result.is_error, true); assert.equal(r.result.subtype, 'error_during_execution');
  assert.deepEqual(r.result.errors, ['kaboom']);
});

test('rate_limit: rejected event, utilization 1.0, exit 1, 429-shaped result, text configurable', () => {
  const sb = sandbox();
  writeScenario(sb, { default: { behavior: 'rate_limit', message: 'custom limit text', rate_limit: { five_hour_resets_at: 1900000000 } } });
  const r = run(sb, BASE);
  assert.equal(r.code, 1);
  const ev = r.lines.find((l) => l.type === 'rate_limit_event').rate_limit_info;
  assert.equal(ev.status, 'rejected'); assert.equal(ev.utilization, 1); assert.equal(ev.unifiedWindows.five_hour.utilization, 1); assert.equal(ev.resetsAt, 1900000000);
  assert.equal(r.result.is_error, true); assert.equal(r.result.api_error_status, 429); assert.equal(r.result.result, 'custom limit text');
  assert.equal(r.result.usage.output_tokens, 0);
  assert.equal(types(r.lines).filter((t) => t === 'assistant').length, 0);
});

test('budget_exceeded: error_max_budget_usd exit 1; and a too-expensive success converts under --max-budget-usd', () => {
  const sb = sandbox();
  writeScenario(sb, { default: { behavior: 'budget_exceeded' } });
  let r = run(sb, [...BASE, '--max-budget-usd', '0.0005']);
  assert.equal(r.code, 1); assert.equal(r.result.subtype, 'error_max_budget_usd'); assert.equal(r.result.terminal_reason, 'budget_exhausted');
  assert.deepEqual(r.result.errors, ['Reached maximum budget ($0.0005)']); assert.equal('result' in r.result, false);
  writeScenario(sb, { default: { behavior: 'success', cost_usd: 1.5 } });
  r = run(sb, [...BASE, '--max-budget-usd', '1']);
  assert.equal(r.code, 1); assert.equal(r.result.subtype, 'error_max_budget_usd');
  r = run(sb, [...BASE, '--max-budget-usd', '2']);
  assert.equal(r.code, 0);
});

test('denied_tool: exit 0 with scenario permission_denials is reflected in result and system/permission_denied', () => {
  const sb = sandbox();
  const pd = [{ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }];
  writeScenario(sb, { default: { behavior: 'denied_tool', permission_denials: pd } });
  const r = run(sb, BASE);
  assert.equal(r.code, 0); assert.equal(r.result.is_error, false); assert.equal(r.result.subtype, 'success');
  assert.equal(r.result.permission_denials.length, 1);
  assert.equal(r.result.permission_denials[0].tool_name, 'Bash'); assert.deepEqual(r.result.permission_denials[0].tool_input, pd[0].tool_input);
  assert.match(r.result.permission_denials[0].tool_use_id, /^toolu_/);
  assert.ok(r.lines.some((l) => l.type === 'system' && l.subtype === 'permission_denied' && l.tool_name === 'Bash'));
});

test('crash: exit 137 after partial edits, no result line', () => {
  const sb = sandbox();
  writeScenario(sb, { default: { behavior: 'crash', edits: [{ path: 'one.txt', content: '1' }, { path: 'two.txt', content: '2' }] } });
  const r = run(sb, BASE);
  assert.equal(r.code, 137); assert.equal(r.result, undefined);
  assert.ok(fs.existsSync(path.join(sb.cwd, 'one.txt'))); assert.ok(!fs.existsSync(path.join(sb.cwd, 'two.txt')));
});

test('slow: waits delay_ms then succeeds', () => {
  const sb = sandbox();
  writeScenario(sb, { default: { behavior: 'slow', delay_ms: 400 } });
  const t0 = Date.now(); const r = run(sb, BASE);
  assert.equal(r.code, 0); assert.ok(Date.now() - t0 >= 380);
});

test('hang + SIGTERM: exit 143, no result, transcript cost-state line with cumulative usage', async () => {
  const sb = sandbox();
  const sid = '11111111-1111-4111-8111-000000000009';
  writeScenario(sb, { default: { behavior: 'hang', edits: [{ path: 'partial.txt', content: 'p' }], usage: { input_tokens: 4, output_tokens: 99, cache_read_input_tokens: 0, cache_creation_input_tokens: 7 }, cost_usd: 0.02 } });
  const h = startAsync(sb, [...BASE, '--session-id', sid]);
  await h.waitFor(/Working on it/);
  h.child.kill('SIGTERM');
  const exit = await h.closed;
  assert.equal(exit.code, 143);
  assert.ok(!h.out.includes('"type":"result"'));
  assert.ok(fs.existsSync(path.join(sb.cwd, 'partial.txt')), 'edits before the hang stay in the worktree');
  const lines = readJsonl(path.join(sb.state, `${sid}.transcript.jsonl`));
  const cs = lines.at(-1);
  assert.equal(cs.type, 'cost-state'); assert.equal(cs.sessionId, sid);
  const mu = cs.modelUsage['claude-haiku-5-5'];
  assert.equal(mu.outputTokens, 99); assert.equal(mu.inputTokens, 4); assert.equal(mu.cacheCreationInputTokens, 7);
  assert.ok(Math.abs(cs.totalCostUSD - 0.02) < 1e-9);
});

test('ignore_sigterm survives SIGTERM and dies to SIGKILL', async () => {
  const sb = sandbox();
  writeScenario(sb, { default: { behavior: 'hang', ignore_sigterm: true } });
  const h = startAsync(sb, BASE);
  await h.waitFor(/Working on it/);
  h.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.exit, null, 'still running after SIGTERM');
  h.child.kill('SIGKILL');
  assert.equal((await h.closed).signal, 'SIGKILL');
});

test('per-attempt scenario lists advance via AOS_FAKE_STATE; last step repeats; regex keys; per-task counters', () => {
  const sb = sandbox();
  writeScenario(sb, { default: { message: 'default' }, tasks: {
    t1: [{ message: 'first' }, { message: 'second' }],
    '^re-\\d+$': [{ message: 're-first' }, { message: 're-second' }],
    'MARKER-IN-PROMPT': { message: 'by prompt' } } });
  const msg = (id, prompt = 'p') => run(sb, ['-p', prompt, '--output-format', 'json'], { env: { AOS_TASK_ID: id } }).lines[0].result;
  assert.deepEqual([msg('t1'), msg('t1'), msg('t1')], ['first', 'second', 'second']);
  assert.equal(msg('t2'), 'default');
  assert.equal(msg('re-7'), 're-first'); assert.equal(msg('re-7'), 're-second');
  assert.equal(msg('re-8'), 're-first', 'counter is per task id');
  assert.equal(msg('zz', 'has MARKER-IN-PROMPT inside'), 'by prompt');
  const inv = readJsonl(path.join(sb.state, 'invocations.ndjson')).filter((i) => i.task_id === 't1');
  assert.deepEqual(inv.map((i) => i.attempt), [0, 1, 2]);
});

test('invocation log records argv, prompt, model, AOS_* env', () => {
  const sb = sandbox(); writeScenario(sb, {});
  run(sb, ['-p', 'PROMPT TEXT', '--model', 'opus', '--output-format', 'json'], { env: { AOS_TASK_ID: 't9', AOS_GOAL_ID: 'g1' } });
  const [i] = readJsonl(path.join(sb.state, 'invocations.ndjson'));
  assert.equal(i.prompt, 'PROMPT TEXT'); assert.equal(i.model, 'opus'); assert.equal(i.env.AOS_GOAL_ID, 'g1'); assert.equal(i.task_id, 't9');
});

// ---- hooks
function writeHook(sb) {
  const hook = path.join(sb.root, 'hook.mjs');
  const log = path.join(sb.root, 'hook.log');
  fs.writeFileSync(hook, `
import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ p, task: process.env.AOS_TASK_ID, goal: process.env.AOS_GOAL_ID, proj: process.env.CLAUDE_PROJECT_DIR }) + '\\n');
const ti = p.tool_input || {};
const ev = p.hook_event_name;
if (ev === 'PreToolUse') {
  if (p.tool_name === 'Bash' && /git push/.test(ti.command)) { process.stderr.write('no pushing'); process.exit(2); }
  if (p.tool_name === 'Write' && /forbidden/.test(ti.file_path)) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'outside scope' } }));
  }
}
if (ev === 'PermissionRequest') {
  const ok = p.tool_name === 'Write' && !/blocked/.test(ti.file_path);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: ok ? { behavior: 'allow' } : { behavior: 'deny', message: 'not approved' } } }));
}
`);
  const settings = path.join(sb.root, 'settings.json');
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`;
  fs.writeFileSync(settings, JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 30 }] }],
    PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 30 }] }],
  } }));
  return { settings, log: () => (fs.existsSync(log) ? readJsonl(log) : []) };
}

test('hooks: deny hook blocks edits (JSON deny and exit 2), allowed edits apply, denials reported, env inherited', () => {
  const sb = sandbox(); const hk = writeHook(sb);
  writeScenario(sb, { default: { behavior: 'denied_tool', edits: [
    { path: 'forbidden/x.txt', content: 'no' }, { path: 'ok.txt', content: 'yes' }, { path: 'blocked.txt', content: 'no' }],
  commands: [{ command: 'git push origin main' }] } });
  const r = run(sb, [...BASE, '--settings', hk.settings, '--permission-mode', 'default'], { env: { AOS_TASK_ID: 'task-77', AOS_GOAL_ID: 'goal-5' } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(sb.cwd, 'forbidden/x.txt')));
  assert.ok(!fs.existsSync(path.join(sb.cwd, 'blocked.txt')));
  assert.equal(fs.readFileSync(path.join(sb.cwd, 'ok.txt'), 'utf8'), 'yes');
  const den = r.result.permission_denials;
  assert.deepEqual(den.map((d) => d.tool_name), ['Write', 'Write', 'Bash']);
  assert.equal(den[0].tool_input.file_path, path.join(sb.cwd, 'forbidden/x.txt'));
  const msgs = r.lines.filter((l) => l.type === 'user').map((l) => l.message.content[0].content);
  assert.ok(msgs.some((m) => m === 'PreToolUse:Write hook error: outside scope'), msgs.join('|'));
  assert.ok(msgs.some((m) => /^PreToolUse:Bash hook error: \[.*\]: no pushing$/.test(m)));
  assert.ok(msgs.some((m) => m === 'not approved'));
  // payload + env
  const calls = hk.log();
  const pre = calls.find((c) => c.p.hook_event_name === 'PreToolUse' && c.p.tool_name === 'Write');
  assert.equal(pre.task, 'task-77'); assert.equal(pre.goal, 'goal-5'); assert.equal(pre.proj, sb.cwd);
  for (const k of ['tool_name', 'tool_input', 'cwd', 'session_id', 'hook_event_name', 'permission_mode', 'tool_use_id']) assert.ok(k in pre.p, k);
  assert.equal(pre.p.cwd, sb.cwd); assert.equal(pre.p.session_id, r.result.session_id); assert.equal(pre.p.permission_mode, 'default');
  assert.ok(calls.some((c) => c.p.hook_event_name === 'PermissionRequest'));
  assert.ok(!calls.some((c) => c.p.hook_event_name === 'PermissionRequest' && /forbidden/.test(c.p.tool_input.file_path || '')), 'PreToolUse deny short-circuits');
});

test('hooks: inline JSON --settings, bad settings fails', () => {
  const sb = sandbox(); writeScenario(sb, { default: { edits: [{ path: 'a.txt', content: 'x' }] } });
  const bad = run(sb, [...BASE, '--settings', path.join(sb.root, 'nope.json')]);
  assert.equal(bad.code, 1); assert.match(bad.stderr, /Invalid settings/);
  const hk = writeHook(sb);
  const inline = run(sb, [...BASE, '--settings', fs.readFileSync(hk.settings, 'utf8')]);
  assert.equal(inline.code, 0); assert.ok(hk.log().length > 0);
});

test('hooks: PermissionRequest with no decision auto-denies; allowedTools bypasses it', () => {
  const sb = sandbox();
  const silent = path.join(sb.root, 'silent.mjs'); fs.writeFileSync(silent, 'process.stdin.resume(); process.stdin.on("end", () => {});');
  const settings = path.join(sb.root, 's.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(silent)}` }] }] } }));
  writeScenario(sb, { default: { edits: [{ path: 'a.txt', content: 'x' }] } });
  let r = run(sb, [...BASE, '--settings', settings]);
  assert.equal(r.result.permission_denials.length, 1); assert.ok(!fs.existsSync(path.join(sb.cwd, 'a.txt')));
  r = run(sb, [...BASE, '--settings', settings, '--allowedTools', 'Write']);
  assert.equal(r.result.permission_denials.length, 0); assert.ok(fs.existsSync(path.join(sb.cwd, 'a.txt')));
});

test('hook timeout is fail-closed for PermissionRequest', () => {
  const sb = sandbox();
  const slow = path.join(sb.root, 'slow.mjs'); fs.writeFileSync(slow, 'setTimeout(()=>{}, 30000); process.stdin.resume();');
  const settings = path.join(sb.root, 's.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', timeout: 1, command: `${JSON.stringify(process.execPath)} ${JSON.stringify(slow)}` }] }] } }));
  writeScenario(sb, { default: { edits: [{ path: 'a.txt', content: 'x' }] } });
  const r = run(sb, [...BASE, '--settings', settings]);
  assert.equal(r.result.permission_denials.length, 1); assert.ok(!fs.existsSync(path.join(sb.cwd, 'a.txt')));
});

test('commands with run:true execute in cwd', () => {
  const sb = sandbox(); writeScenario(sb, { default: { commands: [{ command: 'echo hi > ran.txt', run: true }] } });
  assert.equal(run(sb, BASE).code, 0);
  assert.equal(fs.readFileSync(path.join(sb.cwd, 'ran.txt'), 'utf8'), 'hi\n');
});

test('tools outside --tools are tool errors, not permission denials', () => {
  const sb = sandbox();
  writeScenario(sb, { default: { edits: [{ path: 'a.txt', content: 'x' }] } });
  const r = run(sb, [...BASE, '--tools', 'Read,Bash']);
  assert.deepEqual(r.result.permission_denials, []); assert.ok(!fs.existsSync(path.join(sb.cwd, 'a.txt')));
  assert.deepEqual(r.lines.find((l) => l.subtype === 'init').tools, ['Read', 'Bash']);
});

test('SessionStart hooks run with inherited env and emit hook_started/hook_response', () => {
  const sb = sandbox(); const hk = writeHook(sb);
  const settings = path.join(sb.root, 'ss.json');
  const base = JSON.parse(fs.readFileSync(hk.settings, 'utf8'));
  base.hooks.SessionStart = [{ hooks: [{ type: 'command', command: base.hooks.PreToolUse[0].hooks[0].command }] }];
  fs.writeFileSync(settings, JSON.stringify(base));
  writeScenario(sb, {});
  const r = run(sb, [...BASE, '--settings', settings], { env: { AOS_TASK_ID: 'ss-1' } });
  const t = types(r.lines);
  assert.ok(t.indexOf('system/hook_started') < t.indexOf('system/init'));
  assert.ok(t.includes('system/hook_response'));
  assert.equal(hk.log()[0].task, 'ss-1'); assert.equal(hk.log()[0].p.hook_event_name, 'SessionStart');
});

// ---- planner
test('planner marker returns scenario planner.plan as result text (and structured_output with --json-schema)', () => {
  const sb = sandbox();
  const plan = { tasks: [{ id: 't1', title: 'x', depends_on: [], model_tier: 'haiku' }], risks: [] };
  writeScenario(sb, { default: { message: 'worker' }, planner: { plan, usage: { output_tokens: 1234 } }, tasks: { t1: [{ message: 'not planner' }] } });
  const r = run(sb, ['-p', 'You are the AOS_PLANNER. Goal: x', '--model', 'opus', '--output-format', 'json'], { env: { AOS_TASK_ID: 't1' } });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.lines[0].result), plan);
  assert.equal(r.lines[0].usage.output_tokens, 1234);
  assert.equal('structured_output' in r.lines[0], false);
  const s = run(sb, ['-p', 'AOS_PLANNER', '--output-format', 'json', '--json-schema', '{}']);
  assert.deepEqual(s.lines[0].structured_output, plan);
  const fenced = (writeScenario(sb, { planner: { plan, plan_format: 'fenced' } }), run(sb, ['-p', 'AOS_PLANNER', '--output-format', 'json']));
  assert.match(fenced.lines[0].result, /^```json\n/);
  // planner attempts count separately from tasks
  const inv = readJsonl(path.join(sb.state, 'invocations.ndjson'));
  assert.ok(inv.filter((i) => i.planner).length === 3);
});

// ---- scenario errors and CLI handling
test('scenario errors: unset, missing file, invalid JSON, unknown behavior', () => {
  const sb = sandbox();
  let r = run(sb, BASE, { env: { AOS_FAKE_SCENARIO: undefined } });
  assert.equal(r.code, 2); assert.match(r.stderr, /AOS_FAKE_SCENARIO is not set/); assert.equal(r.stdout, '');
  r = run(sb, BASE, { env: { AOS_FAKE_SCENARIO: path.join(sb.root, 'missing.json') } });
  assert.equal(r.code, 2); assert.match(r.stderr, /cannot read scenario file .*missing\.json: ENOENT/);
  writeScenario(sb, '{ not json');
  r = run(sb, BASE); assert.equal(r.code, 2); assert.match(r.stderr, /is not valid JSON/);
  writeScenario(sb, { default: { behavior: 'explode' } });
  r = run(sb, BASE); assert.equal(r.code, 2); assert.match(r.stderr, /unknown behavior 'explode'/);
});

test('flags: all worker flags accepted, unknown boolean flags ignored, prompt from stdin, --version', () => {
  const sb = sandbox(); writeScenario(sb, { default: { message: 'ok' } });
  const full = ['-p', 'prompt', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--session-id', '22222222-2222-4222-8222-222222222222', '--max-turns', '30', '--max-budget-usd', '1.5',
    '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--allowedTools', 'Read,Glob,Grep', '--disallowedTools', 'WebFetch',
    '--permission-mode', 'default', '--append-system-prompt', 'RULES', '--add-dir', '/tmp/x', '--some-future-flag'];
  const r = run(sb, full);
  assert.equal(r.code, 0, r.stderr); assert.equal(r.result.session_id, '22222222-2222-4222-8222-222222222222');
  const viaStdin = run(sb, ['-p', '--output-format', 'json'], { input: 'prompt from stdin AOS_X' });
  assert.equal(viaStdin.code, 0);
  assert.equal(readJsonl(path.join(sb.state, 'invocations.ndjson')).at(-1).prompt, 'prompt from stdin AOS_X');
  const resumed = run(sb, ['-p', 'again', '--output-format', 'json', '--resume', '33333333-3333-4333-8333-333333333333']);
  assert.equal(resumed.lines[0].session_id, '33333333-3333-4333-8333-333333333333');
  const v = run(sb, ['--version']);
  assert.match(v.stdout, /^\d+\.\d+\.\d+ \(Claude Code\)/);
});

test('flags: clearly invalid values fail like the real CLI (exit 1, nothing on stdout)', () => {
  const sb = sandbox(); writeScenario(sb, {});
  for (const bad of [['--output-format', 'xml'], ['--permission-mode', 'yolo'], ['--max-turns', 'abc'], ['--max-budget-usd', '-1'],
    ['--session-id', 'not-a-uuid'], ['--setting-sources', 'bogus'], ['--model']]) {
    const r = run(sb, ['-p', 'x', ...bad]);
    assert.equal(r.code, 1, bad.join(' ')); assert.equal(r.stdout, ''); assert.ok(r.stderr.length > 0);
  }
});
