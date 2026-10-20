#!/usr/bin/env node
// fake-claude: a scripted stand-in for the `claude` CLI (subset used by the AOS orchestrator).
// Output shapes follow orchestrator/spike/README.md and the raw spike outputs. See test/README.md.
// Zero dependencies, Node 18+. Never contacts any network or the real claude binary.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const FAKE_VERSION = '2.1.303 (Claude Code)'; // version string of the CLI the spike used

// ---------------------------------------------------------------- CLI parsing
const ALIASES = { 'allowed-tools': 'allowedTools', 'disallowed-tools': 'disallowedTools' };
const SHORT = { p: 'print', r: 'resume', n: 'name', d: 'debug', w: 'worktree', c: 'continue', v: 'version', h: 'help' };
const VALUE = new Set(['model', 'output-format', 'input-format', 'max-turns', 'max-budget-usd', 'permission-mode',
  'settings', 'setting-sources', 'append-system-prompt', 'system-prompt', 'session-id', 'json-schema', 'fallback-model',
  'permission-prompts', 'plugin-dir', 'agent', 'agents', 'effort', 'name', 'debug-file', 'system-prompt-snapshot',
  'append-system-prompt-file', 'system-prompt-file', 'plugin-url', 'environment']);
const VARIADIC = new Set(['add-dir', 'allowedTools', 'disallowedTools', 'mcp-config', 'tools', 'file', 'betas']);
const OPTIONAL = new Set(['resume', 'debug', 'worktree', 'from-pr', 'cloud', 'prompt-suggestions', 'remote-control']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cliError(msg) { process.stderr.write(msg + '\n', () => process.exit(1)); return new Promise(() => {}); }

function parseArgs(argv) {
  const opts = {}; const pos = []; const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-') { pos.push(a); continue; }
    let name; let inline;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      name = eq > 0 ? a.slice(2, eq) : a.slice(2); inline = eq > 0 ? a.slice(eq + 1) : undefined;
      name = ALIASES[name] || name;
    } else {
      name = SHORT[a[1]]; if (!name) { unknown.push(a); continue; }
      if (a.length > 2) inline = a.slice(2);
    }
    if (VALUE.has(name)) {
      let v = inline;
      if (v === undefined) { if (i + 1 >= argv.length) return { error: `error: option '--${name} <value>' argument missing` }; v = argv[++i]; }
      opts[name] = v;
    } else if (VARIADIC.has(name)) {
      const vals = inline !== undefined ? [inline] : [];
      while (inline === undefined && i + 1 < argv.length && !argv[i + 1].startsWith('-')) vals.push(argv[++i]);
      if (!vals.length) return { error: `error: option '--${name} <values...>' argument missing` };
      opts[name] = (opts[name] || []).concat(vals);
    } else if (OPTIONAL.has(name)) {
      if (inline !== undefined) opts[name] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) opts[name] = argv[++i];
      else opts[name] = true;
    } else {
      opts[name] = inline !== undefined ? inline : true; // known or unknown boolean flag: accepted and ignored
      if (!['print', 'verbose', 'version', 'help', 'strict-mcp-config', 'include-partial-messages', 'include-hook-events',
        'no-session-persistence', 'continue', 'bare', 'safe-mode', 'restricted', 'dangerously-skip-permissions',
        'allow-dangerously-skip-permissions', 'fork-session', 'disable-slash-commands', 'replay-user-messages',
        'brief', 'chrome', 'no-chrome', 'ide'].includes(name)) unknown.push(a);
    }
  }
  return { opts, pos, unknown };
}

