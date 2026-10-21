// Unit tests for the small modules: glob, shell, state, plan, governor, worker, checks, git.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchGlob, globsOverlap, scopesOverlap } from '../lib/glob.mjs';
import { parseShell } from '../lib/shell.mjs';
import { validatePlan, extractJson, findCycle, buildPlannerPrompt, validateScope } from '../lib/plan.mjs';
import { Governor, parseRateLimitEvent, detectLimitFailure, usageOf, checkBudgets, epochToMs } from '../lib/governor.mjs';
import { buildWorkerPrompt, WORKER_RULES, buildArgs, buildEnv, StreamTail, buildSettings, killGroup, groupAlive } from '../lib/worker.mjs';
import { runCheck, runChecks, commandAllowed } from '../lib/checks.mjs';
import { appendEvent, readEvents, atomicWrite, readJSON, normalizeGoalSpec, orchRoot, orchLocation, enqueueCommand, drainCommands } from '../lib/state.mjs';
import { validateEvent, validateGoal } from '../lib/schema.mjs';
import { mkSandbox, ptask, NO_OS_SANDBOX } from './helpers.mjs';
import { spawn } from 'node:child_process';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aos-unit-'));

test('glob: scope matching and conservative overlap', () => {
  assert.ok(matchGlob('Makefile', 'Makefile')); assert.ok(matchGlob('src', 'src/a/b.js')); assert.ok(!matchGlob('src', 'srcx/a'));
  assert.ok(matchGlob('src/**', 'src/a/b.js')); assert.ok(matchGlob('**/*.md', 'a/b/c.md')); assert.ok(matchGlob('**/*.md', 'c.md'));
  assert.ok(matchGlob('src/*.js', 'src/a.js')); assert.ok(!matchGlob('src/*.js', 'src/x/a.js')); assert.ok(!matchGlob('src/*.js', 'lib/a.js'));
  assert.ok(globsOverlap('src/**', 'src/a/*.js')); assert.ok(!globsOverlap('src/a/**', 'src/b/**')); assert.ok(!globsOverlap('Makefile', 'heartbeat/test.mjs'));
  assert.ok(scopesOverlap(['a.txt', 'src/**'], ['b.txt', 'src/x.js'])); assert.ok(!scopesOverlap(['a.txt'], ['b.txt']));
});

test('shell: tokeniser splits operators, honours quotes, extracts redirects, flags the unanalysable', () => {
  const p = parseShell(`echo 'a;b' "c && d" e\\ f; ls -la | wc -l && cat x 2>/dev/null > out.txt || true`);
  assert.deepEqual(p.commands.map((c) => c.argv), [['echo', 'a;b', 'c && d', 'e f'], ['ls', '-la'], ['wc', '-l'], ['cat', 'x'], ['true']]);
  assert.deepEqual(p.commands[3].redirects, [{ op: '>', target: '/dev/null' }, { op: '>', target: 'out.txt' }].map((r, i) => (i === 0 ? { op: '>', target: '/dev/null' } : r)));
  assert.equal(p.commands[2].ops, '|');
  assert.equal(parseShell('echo $(date)').flags.substitution, true); assert.equal(parseShell('echo `date`').flags.substitution, true);
  assert.equal(parseShell('echo "$(date)"').flags.substitution, true); assert.equal(parseShell("echo '$(date)'").flags.substitution, false);
  assert.equal(parseShell('echo $HOME').flags.expansion, true); assert.equal(parseShell('cat <<EOF').flags.heredoc, true);
  assert.equal(parseShell('(cd x; ls)').flags.subshell, true); assert.equal(parseShell('echo "x').flags.unterminated, true);
  assert.equal(parseShell('ls # comment; rm -rf /').commands.length, 1);
});

test('state: atomic JSON writes, append-only events with strictly increasing seq (also across instances), schema-valid', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'x.json'); atomicWrite(f, { a: 1 }); atomicWrite(f, { a: 2 });
    assert.deepEqual(readJSON(f), { a: 2 }); assert.deepEqual(fs.readdirSync(dir), ['x.json']); assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    const clock = { now: () => 1_700_000_000_000 };
    for (let i = 0; i < 5; i++) appendEvent(dir, { type: i % 2 ? 'orch.worker.started' : 'task.ready', goal_id: 'g', task_id: 't', data: { i } }, clock);
    fs.appendFileSync(path.join(dir, 'events.ndjson'), '{"partial": '); // torn write is ignored
    assert.deepEqual(readEvents(dir).map((e) => e.seq), [1, 2, 3, 4, 5]);
    for (const e of readEvents(dir)) assert.deepEqual(validateEvent(e), []);
    assert.notDeepEqual(validateEvent({ ts: '2026-01-01T00:00:00Z', seq: 1, type: 'not.a.type', actor: 'x' }), []);
    assert.deepEqual(validateEvent({ ts: '2026-01-01T00:00:00Z', seq: 1, type: 'orch.approval.decided', actor: 'x' }), []);
    enqueueCommand(dir, { cmd: 'pause' }, clock); enqueueCommand(dir, { cmd: 'resume' }, clock);
    assert.deepEqual(drainCommands(dir).map((c) => c.cmd), ['pause', 'resume']); assert.deepEqual(drainCommands(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('state: orch dir default and goal spec validation (budget is mandatory and valid)', () => {
  assert.equal(orchRoot({ AOS_ORCH_DIR: '/x/y' }), '/x/y');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-home-'));
  try {
    assert.equal(orchRoot({ HOME: home }), path.join(home, '.aos', 'orch'), 'new default');
    assert.equal(orchRoot({ HOME: home, XDG_STATE_HOME: '/xdg' }), '/xdg/aos/orch');
    const old = path.join(home, '.claude', 'plugins', 'data', 'aos-dashboard-aos-local', 'orch');
    fs.mkdirSync(old, { recursive: true });
    assert.deepEqual(orchLocation({ HOME: home }), { dir: old, legacy: true, fresh: path.join(home, '.aos', 'orch') }, 'old dir kept while the new one is absent');
    assert.equal(orchRoot({ HOME: home, CLAUDE_PLUGIN_DATA: '/nope' }), path.join(home, '.aos', 'orch'));
    assert.equal(orchRoot({ HOME: home, AOS_ORCH_DIR: '/x/y' }), '/x/y', 'AOS_ORCH_DIR overrides both');
    fs.mkdirSync(path.join(home, '.aos', 'orch'), { recursive: true });
    assert.equal(orchLocation({ HOME: home }).legacy, false, 'new dir wins once it exists');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  const ok = { title: 'T', success_criteria: [{ text: 'x', check: { argv: ['true'], timeout_s: 5 } }], orch: { repo: '/r' } };
  const g = normalizeGoalSpec(ok, { clock: { now: () => Date.UTC(2026, 9, 20) } });
  assert.deepEqual(validateGoal(g), []); assert.match(g.id, /^g-20261020-t-[0-9a-f]{4}$/); assert.equal(g.status, 'draft'); assert.equal(g.orch.integration_branch, `aos/${g.id}/integration`);
  assert.equal(g.orch.approval_policy.plan, 'required', 'strict default: plan approval required');
  assert.throws(() => normalizeGoalSpec({ ...ok, orch: { repo: 'relative' } }), /absolute/);
  assert.throws(() => normalizeGoalSpec({ ...ok, success_criteria: [] }), /at least one/);
  assert.throws(() => normalizeGoalSpec({ ...ok, budget: { max_ticks: 0 } }), /budget/);
  assert.throws(() => normalizeGoalSpec({ ...ok, id: '../evil' }), /invalid goal id/);
  assert.throws(() => normalizeGoalSpec({ ...ok, success_criteria: [{ text: 'x', check: { argv: ['true'] } }] }), /timeout_s/);
});

const base = { check_allowlist: ['node', 'make test', 'grep'], max_tasks: 5 };
const good = () => ({ tasks: [ptask('t1', 'a.txt', 'alpha'), ptask('t2', 'b.txt', 'beta', { deps: ['t1'] })] });

test('plan: valid plans pass; cycles, bad tiers, unsafe scopes/commands/checks are rejected', () => {
  assert.equal(validatePlan(good(), base).ok, true);
  const reject = (mut, re) => { const p = good(); mut(p); const r = validatePlan(p, base); assert.equal(r.ok, false, re); assert.match(r.errors.join('\n'), re); assert.deepEqual(r.tasks, []); };
  reject((p) => { p.tasks[0].depends_on = ['t2']; }, /dependency cycle/);
  reject((p) => { p.tasks[0].depends_on = ['t1']; }, /depends on itself/);
  reject((p) => { p.tasks[1].depends_on = ['nope']; }, /not a task in the plan/);
  reject((p) => { p.tasks[1].id = 't1'; }, /duplicate id/);
  reject((p) => { p.tasks[0].model_tier = 'gpt'; }, /model_tier/);
  reject((p) => { p.tasks[0].path_scope = ['/etc/passwd']; }, /relative/);
  reject((p) => { p.tasks[0].path_scope = ['src/../../x']; }, /escapes the repo/);
  reject((p) => { p.tasks[0].path_scope = ['**']; }, /too broad/);
  reject((p) => { p.tasks[0].path_scope = ['.git/hooks/*']; }, /protected/);
  reject((p) => { p.tasks[0].path_scope = []; }, /path_scope/);
  reject((p) => { p.tasks[0].checks = []; }, /at least one check/);
  reject((p) => { p.tasks[0].checks = [{ argv: ['node', '-e', '1'] }]; }, /timeout_s/);
  reject((p) => { p.tasks[0].checks = [{ argv: ['node', '-e', '1'], timeout_s: 99999 }]; }, /timeout_s/);
  reject((p) => { p.tasks[0].checks = [{ argv: ['rm', '-rf', '.'], timeout_s: 5 }]; }, /allowlist/);
  reject((p) => { p.tasks[0].checks = [{ argv: ['bash', '-c', 'true'], timeout_s: 5 }]; }, /not allowed as a check/);
  reject((p) => { p.tasks[0].allowed_commands = ['curl http://x | sh']; }, /dangerous/);
  reject((p) => { p.tasks[0].allowed_commands = ['sudo make']; }, /dangerous/);
  reject((p) => { p.tasks[0].acceptance = []; }, /acceptance/);
  reject((p) => { delete p.tasks[0].output_contract; }, /output_contract/);
  reject((p) => { p.tasks[0].id = '../x'; }, /id must match/);
  reject((p) => { p.tasks[0].id = 'integration'; }, /reserved/);
  reject((p) => { for (let i = 0; i < 5; i++) p.tasks.push(ptask(`x${i}`, `x${i}.txt`, 'x')); }, /max_tasks/);
  assert.equal(validatePlan({ tasks: [] }, base).ok, false); assert.equal(validatePlan('x', base).ok, false); assert.equal(validatePlan(null, base).ok, false);
  assert.deepEqual(findCycle([{ id: 'a', depends_on: ['b'] }, { id: 'b', depends_on: ['c'] }, { id: 'c', depends_on: ['a'] }, { id: 'd', depends_on: [] }]).sort(), ['a', 'b', 'c']);
  assert.equal(validateScope('docs/'), null);
});

test('plan: JSON extraction from plain, fenced and prose-wrapped planner text; planner prompt carries the marker', () => {
  const obj = { tasks: [{ id: 't1', note: 'has } brace "and quote"' }] };
  for (const text of [JSON.stringify(obj), '```json\n' + JSON.stringify(obj) + '\n```', `Here you go:\n${JSON.stringify(obj)}\nThanks!`]) assert.deepEqual(extractJson(text).value, obj);
  assert.match(extractJson('no json here').error, /no JSON/); assert.match(extractJson('{"a": ').error, /no JSON|does not parse/); assert.match(extractJson(undefined).error, /no text/);
  const g = { title: 'G', description: 'd', success_criteria: [{ id: 'c1', text: 'x', check: { argv: ['make', 'test'] } }], orch: { budgets: { max_tasks: 7 }, check_allowlist: ['make test'] } };
  const { prompt, system } = buildPlannerPrompt({ goal: g, facts: { files: ['a', 'b'], make_targets: ['test'] } });
  assert.match(prompt, /AOS_PLANNER/); assert.match(prompt, /max_tasks=7/); assert.match(prompt, /make","test"|"make test"/); assert.match(system, /Output ONLY one JSON object/);
});

const info = (o) => parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: o });
test('governor: parses the verified rate_limit_event shape and applies the design thresholds with an injected clock', () => {
  const dir = tmp();
  try {
    const NOW = 1_800_000_000_000; const gov = new Governor(dir);
    const ev = info({ status: 'allowed_warning', resetsAt: NOW / 1000 + 7200, rateLimitType: 'seven_day', utilization: 0.84, surpassedThreshold: 0.75,
      unifiedWindows: { five_hour: { utilization: 0.14, resetsAt: NOW / 1000 + 600 }, seven_day: { utilization: 0.84, resetsAt: NOW / 1000 + 7200 } } });
    assert.equal(ev.five_hour.utilization, 0.14); assert.equal(ev.seven_day.resets_at_ms, NOW + 7200000);
    gov.observe(ev, NOW); assert.equal(gov.evaluate(NOW).dispatch, true, 'below both thresholds');
    gov.observe(info({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.8, resetsAt: NOW / 1000 + 600 } } }), NOW);
    let d = gov.evaluate(NOW); assert.equal(d.dispatch, false); assert.equal(d.paused, false); assert.equal(d.resume_at_ms, NOW + 600000);
    assert.equal(gov.evaluate(NOW + 600001).dispatch, true, 'window reset releases the reserve');
    gov.observe(info({ status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.9, resetsAt: NOW / 1000 + 86400 } } }), NOW);
    d = gov.evaluate(NOW); assert.equal(d.paused, true); assert.equal(d.manual, true); assert.equal(gov.evaluate(NOW + 90000_000).manual, false, 'hold ends when its window resets');
    gov.observe(info({ status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.95, resetsAt: NOW / 1000 + 86400 } } }), NOW);
    assert.equal(gov.evaluate(NOW).manual, true); gov.resume(NOW); assert.equal(gov.evaluate(NOW + 700000).dispatch, true, 'manual resume silences the hold until reset');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('governor: rejected status pauses until resetsAt + jitter; without resetsAt it backs off 15 -> 30 -> 60 -> 240 min', () => {
  const dir = tmp();
  try {
    const NOW = 1_800_000_000_000; const gov = new Governor(dir);
    gov.observe(info({ status: 'rejected', resetsAt: NOW / 1000 + 1000, rateLimitType: 'five_hour', utilization: 1 }), NOW);
    let d = gov.evaluate(NOW); assert.equal(d.paused, true); assert.equal(d.resume_at_ms, NOW + 1_060_000);
    assert.equal(gov.evaluate(NOW + 1_059_999).paused, true); const r = gov.evaluate(NOW + 1_060_000); assert.equal(r.paused, false); assert.equal(r.resumed, true);
    const mins = [];
    for (let i = 0; i < 5; i++) { const st = gov.noteLimitFailure(NOW, 'x'); mins.push((st.pause.until_ms - NOW) / 60000); gov.evaluate(st.pause.until_ms + 1); }
    assert.deepEqual(mins, [15, 30, 60, 240, 240]);
    assert.equal(info({}) === null, false); assert.equal(parseRateLimitEvent({ type: 'x' }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('governor: limit-failure detection (matcher is UNVERIFIED and configurable), usage accounting, budgets', () => {
  assert.deepEqual(detectLimitFailure({ is_error: true, api_error_status: 429, result: 'x' }), { limited: true, overloaded: false, auth: false, certain: true, kind: 'limit', why: 'api_error_status 429' });
  assert.equal(detectLimitFailure({ is_error: true, result: '5-hour limit reached ∙ resets 3pm' }).limited, true);
  assert.equal(detectLimitFailure({ is_error: true, result: 'weird' }, '', { limit_text: 'weird' }).limited, true, 'matcher is configurable');
  assert.equal(detectLimitFailure({ is_error: true, result: 'boom', usage: { output_tokens: 5 } }).limited, false);
  assert.equal(detectLimitFailure({ is_error: false, result: 'limit reached in a story' }).limited, false);
  assert.equal(detectLimitFailure({ is_error: true, subtype: 'error_max_budget_usd', usage: {} }).limited, false);
  assert.equal(detectLimitFailure(null).limited, false);
  assert.deepEqual(usageOf({ input_tokens: 6, output_tokens: 500, cache_creation_input_tokens: 4000, cache_read_input_tokens: 14000 }), { new_tokens: 4506, cache_read_tokens: 14000 });
  const goal = { budget: { max_ticks: 10, max_usd: 1, max_wall_clock_s: 100 }, orch: { budgets: { max_new_tokens: 1000 }, usage: { new_tokens: 0, notional_usd: 0 }, started_ms: 1 } };
  assert.deepEqual(checkBudgets(goal, { nowMs: 10000, seq: 1 }), { soft: [], hard: [] });
  assert.equal(checkBudgets(goal, { nowMs: 10000, seq: 1, inflightTokens: 800 }).soft.length, 1);
  assert.match(checkBudgets(goal, { nowMs: 10000, seq: 1, inflightTokens: 1000 }).hard[0], /new-token cap/);
  assert.match(checkBudgets(goal, { nowMs: 100001, seq: 1 }).hard[0], /wall-clock/); assert.match(checkBudgets(goal, { nowMs: 1, seq: 11 }).hard[0], /tick budget/);
  goal.orch.usage.notional_usd = 1; assert.match(checkBudgets(goal, { nowMs: 1, seq: 1 }).hard[0], /notional USD/);
});

test('checkBudgets: max_ticks is a runaway-loop guard, not a time limit: a long goal at a 2s poll stays under it, a tick storm still trips it', () => {
  // real eval trials (parallel-features-8, large-codebase): 8 tasks, ~17-18 min at the evals' 2s poll -> "tick budget exceeded (501 > 500)" at 1.5% of max_usd
  const goal = { budget: { max_ticks: 500, max_usd: 5, max_wall_clock_s: 7200 }, orch: { budgets: { max_new_tokens: 2e6 }, usage: { new_tokens: 0, notional_usd: 0 }, started_ms: 1000 } };
  const at = (s, seq) => checkBudgets(goal, { nowMs: 1000 + s * 1000, seq }).hard;
  assert.deepEqual(at(18 * 60, 540), [], '18 minutes at a 2s poll'); assert.deepEqual(at(7199, 3600), [], 'the whole wall-clock budget at a 2s poll');
  assert.match(at(60, 1200)[0], /tick budget exceeded \(1200 > 560\)/, '20 ticks/s for a minute'); assert.match(at(0, 501)[0], /tick budget/);
  assert.match(checkBudgets({ ...goal, budget: { ...goal.budget, max_ticks: 0 } }, { nowMs: 60000, seq: 0 }).hard[0], /tick budget/, 'a cap of 0 still means nothing allowed');
});

test('worker: command line, environment, settings and stream parsing (usage dedupe, denials, rate limits)', () => {
  const a = buildArgs({ prompt: 'P', tier: 'sonnet', sessionId: 'sid', settingsFile: '/s.json', maxBudgetUsd: 1.5 });
  assert.deepEqual(a, ['-p', 'P', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose', '--session-id', 'sid', '--max-turns', '30', '--max-budget-usd', '1.5',
    '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--allowedTools', 'Read,Glob,Grep',
    '--append-system-prompt', a[a.indexOf('--append-system-prompt') + 1], '--settings', '/s.json']);
  const base = { HOME: '/h', USER: 'u', LANG: 'en', PATH: '/opt/x:/usr/bin', ANTHROPIC_API_KEY: 'k', SSH_AUTH_SOCK: '/s', GH_TOKEN: 't', FOO_SECRET: 's', AOS_FAKE_SCENARIO: '/sc' };
  const env = buildEnv({ base, goalId: 'g', taskId: 't', attempt: 2, worktree: '/w', policyFile: '/p', approvalsDir: '/a', tmpDir: '/tmp/x', bin: 'claude' });
  assert.deepEqual(Object.keys(env).sort(), ['AOS_APPROVALS_DIR', 'AOS_ATTEMPT', 'AOS_GOAL_ID', 'AOS_POLICY_FILE', 'AOS_TASK_ID', 'AOS_WORKTREE', 'HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR', 'USER']);
  assert.equal(env.AOS_FAKE_SCENARIO, undefined, 'fake-only variables are passed only when AOS_CLAUDE_BIN is set');
  assert.ok(env.PATH.startsWith('/usr/bin:/bin:/usr/sbin:/sbin:'));
  const env2 = buildEnv({ base: { ...base, AOS_CLAUDE_BIN: '/fake' }, goalId: 'g', taskId: 't', attempt: 1, worktree: '/w', policyFile: '/p', approvalsDir: '/a', bin: '/fake' });
  assert.equal(env2.AOS_FAKE_SCENARIO, '/sc'); assert.equal(env2.ANTHROPIC_API_KEY, undefined);
  const s = buildSettings('/h.mjs', '/n/node'); assert.equal(s.hooks.PreToolUse[0].matcher, '*'); assert.equal(s.hooks.PreToolUse[0].hooks[0].timeout, 360); assert.equal(s.hooks.PermissionRequest[0].hooks[0].timeout, 30); assert.equal(s.hooks.PermissionRequest[0].hooks[0].command, '"/n/node" "/h.mjs"');

  const dir = tmp();
  try {
    const f = path.join(dir, 's.ndjson');
    const lines = [{ type: 'system', subtype: 'init', cwd: '/w' }, { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 } } },
      { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 } } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: 5 } } } },
      { type: 'system', subtype: 'permission_denied', tool_name: 'Write', message: 'no' }];
    fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"type":"res');
    const t = new StreamTail(f); assert.equal(t.update(), true);
    assert.deepEqual(t.usage(), { new_tokens: 26, cache_read_tokens: 100 }, 'killed worker: assistant usage deduped by message id, last value wins');
    assert.equal(t.denials.length, 1); assert.equal(t.takeRateLimits().length, 1); assert.equal(t.takeRateLimits().length, 0); assert.equal(t.result, null);
    fs.appendFileSync(f, `ult","subtype":"success","usage":{"input_tokens":2,"output_tokens":3,"cache_creation_input_tokens":4,"cache_read_input_tokens":50},"total_cost_usd":0.5}\n`);
    assert.equal(t.update(), true); assert.equal(t.result.subtype, 'success'); assert.deepEqual(t.usage(), { new_tokens: 9, cache_read_tokens: 50 }, 'the result object is primary'); assert.equal(t.notionalUsd(), 0.5);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worker: killGroup terminates a detached process group, escalating to SIGKILL for a process that ignores SIGTERM', async () => {
  const c = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"], { detached: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(groupAlive(c.pid), true);
  assert.equal(await killGroup(c.pid, { graceMs: 300 }), true);
  assert.equal(groupAlive(c.pid), false);
});