function validate(o) {
  const choice = (flag, v, allowed) => (v !== undefined && !allowed.includes(v))
    ? `error: option '--${flag} <value>' argument '${v}' is invalid. Allowed choices are ${allowed.join(', ')}.` : null;
  const e = choice('output-format', o['output-format'], ['text', 'json', 'stream-json'])
    || choice('input-format', o['input-format'], ['text', 'stream-json'])
    || choice('permission-mode', o['permission-mode'], ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'manual', 'dontAsk', 'plan'])
    || choice('permission-prompts', o['permission-prompts'], ['host', 'none']);
  if (e) return e;
  if (o['max-turns'] !== undefined && !/^[1-9]\d*$/.test(o['max-turns'])) return `error: --max-turns must be a positive integer, got '${o['max-turns']}'`;
  if (o['max-budget-usd'] !== undefined && !(Number(o['max-budget-usd']) > 0)) return `error: --max-budget-usd must be a positive number, got '${o['max-budget-usd']}'`;
  if (o['session-id'] !== undefined && !UUID_RE.test(o['session-id'])) return 'Error: Invalid session ID. Must be a valid UUID.';
  if (o['setting-sources'] !== undefined) {
    const bad = o['setting-sources'].split(',').map((s) => s.trim()).filter((s) => s && !['user', 'project', 'local'].includes(s));
    if (bad.length) return `Error processing --setting-sources: Invalid setting source: ${bad[0]}. Valid options are: user, project, local`;
  }
  if (o['output-format'] === 'stream-json' && o.print && !o.verbose) return 'Error: When using --print, --output-format=stream-json requires --verbose';
  return null;
}

// ------------------------------------------------------------------ utilities
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const split = (n, parts) => { const base = Math.floor(n / parts); const out = Array(parts).fill(base); out[parts - 1] += n - base * parts; return out; };
const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }; // opus/sonnet ids synthetic
const PRICE = { in: 1, out: 5, cr: 0.1, cc: 1.25 }; // USD per Mtok, notional list-style price
const DEFAULT_USAGE = { input_tokens: 6, output_tokens: 500, cache_read_input_tokens: 14000, cache_creation_input_tokens: 4000 };
const costOf = (u) => (u.input_tokens * PRICE.in + u.output_tokens * PRICE.out + u.cache_read_input_tokens * PRICE.cr
  + u.cache_creation_input_tokens * PRICE.cc) / 1e6;
const normUsage = (u) => ({ ...DEFAULT_USAGE, ...(u || {}) });

let outputMode = 'text';
function emit(obj) { if (outputMode === 'stream-json') process.stdout.write(JSON.stringify(obj) + '\n'); }
function flushExit(code) { process.stdout.write('', () => process.stderr.write('', () => process.exit(code))); return new Promise(() => {}); }

const liveChildren = new Set();

// ---------------------------------------------------------------------- hooks
function loadSettings(arg) {
  if (!arg) return null;
  try {
    const raw = arg.trim().startsWith('{') ? arg : fs.readFileSync(arg, 'utf8');
    return JSON.parse(raw);
  } catch (e) { return { __error: `Error: Invalid settings (--settings ${arg.slice(0, 80)}): ${e.message}` }; }
}

function hooksFor(settings, event, toolName) {
  const groups = (settings && settings.hooks && settings.hooks[event]) || [];
  const out = [];
  for (const g of groups) {
    const m = g.matcher;
    let ok = !m || m === '*';
    if (!ok && toolName !== undefined) { try { ok = new RegExp(`^(?:${m})$`).test(toolName); } catch { ok = false; } }
    if (ok) for (const h of g.hooks || []) if (h && h.type === 'command' && h.command) out.push(h);
  }
  return out;
}

function runHookCommand(h, payload, cwd) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', h.command], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'pipe'] });
    liveChildren.add(child);
    let out = ''; let err = ''; let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); liveChildren.delete(child); resolve(r); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ timedOut: true, out, err }); }, (h.timeout || 60) * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => {});
    child.on('error', (e) => finish({ code: 127, out, err: String(e) }));
    child.on('close', (code) => finish({ code, out, err }));
    child.stdin.end(JSON.stringify(payload));
  });
}