test('checks: argv only, timeout kills the group, output capped, allowlist by argv prefix', async () => {
  const dir = tmp(); const env = { PATH: process.env.PATH };
  try {
    assert.equal((await runCheck({ argv: ['node', '-e', 'console.log("hi")'], timeout_s: 10 }, { cwd: dir, env, unsandboxed: NO_OS_SANDBOX })).ok, true);
    const bad = await runCheck({ argv: ['node', '-e', 'console.error("boom");process.exit(3)'], timeout_s: 10 }, { cwd: dir, env, unsandboxed: NO_OS_SANDBOX });
    assert.equal(bad.ok, false); assert.equal(bad.exit_code, 3); assert.match(bad.output, /boom/);
    const slow = await runCheck({ argv: ['node', '-e', "require('child_process').spawn('sleep',['30']);setInterval(()=>{},1000)"], timeout_s: 0.5 }, { cwd: dir, env, unsandboxed: NO_OS_SANDBOX });
    assert.equal(slow.timed_out, true); assert.equal(slow.ok, false);
    const big = await runCheck({ argv: ['node', '-e', 'process.stdout.write("x".repeat(300000))'], timeout_s: 10 }, { cwd: dir, env, unsandboxed: NO_OS_SANDBOX });
    assert.ok(big.output.length < 70000 && /truncated/.test(big.output));
    assert.equal((await runCheck({ argv: ['/nonexistent/bin'], timeout_s: 5 }, { cwd: dir, env, unsandboxed: NO_OS_SANDBOX })).ok, false);
    const shellish = await runCheck({ argv: ['echo', 'a;touch pwned'], timeout_s: 5 }, { cwd: dir, env, unsandboxed: NO_OS_SANDBOX });
    assert.equal(fs.existsSync(path.join(dir, 'pwned')), false); assert.match(shellish.output, /a;touch pwned/);
    const r = await runChecks([{ argv: ['rm', '-rf', 'x'], timeout_s: 5 }], { cwd: dir, env, allowlist: ['node'] }); assert.equal(r.ok, false); assert.equal(r.results[0].rejected, true);
    assert.equal(commandAllowed(['make', 'test', '-j2'], ['make test']), true); assert.equal(commandAllowed(['make', 'install'], ['make test']), false);
    assert.equal(commandAllowed(['/usr/bin/make', 'test'], ['make test']), true); assert.equal(commandAllowed(['x'], null), false); assert.equal(commandAllowed([], ['x']), false);
    assert.equal((await runChecks([{ argv: ['node', '-e', '0'], timeout_s: 5 }, { argv: ['node', '-e', 'process.exit(1)'], timeout_s: 5 }, { argv: ['node', '-e', '0'], timeout_s: 5 }], { cwd: dir, env, unsandboxed: NO_OS_SANDBOX })).results.length, 2, 'stops at the first failure');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('git helpers: worktree layout, branch naming, never touch the base branch, refuse foreign branches', async () => {
  const G = await import('../lib/git.mjs');
  const sb = mkSandbox('aos-git');
  try {
    const info = await G.repoInfo(sb.repo, 'main');
    assert.equal(info.root, sb.repo); assert.match(info.base_commit, /^[0-9a-f]{40}$/);
    assert.equal(G.worktreeRootFor(sb.repo, 'g1'), `${sb.repo}-aos-worktrees/g1`);
    assert.deepEqual(G.branchNames('g1', 't1'), { task: 'aos/g1/t1', integration: 'aos/g1/integration' });
    const integ = path.join(G.worktreeRootFor(sb.repo, 'g1'), 'integration');
    assert.equal((await G.worktreeAdd(sb.repo, 'g1', integ, 'aos/g1/integration', info.base_commit)).created, true);
    assert.equal((await G.worktreeAdd(sb.repo, 'g1', integ, 'aos/g1/integration', info.base_commit)).created, false, 'idempotent');
    await assert.rejects(() => G.worktreeAdd(sb.repo, 'g1', path.join(sb.root, 'x'), 'main', 'main'), /refusing to touch branch main/);
    await assert.rejects(() => G.deleteOwnBranch(sb.repo, 'g1', 'main'), /refusing/);
    const t1 = path.join(G.worktreeRootFor(sb.repo, 'g1'), 't1');
    await G.worktreeAdd(sb.repo, 'g1', t1, 'aos/g1/t1', 'aos/g1/integration');
    fs.writeFileSync(path.join(t1, 'f.txt'), 'x\n'); fs.mkdirSync(path.join(t1, 'd')); fs.writeFileSync(path.join(t1, 'd', 'g.txt'), 'y\n');
    assert.deepEqual((await G.changedPaths(t1)).sort(), ['d/g.txt', 'f.txt']);
    assert.match(await G.commitAll(t1, 'c'), /^[0-9a-f]{40}$/); assert.equal(await G.commitAll(t1, 'again'), null);
    const m = await G.mergeNoFf(integ, 'aos/g1/t1', 'merge t1'); assert.equal(m.ok, true);
    assert.equal(await G.git(sb.repo, ['rev-parse', 'main']).then((r) => r.stdout.trim()), info.base_commit);
    assert.match(await G.diffStat(sb.repo, info.base_commit, 'aos/g1/integration'), /f\.txt/);
    await G.worktreeRemove(sb.repo, t1); await G.worktreeRemove(sb.repo, integ);
    assert.deepEqual(await G.listWorktrees(sb.repo), [sb.repo]);
    assert.equal(await G.deleteOwnBranch(sb.repo, 'g1', 'aos/g1/t1'), true);
  } finally { sb.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Security review (phase 1)
import * as STATE from '../lib/state.mjs';
import * as GIT from '../lib/git.mjs';

test('review: goal/task ids cannot be "." / ".." (worktree root would become the repo parent, removed recursively at finalize)', () => {
  for (const bad of ['.', '..', '.x', '-x', 'a..b', 'x.lock', 'x.']) {
    assert.ok(!STATE.ID_RE.test(bad), bad);
    assert.throws(() => normalizeGoalSpec({ id: bad, title: 't', success_criteria: [{ text: 'x' }], orch: { repo: '/tmp/r' } }), /invalid goal id/, bad);
  }
  for (const ok of ['g-test', 't1', 'a.b', 'A_1-2.3']) assert.ok(STATE.ID_RE.test(ok), ok);
  const v = validatePlan({ tasks: [{ ...ptask('..', 'a.txt', 'alpha') }] }, { max_tasks: 5, check_allowlist: ['node'] });
  assert.equal(v.ok, false);
});

test('review: worktreeRemove refuses any path outside <repo>-aos-worktrees/ (no recursive delete elsewhere)', async () => {
  const sb = mkSandbox();
  try {
    const victim = path.join(sb.root, 'victim'); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, 'keep.txt'), 'x');
    await assert.rejects(GIT.worktreeRemove(sb.repo, victim), /refusing/);
    await assert.rejects(GIT.worktreeRemove(sb.repo, path.join(`${sb.repo}-aos-worktrees`, '..')), /refusing/);
    assert.ok(fs.existsSync(path.join(victim, 'keep.txt')));
    assert.ok(GIT.isUnderWorktreeRoot(sb.repo, path.join(`${sb.repo}-aos-worktrees`, 'g', 't1')));
    assert.ok(!GIT.isUnderWorktreeRoot(sb.repo, `${sb.repo}-aos-worktrees`));
    assert.ok(!GIT.isUnderWorktreeRoot(sb.repo, `${sb.repo}-aos-worktrees-evil/x`));
  } finally { sb.cleanup(); }
});

test('prompts: worker told to use Write/Edit not shell redirects; planner told commands are read-only; Write/Edit are granted tools', () => {
  const task = { id: 't1', title: 'T', acceptance: ['a.txt has alpha'], orch: { description: 'd', path_scope: ['a.txt'], allowed_commands: ['cat a.txt'], checks: [] } };
  const p = buildWorkerPrompt({ goal: { title: 'G' }, task });
  assert.match(p, /ONLY with the Write and Edit tools/); assert.match(p, /never with shell redirects/); assert.equal(p.split('ONLY with the Write and Edit tools').length, 2);
  assert.match(WORKER_RULES, /Write and Edit tools/);
  const args = buildArgs({ prompt: 'x', tier: 'haiku', sessionId: 's', settingsFile: '/s.json' });
  assert.match(args[args.indexOf('--tools') + 1], /Write/); assert.match(args[args.indexOf('--tools') + 1], /Edit/);
  const g = { title: 'G', success_criteria: [{ id: 'c1', text: 'x' }], orch: { budgets: { max_tasks: 3 }, check_allowlist: [] } };
  assert.match(buildPlannerPrompt({ goal: g }).prompt, /ONLY for read-only inspection\. Creating or editing files needs NO command/);
});

// ---- real (scrubbed) samples: test/fixtures/*.real.ndjson came from this machine's transcripts / orch worker streams; *.inferred.* were NOT observed
const fx = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8').trim().split('\n')[0]);
const tailOf = (...names) => { const f = path.join(os.tmpdir(), `aos-fx-${process.pid}-${Math.random().toString(36).slice(2)}.ndjson`); fs.writeFileSync(f, names.map((n) => JSON.stringify(fx(n))).join('\n') + '\n'); const t = new StreamTail(f); t.update(); fs.rmSync(f); return t; };

test('real fixtures: epoch seconds (not ms) in resetsAt; allowed event, session/weekly rejections parse structurally', () => {
  const ok = parseRateLimitEvent(fx('rate-limit-event-allowed.real.ndjson'));
  assert.equal(ok.status, 'allowed'); assert.equal(ok.type, 'five_hour'); assert.equal(ok.resets_at_ms, 1792527600000); assert.equal(new Date(ok.resets_at_ms).toISOString(), '2026-10-20T20:20:00.000Z');
  assert.equal(ok.five_hour.utilization, 0.06); assert.equal(ok.seven_day.resets_at_ms, 1792569600000);
  assert.equal(epochToMs(1792527600), 1792527600000); assert.equal(epochToMs(1792527600000), 1792527600000, 'ms passes through'); assert.equal(epochToMs(null), null); assert.equal(epochToMs('x'), null);
  const wk = parseRateLimitEvent(fx('api-error-weekly-limit.real.ndjson')); // "resets Oct 21 at 9am (Europe/London)" = 08:00Z
  assert.equal(wk.status, 'rejected'); assert.equal(wk.type, 'seven_day'); assert.equal(new Date(wk.resets_at_ms).toISOString(), '2026-10-21T08:00:00.000Z');
  assert.equal(parseRateLimitEvent(fx('api-error-auth.real.ndjson')), null);
});

test('real fixtures: StreamTail captures the api-error message; detection distinguishes 5h / 7d / auth without any text match', () => {
  const five = tailOf('api-error-session-limit.real.ndjson'), week = tailOf('api-error-weekly-limit.real.ndjson'), auth = tailOf('api-error-auth.real.ndjson');
  assert.equal(five.apiError.apiError, 'usage_limit_reached'); assert.equal(five.takeRateLimits().length, 1); assert.equal(auth.takeRateLimits().length, 0);
  const noText = { is_error: true, result: '' }; // text deliberately absent: structure alone must decide
  let d = detectLimitFailure(noText, '', {}, { rateLimit: five.lastRateLimit, apiError: { ...five.apiError, text: '' } });
  assert.deepEqual([d.limited, d.certain, d.kind], [true, true, 'five_hour']);
  d = detectLimitFailure(noText, '', {}, { rateLimit: week.lastRateLimit, apiError: { ...week.apiError, text: '' } });
  assert.deepEqual([d.limited, d.certain, d.kind], [true, true, 'seven_day']);
  d = detectLimitFailure(null, '', {}, { apiError: auth.apiError });
  assert.deepEqual([d.limited, d.auth, d.kind], [false, true, 'auth']);
});

test('detection: 529 is overloaded (not a plan limit), 401 is auth, text fallback matches the REAL wording and is uncertain', () => {
  let d = detectLimitFailure(fx('result-overloaded-529.inferred.ndjson'));
  assert.deepEqual([d.limited, d.overloaded, d.certain], [false, true, true]);
  d = detectLimitFailure({ is_error: true, result: 'x', api_error_status: 401 }); assert.deepEqual([d.limited, d.auth], [false, true]);
  d = detectLimitFailure({ is_error: true, result: 'API Error: Overloaded' }); assert.deepEqual([d.overloaded, d.certain, d.limited], [true, false, false]);
  d = detectLimitFailure(fx('result-limit-429.inferred.ndjson')); assert.deepEqual([d.limited, d.certain, d.kind], [true, true, 'five_hour']);
  for (const [txt, kind] of [["You've hit your session limit · resets 4:50pm (Europe/London)", 'five_hour'], ["You've hit your weekly limit · resets Oct 21 at 9am (Europe/London)", 'seven_day']]) {
    d = detectLimitFailure({ is_error: true, result: txt }); assert.deepEqual([d.limited, d.certain, d.kind], [true, false, kind], txt);
  }
  assert.equal(detectLimitFailure({ is_error: true, result: 'tests failed after 3 resets 4 times', usage: { output_tokens: 3 } }).limited, false, 'bare "resets <digit>" no longer matches');
  assert.equal(detectLimitFailure({ is_error: true, result: 'boom', api_error_status: 500, usage: {} }).limited, false, '5xx without 429/limit text is a plain error');
  d = detectLimitFailure(null, "You've hit your session limit", {}); assert.deepEqual([d.limited, d.certain], [true, false]);
});

test('detection: text fallback never matches worker-authored text or errors[] (S2 false positives); API-error-shaped results still match', () => {
  const fp = [
    { is_error: true, subtype: 'error_max_turns', result: 'Implemented the rate limit middleware', usage: { output_tokens: 900 }, num_turns: 30 },
    { is_error: true, subtype: 'error_max_turns', result: 'Implemented the rate limit middleware' },
    { is_error: true, subtype: 'error_during_execution', result: '', errors: ['ENOENT: rate_limit.json'], usage: { output_tokens: 40 } },
    { is_error: true, subtype: 'error_during_execution', result: '', errors: ['ENOENT: rate_limit.json'] },
    { is_error: true, result: 'Too many requests handled; usage limit reached in the docs', usage: { input_tokens: 5, output_tokens: 77 } },
  ];
  for (const r of fp) { const d = detectLimitFailure(r, '', {}); assert.deepEqual([d.limited, d.overloaded, d.auth], [false, false, false], JSON.stringify(r)); }
  // shaped like an API error: still detected (uncertain)
  for (const r of [{ is_error: true, result: "You've hit your session limit · resets 4:50pm" }, { is_error: true, result: "You've hit your weekly limit", usage: { output_tokens: 0 } },
    { is_error: true, result: "You've hit your session limit", model: '<synthetic>', usage: { output_tokens: 12 } }]) { const d = detectLimitFailure(r); assert.deepEqual([d.limited, d.certain], [true, false], JSON.stringify(r)); }
  assert.equal(detectLimitFailure({ is_error: true, result: 'x', usage: { output_tokens: 9 } }, '', {}, { apiError: { text: "You've hit your session limit" } }).limited, true, 'an api-error message makes it shaped');
});

test('governor: overloaded backs off 30 s -> 60 -> 120 -> 300 s and never shortens or replaces a longer plan pause; healthy event resets the ladder', () => {
  const dir = tmp();
  try {
    const NOW = 1_800_000_000_000; const gov = new Governor(dir); const secs = [];
    for (let i = 0; i < 5; i++) { const st = gov.noteOverloaded(NOW); secs.push((st.pause.until_ms - NOW) / 1000); gov.evaluate(st.pause.until_ms + 1); }
    assert.deepEqual(secs, [30, 60, 120, 300, 300]);
    gov.observe(info({ status: 'allowed' }), NOW); assert.equal(gov.load().overload_level, 0);
    gov.noteLimitFailure(NOW, 'weekly', NOW / 1000 + 86400); const until = gov.load().pause.until_ms; // seconds are normalised
    assert.equal(until, NOW + 86400_000 + 60_000);
    gov.noteOverloaded(NOW); assert.equal(gov.load().pause.until_ms, until);
    assert.equal(gov.noteLimitFailure(NOW, 'x', until + 1e6).pause.until_ms > until, true, 'ms input also accepted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