// returns {kind:'deny'|'allow'|'none', reason}
function interpret(event, tool, h, r) {
  if (r.timedOut) return { kind: 'none', note: 'timeout' };
  if (r.code === 2) return { kind: 'deny', reason: `${event}:${tool} hook error: [${h.command}]: ${r.err.trim()}` };
  if (r.code !== 0) return { kind: 'none', note: `exit ${r.code}` };
  let j; try { j = JSON.parse(r.out); } catch { return { kind: 'none' }; }
  const s = j.hookSpecificOutput || {};
  if (event === 'PreToolUse') {
    if (s.permissionDecision === 'deny') return { kind: 'deny', reason: `${event}:${tool} hook error: ${s.permissionDecisionReason || 'denied by hook'}` };
    if (s.permissionDecision === 'allow') return { kind: 'allow' };
    if (j.decision === 'block') return { kind: 'deny', reason: `${event}:${tool} hook error: ${j.reason || 'blocked by hook'}` };
    if (j.decision === 'approve') return { kind: 'allow' };
  } else if (event === 'PermissionRequest') {
    const d = s.decision || {};
    if (d.behavior === 'deny') return { kind: 'deny', reason: d.message || 'Permission denied by hook' };
    if (d.behavior === 'allow') return { kind: 'allow' };
  }
  return { kind: 'none' };
}

// ----------------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (parsed.error) return cliError(parsed.error);
  const { opts, pos, unknown } = parsed;
  if (opts.version) { process.stdout.write(FAKE_VERSION + '\n'); return; }
  if (opts.help) { process.stdout.write('Usage: claude [options] [command] [prompt]\n\n(fake-claude: see orchestrator/test/README.md)\n'); return; }
  const bad = validate(opts);
  if (bad) return cliError(bad);
  if (!opts.print) return cliError('fake-claude: only --print (-p) mode is supported');

  let prompt = pos.join(' ');
  if (!prompt) {
    if (process.stdin.isTTY) return cliError('Error: Input must be provided either through stdin or as a prompt argument when using --print');
    prompt = fs.readFileSync(0, 'utf8');
    if (!prompt.trim()) return cliError('Error: Input must be provided either through stdin or as a prompt argument when using --print');
  }
  outputMode = opts['output-format'] || 'text';

  // ---- scenario
  const scenPath = process.env.AOS_FAKE_SCENARIO;
  if (!scenPath) return fail2('fake-claude: AOS_FAKE_SCENARIO is not set (path to a scenario JSON file)');
  let scenario;
  try { scenario = JSON.parse(fs.readFileSync(scenPath, 'utf8')); } catch (e) {
    return fail2(e.code ? `fake-claude: cannot read scenario file ${scenPath}: ${e.code} ${e.message}`
      : `fake-claude: scenario file ${scenPath} is not valid JSON: ${e.message}`);
  }
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) return fail2(`fake-claude: scenario file ${scenPath} must contain a JSON object`);

  const cwd = process.cwd();
  const stateDir = process.env.AOS_FAKE_STATE || null;
  const taskId = process.env.AOS_TASK_ID || '';
  const isPlanner = prompt.includes('AOS_PLANNER');
  const isReview = !isPlanner && prompt.includes('AOS_REVIEW'); // advisory reviewer: scenario.review is a Step; `review: <string>` is the returned text
  const isDraft = !isPlanner && !isReview && prompt.includes('AOS_DRAFT'); // `aos-orch draft`: one no-tools call; scenario.draft is a Step or a list of Steps (one per call)
  const counterKey = isPlanner ? '_planner' : isReview ? '_review' : isDraft ? '_draft' : (taskId || '_none');
  const { step, source, attempt } = pickStep(scenario, taskId, prompt, isPlanner, counterKey, stateDir, isDraft, isReview);
  const BEHAVIORS = ['success', 'fail_checks', 'error', 'rate_limit', 'budget_exceeded', 'denied_tool', 'crash', 'hang', 'slow'];
  const behavior = step.behavior || 'success';
  if (!BEHAVIORS.includes(behavior)) return fail2(`fake-claude: unknown behavior '${behavior}' in scenario ${scenPath} (${source}); expected one of ${BEHAVIORS.join(', ')}`);

  const settings = loadSettings(opts.settings);
  if (settings && settings.__error) return cliError(settings.__error);

  const sessionId = opts['session-id'] || (typeof opts.resume === 'string' ? opts.resume : uuid());
  const modelArg = opts.model || 'sonnet';
  const model = MODELS[modelArg] || modelArg;
  const maxBudget = opts['max-budget-usd'] !== undefined ? Number(opts['max-budget-usd']) : null;
  const permissionMode = opts['permission-mode'] || 'default';
  const t0 = Date.now();

  appendJsonl(stateDir && path.join(stateDir, 'invocations.ndjson'), {
    ts: new Date().toISOString(), pid: process.pid, task_id: taskId || null, attempt, source, behavior, session_id: sessionId,
    cwd, model: modelArg, argv, prompt, planner: isPlanner,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('AOS_'))),
  });

  // ---- plan the turns, usage and cost
  const toolCalls = buildToolCalls(step);
  const usage = normUsage(step.usage);
  const totalCost = typeof step.cost_usd === 'number' ? step.cost_usd : costOf(usage);
  const turns = (behavior === 'hang' || behavior === 'crash') ? 1 : Math.max(1, Number.isInteger(step.turns) ? step.turns : toolCalls.length + 1);
  const shares = {
    input_tokens: split(usage.input_tokens, turns), output_tokens: split(usage.output_tokens, turns),
    cache_read_input_tokens: split(usage.cache_read_input_tokens, turns), cache_creation_input_tokens: split(usage.cache_creation_input_tokens, turns),
  };
  const costShare = Array(turns).fill(totalCost / turns);
  const cum = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost: 0, turnsStarted: 0 };
  const msgIds = Array.from({ length: turns }, () => 'msg_' + crypto.randomBytes(12).toString('hex'));
  const startTurn = (t) => {
    while (cum.turnsStarted <= t && cum.turnsStarted < turns) {
      const i = cum.turnsStarted++;
      for (const k of Object.keys(shares)) cum[k] += shares[k][i];
      cum.cost += costShare[i];
    }
  };
  const turnUsage = (t) => ({ input_tokens: shares.input_tokens[t], cache_creation_input_tokens: shares.cache_creation_input_tokens[t],
    cache_read_input_tokens: shares.cache_read_input_tokens[t], output_tokens: shares.output_tokens[t],
    service_tier: 'standard', inference_geo: 'global', speed: 'standard' });
  const assistant = (t, content) => { startTurn(t); emit({ type: 'assistant', message: { model, id: msgIds[t], type: 'message', role: 'assistant', content, stop_reason: null, usage: turnUsage(t) },
    parent_tool_use_id: null, session_id: sessionId, uuid: uuid() }); afterAssistant(); };

  let rlEmitted = false;
  const emitRateLimit = (forceRejected) => {
    if (rlEmitted) return; rlEmitted = true;
    emit({ type: 'rate_limit_event', rate_limit_info: rateLimitInfo(step.rate_limit || {}, forceRejected), uuid: uuid(), session_id: sessionId });
  };
  const afterAssistant = () => { if (behavior !== 'rate_limit') emitRateLimit(false); };

  // ---- transcript + signals
  const transcript = stateDir ? path.join(stateDir, `${sessionId}.transcript.jsonl`) : null;
  const writeCostState = () => {
    appendJsonl(transcript, { type: 'cost-state', sessionId, modelUsage: { [model]: {
      inputTokens: cum.input_tokens, outputTokens: cum.output_tokens, cacheReadInputTokens: cum.cache_read_input_tokens,
      cacheCreationInputTokens: cum.cache_creation_input_tokens, costUSD: cum.cost } }, totalCostUSD: cum.cost });
  };
  const onTerm = (code) => () => {
    if (step.ignore_sigterm) return;
    for (const c of liveChildren) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    writeCostState();
    process.exit(code); // real CLI: exit 143, no further stdout
  };
  process.on('SIGTERM', onTerm(143));
  process.on('SIGINT', onTerm(130));

  // ---- session start
  const basePayload = (event, extra) => ({ session_id: sessionId, transcript_path: transcript || '', cwd, permission_mode: permissionMode, hook_event_name: event, ...extra });
  for (const h of hooksFor(settings, 'SessionStart')) {
    const hookId = uuid();
    emit({ type: 'system', subtype: 'hook_started', hook_id: hookId, hook_name: 'SessionStart:startup', hook_event: 'SessionStart', uuid: uuid(), session_id: sessionId });
    const r = await runHookCommand(h, { ...basePayload('SessionStart'), source: 'startup' }, cwd);
    emit({ type: 'system', subtype: 'hook_response', hook_id: hookId, hook_name: 'SessionStart:startup', hook_event: 'SessionStart', output: r.out || '',
      stdout: r.out || '', stderr: r.err || '', exit_code: r.code ?? null, outcome: r.code === 0 ? 'success' : 'error', uuid: uuid(), session_id: sessionId });
  }
  const availableTools = opts.tools ? opts.tools.flatMap((t) => t.split(',')).map((s) => s.trim()).filter(Boolean)
    : ['Task', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Skill', 'ToolSearch', 'Write'];
  emit({ type: 'system', subtype: 'init', cwd, session_id: sessionId, tools: availableTools, mcp_servers: [], model, permissionMode,
    slash_commands: [], apiKeySource: 'none', claude_code_version: FAKE_VERSION.split(' ')[0], output_style: 'default', agents: [], skills: [],
    plugins: [], uuid: uuid(), memory_paths: { auto: cwd } });

  if (step.delay_ms) await sleep(step.delay_ms);

  // ---- behaviors without tool execution
  const denials = [];
  const finish = async (res, exitCode) => {
    if (res.subtype === 'success' && !res.is_error) for (const h of hooksFor(settings, 'Stop')) await runHookCommand(h, basePayload('Stop', { stop_hook_active: false }), cwd);
    writeCostState();
    if (outputMode === 'stream-json' || outputMode === 'json') process.stdout.write(JSON.stringify(res) + '\n');
    else process.stdout.write((res.result ?? (res.errors || []).join('\n')) + '\n');
    return flushExit(exitCode);
  };
  const mkResult = (over) => buildResult({ sessionId, model, usage: { ...usage }, cost: totalCost, turns, denials, durationMs: Date.now() - t0, ...over });

  if (behavior === 'rate_limit') {
    const text = step.message || '5-hour limit reached ∙ resets 3pm'; // UNVERIFIED text
    if (!step.no_event) emitRateLimit(true); // no_event: e.g. 529 overloaded, which carries no rate_limit_event
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    return finish(mkResult({ subtype: 'success', is_error: true, result: text, usage: step.usage ? usage : zero, cost: step.usage ? totalCost : 0, turns: 1,
      apiErrorStatus: step.api_error_status === undefined ? 429 : step.api_error_status, terminalReason: 'completed' }), 1);
  }
  if (behavior === 'error') {
    await runTools(toolCalls, toolCalls.length);
    startTurn(turns - 1);
    emitRateLimit(false);
    return finish(mkResult({ subtype: 'error_during_execution', is_error: true, errors: [step.message || 'Simulated execution error'], terminalReason: 'error' }), 1);
  }

  // ---- behaviors with tool execution
  const edited = await runTools(toolCalls, behavior === 'crash' ? Math.ceil(toolCalls.length / 2) : toolCalls.length);
  if (behavior === 'crash') { startTurn(0); assistant(0, [{ type: 'text', text: 'Working on it...' }]); return flushExit(137); }
  if (behavior === 'hang') {
    startTurn(0);
    assistant(0, [{ type: 'text', text: 'Working on it...' }]);
    setInterval(() => {}, 1 << 30);
    return new Promise(() => {});
  }
  for (const d of step.permission_denials || []) {
    const id = 'toolu_' + crypto.randomBytes(12).toString('hex');
    denials.push({ tool_name: d.tool_name, tool_use_id: id, tool_input: d.tool_input || {} });
    const reason = d.reason || 'AOS policy: not in the task allowlist; approval required.';
    emit({ type: 'system', subtype: 'permission_denied', tool_name: d.tool_name, tool_use_id: id, decision_reason_type: 'hook', decision_reason: reason, message: reason, uuid: uuid(), session_id: sessionId });
  }
  if (step.commit === true && edited) gitCommit(cwd, step.commit_message || `fake-claude: ${taskId || 'task'} attempt ${attempt + 1}`);

  startTurn(turns - 1);
  const finalText = step.message || (denials.length ? 'Some tool calls were denied, so I stopped and report what I needed.\n\nPINEAPPLE' : 'Task completed as scripted.');
  const planText = isReview && step.review !== undefined ? String(step.review) : isPlanner && step.plan !== undefined ? formatPlan(step) : isDraft && step.draft !== undefined ? formatPlan({ plan: step.draft, plan_format: step.plan_format }) : null;
  assistant(turns - 1, [{ type: 'text', text: planText ?? finalText }]);
  emitRateLimit(false);

  if (behavior === 'budget_exceeded' || (maxBudget !== null && totalCost > maxBudget)) {
    const capText = maxBudget !== null ? maxBudget : (step.max_budget_usd ?? 0.0005);
    return finish(mkResult({ subtype: 'error_max_budget_usd', is_error: true, errors: [`Reached maximum budget ($${capText})`],
      terminalReason: 'budget_exhausted', stopReason: 'tool_use', noResultText: true }), 1);
  }
  const extra = {};
  if (isPlanner && step.plan !== undefined && opts['json-schema']) extra.structuredOutput = step.plan; // UNVERIFIED field name
  return finish(mkResult({ subtype: 'success', is_error: false, result: planText ?? finalText, terminalReason: 'completed', ...extra }), 0);

  // ----------------------------------------------------------------- tool run
  async function runTools(calls, limit) {
    let applied = false;
    for (let i = 0; i < Math.min(limit, calls.length); i++) {
      const c = calls[i];
      const t = Math.min(i, turns - 1);
      const toolUseId = 'toolu_' + crypto.randomBytes(12).toString('hex');
      assistant(t, [{ type: 'tool_use', id: toolUseId, name: c.tool, input: c.input, caller: { type: 'direct' } }]);
      const verdict = await decide(c, toolUseId);
      if (verdict.deny) {
        denials.push({ tool_name: c.tool, tool_use_id: toolUseId, tool_input: c.input });
        emit({ type: 'system', subtype: 'permission_denied', tool_name: c.tool, tool_use_id: toolUseId, decision_reason_type: 'hook',
          decision_reason: verdict.reason, message: verdict.reason, uuid: uuid(), session_id: sessionId });
        userResult(toolUseId, verdict.reason, true);
        continue;
      }
      if (verdict.unavailable) { userResult(toolUseId, `Error: No such tool available: ${c.tool}`, true); continue; }
      const text = await apply(c);
      applied = applied || c.kind === 'edit';
      userResult(toolUseId, text, false);
      for (const h of hooksFor(settings, 'PostToolUse', c.tool)) await runHookCommand(h, basePayload('PostToolUse', { tool_name: c.tool, tool_input: c.input, tool_response: { ok: true }, tool_use_id: toolUseId }), cwd);
    }
    return applied;
  }
  function userResult(id, content, isError) {
    emit({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: isError }] },
      parent_tool_use_id: null, session_id: sessionId, uuid: uuid(), timestamp: new Date().toISOString() });
  }
  async function decide(c, toolUseId) {
    if (!availableTools.includes(c.tool)) return { unavailable: true };
    const disallowed = (opts.disallowedTools || []).flatMap((x) => x.split(',')).map((s) => s.trim());
    if (disallowed.some((r) => ruleMatches(r, c))) return { deny: true, reason: `Permission to use ${c.tool} has been denied.` };
    const payload = basePayload('PreToolUse', { tool_name: c.tool, tool_input: c.input, tool_use_id: toolUseId });
    let explicitAllow = false;
    for (const h of hooksFor(settings, 'PreToolUse', c.tool)) {
      const d = interpret('PreToolUse', c.tool, h, await runHookCommand(h, payload, cwd));
      if (d.kind === 'deny') return { deny: true, reason: d.reason };
      if (d.kind === 'allow') explicitAllow = true;
    }
    const allowed = (opts.allowedTools || []).flatMap((x) => x.split(',')).map((s) => s.trim());
    const skipPrompt = explicitAllow || ['bypassPermissions', 'dontAsk'].includes(permissionMode) || allowed.some((r) => ruleMatches(r, c));
    if (!skipPrompt) {
      const prHooks = hooksFor(settings, 'PermissionRequest', c.tool);
      if (prHooks.length) {
        const pp = { ...payload, hook_event_name: 'PermissionRequest' };
        let verdict = null;
        for (const h of prHooks) {
          const d = interpret('PermissionRequest', c.tool, h, await runHookCommand(h, pp, cwd));
          if (d.kind === 'deny') return { deny: true, reason: d.reason };
          if (d.kind === 'allow') { verdict = d; break; }
        }
        if (!verdict) return { deny: true, reason: `${c.tool} needs approval; no hook decision and headless mode auto-denies.` };
      } else if (scenario.strict_permissions) {
        return { deny: true, reason: `${c.tool} needs approval and none is available in headless mode.` };
      }
    }
    return {};
  }
  async function apply(c) {
    if (c.kind === 'edit') {
      const abs = path.resolve(cwd, c.input.file_path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const existed = fs.existsSync(abs);
      if (c.append) fs.appendFileSync(abs, c.input.content); else fs.writeFileSync(abs, c.input.content);
      return existed ? `The file ${abs} has been updated successfully.` : `File created successfully at: ${abs}`;
    }
    if (c.run) {
      const r = spawnSync('/bin/sh', ['-c', c.input.command], { cwd, encoding: 'utf8', timeout: 60000 });
      return (r.stdout || '') + (r.stderr || '') || '(Bash completed with no output)';
    }
    return '(Bash completed with no output)';
  }
}

function fail2(msg) { process.stderr.write(msg + '\n', () => process.exit(2)); return new Promise(() => {}); }

function appendJsonl(file, obj) { if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch { /* best effort */ } }

function buildToolCalls(step) {
  const calls = [];
  for (const e of step.edits || []) {
    calls.push({ kind: 'edit', tool: e.tool || (e.append ? 'Edit' : 'Write'), append: !!e.append,
      input: { file_path: path.resolve(process.cwd(), e.path), content: String(e.content ?? '') } });
  }
  for (const c of step.commands || []) {
    const cmd = typeof c === 'string' ? { command: c } : c;
    calls.push({ kind: 'bash', tool: 'Bash', run: !!cmd.run, input: { command: cmd.command, description: cmd.description || 'Run command' } });
  }
  return calls;
}

function ruleMatches(rule, c) {
  const m = /^([A-Za-z_*][\w*]*)(?:\((.*)\))?$/.exec(rule);
  if (!m) return false;
  if (m[1] !== c.tool) return false;
  if (m[2] === undefined) return true;
  const subject = c.tool === 'Bash' ? c.input.command : c.input.file_path;
  if (m[2].endsWith(':*')) return subject.startsWith(m[2].slice(0, -2));
  return subject === m[2];
}

function pickStep(scenario, taskId, prompt, isPlanner, counterKey, stateDir, isDraft = false, isReview = false) {
  let list; let source;
  if (isReview) { list = scenario.review || [{}]; source = 'review'; } else if (isPlanner && scenario.planner) { list = [scenario.planner]; source = 'planner'; }
  else if (isDraft && scenario.draft) { list = scenario.draft; source = 'draft'; }
  else {
    const tasks = scenario.tasks || {};
    if (taskId && Object.prototype.hasOwnProperty.call(tasks, taskId)) { list = tasks[taskId]; source = `tasks.${taskId}`; }
    else {
      for (const [k, v] of Object.entries(tasks)) {
        let re; try { re = new RegExp(k); } catch { continue; }
        if ((taskId && re.test(taskId)) || re.test(prompt)) { list = v; source = `tasks[/${k}/]`; break; }
      }
    }
    if (!list) { list = [scenario.default || {}]; source = 'default'; }
  }
  if (!Array.isArray(list)) list = [list];
  if (!list.length) list = [{}];
  let n = 0;
  if (stateDir) {
    const f = path.join(stateDir, 'counts', counterKey.replace(/[^\w.-]/g, '_'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, 'x\n'); // O_APPEND: one line per invocation
    n = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length - 1;
  }
  return { step: list[Math.min(n, list.length - 1)] || {}, source: `${source}[${Math.min(n, list.length - 1)}]`, attempt: n };
}

function formatPlan(step) {
  const json = typeof step.plan === 'string' ? step.plan : JSON.stringify(step.plan);
  if (step.plan_format === 'fenced') return '```json\n' + json + '\n```';
  if (step.plan_format === 'prose') return 'Here is the plan:\n\n' + json + '\n\nLet me know if you want changes.';
  return json;
}

function rateLimitInfo(rl, forceRejected) {
  const now = Math.floor(Date.now() / 1000);
  const fh = rl.five_hour_utilization ?? (forceRejected ? 1.0 : 0.14);
  const sd = rl.seven_day_utilization ?? 0.3;
  const fhReset = rl.five_hour_resets_at ?? now + 3 * 3600;
  const sdReset = rl.seven_day_resets_at ?? now + 3 * 86400;
  const type = fh >= sd ? 'five_hour' : 'seven_day';
  const util = Math.max(fh, sd);
  const status = rl.status || (util >= 1 ? 'rejected' : util >= 0.75 ? 'allowed_warning' : 'allowed');
  const info = { status, resetsAt: type === 'five_hour' ? fhReset : sdReset, rateLimitType: type, utilization: util,
    overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false };
  if (status === 'allowed_warning') info.surpassedThreshold = 0.75;
  info.unifiedWindows = { five_hour: { utilization: fh, resetsAt: fhReset }, seven_day: { utilization: sd, resetsAt: sdReset } };
  info.overageEnabled = false;
  return info;
}

function buildResult(o) {
  const u = o.usage;
  const r = {
    type: 'result', subtype: o.subtype, is_error: o.is_error,
    duration_ms: o.durationMs, duration_api_ms: 0, num_turns: o.turns, ...(o.noResultText || o.result === undefined ? {} : { result: o.result }),
    stop_reason: o.stopReason || 'end_turn', session_id: o.sessionId, total_cost_usd: o.cost,
    usage: { input_tokens: u.input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens, cache_read_input_tokens: u.cache_read_input_tokens,
      output_tokens: u.output_tokens, output_tokens_details: { thinking_tokens: 0 }, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard', cache_creation: { ephemeral_1h_input_tokens: u.cache_creation_input_tokens, ephemeral_5m_input_tokens: 0 },
      inference_geo: 'global', iterations: [], speed: 'standard', fallback_credit: null },
    modelUsage: { [o.model]: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadInputTokens: u.cache_read_input_tokens,
      cacheCreationInputTokens: u.cache_creation_input_tokens, webSearchRequests: 0, costUSD: o.cost, contextWindow: 1000000, maxOutputTokens: 128000,
      thinkingTokens: 0, canonicalModel: o.model, provider: 'firstParty', costBasis: 'list' } },
    permission_denials: o.denials, terminal_reason: o.terminalReason || 'completed',
    api_error_status: o.apiErrorStatus === undefined ? null : o.apiErrorStatus, uuid: uuid(),
  };
  if (o.errors) r.errors = o.errors;
  if (o.structuredOutput !== undefined) r.structured_output = o.structuredOutput;
  return r;
}

function gitCommit(cwd, msg) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'fake-claude', GIT_AUTHOR_EMAIL: 'fake-claude@example.invalid',
    GIT_COMMITTER_NAME: 'fake-claude', GIT_COMMITTER_EMAIL: 'fake-claude@example.invalid' };
  const add = spawnSync('git', ['add', '-A'], { cwd, env, encoding: 'utf8' });
  const com = spawnSync('git', ['commit', '-q', '-m', msg], { cwd, env, encoding: 'utf8' });
  if (add.status !== 0 || com.status !== 0) process.stderr.write(`fake-claude: git commit failed: ${(add.stderr || '') + (com.stderr || '') + (com.stdout || '')}\n`);
}

main().catch((e) => { process.stderr.write(`fake-claude: internal error: ${e.stack}\n`, () => process.exit(70)); });
