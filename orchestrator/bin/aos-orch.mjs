#!/usr/bin/env node
// aos-orch: CLI for the AOS orchestrator engine (`aos-orch --help` lists every command).
//   aos-orch run <goal.json | goal-id> [--no-wait] [--auto-approve] [--trust-repo-config] [--unsandboxed-checks] [--sandbox-workers|--no-sandbox-workers] [--replan] [--poll-ms N] [--interval-s N]
//   aos-orch doctor [--live]
//   aos-orch status [goal-id]
//   aos-orch plan <goal-id>            (read-only: the plan review and rules summary, approves nothing)
//   aos-orch pause|resume|cancel|kill|approve-plan|reject-plan <goal-id>
//   aos-orch serve [--port 4319] [--max-workers N] [--dashboard-url URL] [--origins a,b] [--leave-workers|--kill-workers] [--drain-s N]
//   aos-orch login-link [--port N] | token [--show] | goals [--json]
//   aos-orch draft "<prompt>" --repo <path> [--out goal.json] [--profile strict|node-library|docs-only] [--answers "..."] [--branch main] [--max-tokens N] [--max-wall-s N] [--tier haiku|sonnet|opus]
//   aos-orch archive <goal-id>... | --blocked | --achieved | --older-than <days> [--dry-run] | unarchive <goal-id> | goals --all
//   aos-orch confirm <goal-id> <criterion-id>
//   aos-orch verify --repo <path> [--base main] [--check "node --test"]... [--tree <commit>] [--profile name] [--json] [--unsandboxed-checks]
//   aos-orch rules show [goal-id] | rules check <file> [--layer user|repo|goal] | rules explain <goal-id> <task-id> '<tool json>'
//   aos-orch approvals <goal-id> | approve <goal-id> <A-n> [--for-task] | deny <goal-id> <A-n>
// State lives under AOS_ORCH_DIR (default ~/.aos/orch, or $XDG_STATE_HOME/aos/orch; an existing ~/.claude/plugins/data/aos-dashboard-aos-local/orch is still used when ~/.aos/orch does not exist).
// The real `claude` binary is used only when AOS_CLAUDE_BIN is unset.
import fs from 'node:fs';
import path from 'node:path';
import { Engine, createGoal, summarize, assertRepoTrusted } from '../lib/engine.mjs';
import { reviewView, renderReview, planHash, tasksHashFor, tasksHashV } from '../lib/plan.mjs';
import { rulesFingerprint } from '../lib/rules.mjs';
import { renderRulesFor, readRulesSummary, renderUserRules, checkRulesFile, explainCall } from '../lib/rules-store.mjs';
import { q, escCtrl, escBeyondC0 } from '../lib/ctrl.mjs';
import { draftGoal, renderDraft, PROFILES } from '../lib/draft.mjs';
import { orchLocation, goalDirOf, goalsRoot, paths, readJSON, loadState, loadHeartbeat, enqueueCommand, pidAlive, ensureDir, lockStatus, describeOwner, attachedFile, attachedPid } from '../lib/state.mjs';
import { selectGoals, moveGoals, archiveRoot, GID_RE } from '../lib/archive.mjs';
import { listApprovals, decide } from '../lib/approvals.mjs';
import { workerSandboxAvailable } from '../lib/sandbox.mjs';
import { Supervisor } from '../lib/supervisor.mjs';
import { createControlServer, parsePort, DEFAULT_PORT } from '../server/index.mjs';
import { ensureCliToken, readCliToken, createLoginCode } from '../server/auth.mjs';

const USAGE = `usage: aos-orch <command> ...   (node orchestrator/bin/aos-orch.mjs when not on your PATH; \`npm link\` installs \`aos-orch\`)
  draft "<prompt>" --repo <path>   write a goal.json from a sentence (one small model call; review it)
        [--out goal.json] [--profile strict|node-library|docs-only] [--answers "..."] [--branch main] [--max-tokens N] [--max-wall-s N] [--tier haiku|sonnet|opus]
  run <goal.json|goal-id>          plan and run a goal. Stays attached and waits for your approvals (plan, human-verified criteria)
        [--no-wait] [--auto-approve] [--trust-repo-config] [--unsandboxed-checks] [--sandbox-workers|--no-sandbox-workers] [--accept-repo-loosening ids] [--replan] [--poll-ms N] [--interval-s N]
                                   --sandbox-workers is the default on macOS; --no-sandbox-workers opts out (warned)
                                   --replan: ask the planner again for a goal blocked at planning
                                   --no-wait: exit at the first approval gate (code 4 for a plan), as before
  status [goal-id] | goals [--json] [--all]   list goals / show one (--all: include archived)
  archive <goal-id>... | --blocked | --achieved | --older-than <days> [--dry-run]   move finished goals to <state>/archive/goals/ (never deletes; refuses live/active goals)
  unarchive <goal-id>              move an archived goal back
  plan <goal-id>                   read-only plan review; approve-plan | reject-plan <goal-id> decide it
  pause | resume | cancel | kill <goal-id>
  approvals <goal-id> | approve <goal-id> <A-n> [--for-task] | deny <goal-id> <A-n>   answer a worker permission request
  confirm <goal-id> <criterion-id> sign off a human-verified criterion
  rules show [goal-id] | rules check <file> [--layer user|repo|goal] | rules explain <goal-id> <task-id> '<tool json>'
  verify --repo <path>             guard mode: judge any agent's finished work without orchestration (anti-cheat diff, sandboxed checks,
        [--base main] [--check "node --test"]... [--tree <commit>] [--profile node-library|strict|docs-only] [--json] [--unsandboxed-checks]
                                   ORIGINAL tests re-run) against the base commit. Default check: the profile's test command. Exit 0 accepted, 1 rejected
  doctor [--live]                  preflight: node, git, claude version/flags/login, sandbox, state dir, port (--live: one tiny Haiku call)
  serve [--port 4319] [--max-workers N] [--dashboard-url URL] [--origins a,b] [--leave-workers|--kill-workers] [--drain-s N]
  login-link [--port N] | token [--show]   control server for the dashboard (127.0.0.1:4319)
  help, --help, -h                 this text
State lives in $AOS_ORCH_DIR (default ~/.aos/orch; the old dashboard-plugin folder is used if it exists and ~/.aos/orch does not). Docs: orchestrator/README.md`;
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') { console.log(USAGE); process.exit(0); }
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--check') { (flags.check ||= []).push(argv[++i]); continue; } // repeatable (verify)
  if (a.startsWith('--')) { const k = a.slice(2); if (['base', 'tree', 'poll-ms', 'interval-s', 'orch-dir', 'port', 'max-workers', 'dashboard-url', 'origins', 'drain-s', 'accept-repo-loosening', 'layer', 'repo', 'out', 'profile', 'answers', 'branch', 'max-tokens', 'max-wall-s', 'tier', 'older-than'].includes(k)) flags[k] = argv[++i]; else flags[k] = true; } else pos.push(a);
}
const [cmd, arg1, arg2] = pos;
const loc = flags['orch-dir'] ? { dir: path.resolve(flags['orch-dir']), legacy: false } : orchLocation();
const orch = loc.dir;
if (loc.legacy) { // at most once a day (or with --verbose): it is a notice, not a warning
  const mark = path.join(orch, '.legacy-dir-notice'); const today = new Date().toISOString().slice(0, 10);
  let seen = null; try { seen = fs.readFileSync(mark, 'utf8').trim(); } catch { /* first time */ }
  if (flags.verbose || seen !== today) {
    console.error(`aos-orch: using the existing state in ${orch} (the new default is ${loc.fresh}; move the folder there, or set AOS_ORCH_DIR, to silence this)`);
    try { fs.writeFileSync(mark, `${today}\n`, { mode: 0o600 }); } catch { /* read-only: shown again next time */ }
  }
}

// worker- and model-controlled strings reach the terminal: JSON output escapes what JSON.stringify leaves raw (C1, bidi, invisible characters), text output escapes every control character
const out = (o) => console.log(typeof o === 'string' ? escCtrl(o).replace(/\\u000a/g, '\n') : JSON.stringify(o, (k, v) => (typeof v === 'string' ? escBeyondC0(v) : v), 2));
const die = (m, code = 1) => { console.error(`aos-orch: ${m}`); process.exit(code); };

function resolveGoalDir(id) {
  if (!id) die('goal id required');
  const d = goalDirOf(orch, id);
  if (!fs.existsSync(paths(d).goal)) die(`no such goal: ${id} (looked in ${goalsRoot(orch)})`);
  return d;
}
/** The rules summary the approval screens print (null before the goal's first tick; a tampered snapshot is shown as such). */
const rulesSummaryOf = (dir, goal) => renderRulesFor(dir, goal);
/** The plan review text: tasks (with the self-check note when the goal's rules turn it on) + the rules summary. */
const reviewText = (dir, S) => renderReview(reviewView(S.tasks, S.goal), rulesSummaryOf(dir, S.goal), { selfCheck: readRulesSummary(dir, S.goal)?.worker?.self_check === true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The exact next human command when `run` stops waiting on a human (plan approval, or a verify:"human" criterion). */
function nextSteps(id, s) {
  if (s.plan_state === 'awaiting_approval') return [`the plan is waiting for YOU. Review it:   aos-orch plan ${id}`, `then approve it:       aos-orch approve-plan ${id}   (or reject-plan)`, `then continue:         aos-orch run ${id}   (not needed while an attached run is waiting: it continues by itself)`];
  const m = /^awaiting human confirmation: (.+)$/.exec(String(s.blocked_reason || ''));
  if (m) return [`the goal is waiting for YOUR confirmation of: ${m[1]}`, ...m[1].split(',').map((c) => c.trim()).filter((c) => /^[a-z][a-z0-9_-]{0,31}$/.test(c)).map((c) => `confirm it (only if true): aos-orch confirm ${id} ${c}`), `then continue:         aos-orch run ${id}`];
  return [];
}
/** The live attached \`run\` that will apply a queued command, or null. */
function attachedRun(dir) {
  const st = lockStatus(dir);
  if (st.owner_alive && st.owner_label === 'run' && !st.wedged) return st.owner_pid;
  return attachedPid(dir);
}
const engineAlive = (dir) => { const l = readJSON(paths(dir).lock, null); return !!l && pidAlive(l.pid); };

/** One engine run for a goal directory until it ends or stops for a human. Exits the process on a locked goal. */
async function driveOnce(dir) {
  const eng = new Engine({ goalDir: dir, orchDir: orch, intervalMs: flags['interval-s'] ? Number(flags['interval-s']) * 1000 : 10000 });
  const onSig = async () => { console.error('aos-orch: signal received; releasing the lock (workers keep running and are re-adopted by the next run)'); await eng.stop(); process.exit(130); };
  process.on('SIGINT', onSig); process.on('SIGTERM', onSig);
  let last = '';
  const timer = setInterval(() => { const s = eng.summary(); if (!Object.keys(s.tasks || {}).length) return; /* no plan yet: nothing to count */ const line = `${s.status} tasks=${JSON.stringify(s.tasks)} tokens=${s.usage.new_tokens}${s.paused_reason ? ` paused: ${s.paused_reason}` : ''}`; if (line !== last) { console.error(line); last = line; } }, 1000);
  let status;
  try { status = await eng.run({ pollMs: Number(flags['poll-ms']) || eng.intervalMs }); } catch (e) {
    if (e.code !== 'LOCKED') throw e;
    clearInterval(timer);
    const st = e.lock;
    console.error(`aos-orch: ${e.message}`);
    console.error(st.wedged ? `aos-orch: the owner is alive but not applying commands. Stop it (kill ${st.owner_pid}) and run again; its workers are re-adopted.`
      : st.owner_label === 'serve' ? 'aos-orch: the running `aos-orch serve` already drives this goal: use `aos-orch approve-plan|pause|... <goal-id>` or the dashboard instead of `run`.'
        : 'aos-orch: another engine is driving this goal; stop it first, or use `aos-orch approve-plan|pause|... <goal-id>` to talk to it.');
    process.exit(5);
  } finally { clearInterval(timer); await eng.stop(); process.off('SIGINT', onSig); process.off('SIGTERM', onSig); }
  return { status, s: eng.summary() };
}

/** The worker OS sandbox is the DEFAULT on macOS (opt out: --no-sandbox-workers or orch.sandbox_workers: false, both warned loudly).
 *  Linux and others: off (unsupported there; it fails closed when asked for), with a notice that checks stay sandboxed. */
function workerSandboxDefault(specValue, f, platform = process.platform) {
  if (platform === 'darwin') {
    if (f['no-sandbox-workers'] || specValue === false) {
      console.error(`aos-orch: WARNING: worker OS sandbox DISABLED (${f['no-sandbox-workers'] ? '--no-sandbox-workers' : 'orch.sandbox_workers: false'}): the worker \`claude\` processes run unsandboxed, constrained only by the policy hook. Checks and self-checks stay sandboxed.`);
      return false;
    }
    console.error('aos-orch: workers run inside the macOS sandbox (sandbox-exec; the default on macOS, --no-sandbox-workers to opt out)');
    return true;
  }
  if (specValue !== true) console.error(`aos-orch: notice: the worker OS sandbox is not supported on ${platform === 'linux' ? 'Linux' : platform}: workers run unsandboxed (policy hook only); acceptance checks and self-checks still run in the OS check sandbox${platform === 'linux' ? ' (bubblewrap)' : ''}`);
  return specValue === true;
}

/** `run goal.json` on an existing goal: the stored orch.sandbox_workers decides (flags only apply when a goal is created). */
function reportStoredWorkerSandbox(stored, f) {
  if (stored) console.error('aos-orch: workers run inside the macOS sandbox (sandbox-exec; this goal was created with sandbox_workers on)');
  else console.error('aos-orch: WARNING: this goal\'s workers run UNSANDBOXED (stored orch.sandbox_workers is not true), constrained only by the policy hook. Checks and self-checks stay sandboxed.');
  if (f['sandbox-workers'] && !stored) console.error('aos-orch: WARNING: --sandbox-workers is ignored for an existing goal: it was created without the worker sandbox');
  if (f['no-sandbox-workers'] && stored) console.error('aos-orch: WARNING: --no-sandbox-workers is ignored for an existing goal: it was created with the worker sandbox on');
}

async function main() {
  ensureDir(orch);
  switch (cmd) {
    case 'run': {
      if (!arg1) die('usage: aos-orch run <goal.json | goal-id> [--no-wait]');
      let dir;
      if (fs.existsSync(arg1) && fs.statSync(arg1).isFile()) {
        const spec = JSON.parse(fs.readFileSync(arg1, 'utf8'));
        if (spec._partial) die(`${arg1} is an INCOMPLETE draft (_partial): fix its _errors, then delete the keys starting with "_" before running it`, 64);
        if (flags['trust-repo-config']) spec.orch = { ...(spec.orch || {}), trust_repo_config: true };
        if (flags['unsandboxed-checks']) spec.orch = { ...(spec.orch || {}), unsandboxed_checks: true };
        if (flags['sandbox-workers'] && flags['no-sandbox-workers']) die('--sandbox-workers and --no-sandbox-workers contradict each other', 64);
        if (flags['sandbox-workers'] && process.platform !== 'darwin') die(`--sandbox-workers: ${workerSandboxAvailable().reason}`);
        const id = spec.id && fs.existsSync(paths(goalDirOf(orch, spec.id)).goal) ? spec.id : null;
        // an EXISTING goal keeps the sandbox_workers it was created with: report that stored value, never what this invocation's flags would have chosen
        if (id) reportStoredWorkerSandbox(readJSON(paths(goalDirOf(orch, id)).goal).orch?.sandbox_workers === true, flags);
        else spec.orch = { ...(spec.orch || {}), sandbox_workers: workerSandboxDefault(spec.orch?.sandbox_workers, flags) };
        if (typeof flags['accept-repo-loosening'] === 'string') spec.orch = { ...(spec.orch || {}), accept_repo_loosening: flags['accept-repo-loosening'].split(',').map((x) => x.trim()).filter(Boolean) };
        if (flags['auto-approve']) spec.orch = { ...(spec.orch || {}), approval_policy: { ...(spec.orch?.approval_policy || {}), plan: 'auto' } };
        if (id) dir = goalDirOf(orch, id); else { const made = await createGoal(orch, spec); dir = made.dir; for (const n of made.notices) console.error(`aos-orch: ${n}`); }
      } else dir = resolveGoalDir(arg1);
      assertRepoTrusted(readJSON(paths(dir).goal));
      const id = readJSON(paths(dir).goal).id;
      { // a goal blocked at planning (plan rejected by the validator or by a human) never re-plans by itself: say so, and re-plan on request
        const g0 = readJSON(paths(dir).goal);
        if (g0.status === 'blocked' && g0.orch.plan_state === 'rejected') {
          if (flags.replan) { enqueueCommand(dir, { cmd: 'replan', by: 'cli' }); console.error(`aos-orch: ${id} was blocked at planning (${escCtrl(String(g0.blocked_reason || '').slice(0, 300))}); asking the planner again (--replan)`); }
          else console.error(`aos-orch: ${id} is blocked at planning: ${escCtrl(String(g0.blocked_reason || '').slice(0, 300))}\naos-orch: nothing will change by itself. To ask the planner again (it is told what was wrong):  aos-orch run ${id} --replan`);
        }
      }
      const waiting = (s) => s.plan_state === 'awaiting_approval' || /^awaiting human confirmation/.test(String(s.blocked_reason || ''));
      let { status, s } = await driveOnce(dir);
      // default: stay attached (--no-wait exits at the gate instead) while a human decides. The engine is only run again once a command (approve-plan, confirm, ...) has been queued by the human's own CLI call;
      // it applies that command itself, so nothing proceeds without it.
      while (!flags['no-wait'] && waiting(s) && status !== 'cancelled') {
        if (s.plan_state === 'awaiting_approval') { const S = loadState(dir); console.error(`PLAN FOR REVIEW:\n${reviewText(dir, S)}\n`); }
        for (const l of nextSteps(id, s)) console.error(`aos-orch: ${l}`);
        console.error('aos-orch: waiting for your command (Ctrl-C to stop; nothing runs until you give it)...');
        const mark = () => { try { fs.writeFileSync(attachedFile(dir), JSON.stringify({ pid: process.pid, ts: Date.now() })); } catch { /* best effort */ } };
        while (!(fs.existsSync(paths(dir).commands) && fs.readdirSync(paths(dir).commands).some((n) => n.endsWith('.json')))) {
          if (!fs.existsSync(paths(dir).goal)) { console.error(`aos-orch: goal ${id} was moved away (archived?) while this run was waiting; stopping. Unarchive it and run again to continue.`); process.exit(0); }
          mark(); await sleep(500);
        }
        mark();
        ({ status, s } = await driveOnce(dir));
      }
      try { fs.unlinkSync(attachedFile(dir)); } catch { /* none */ }
      out({ goal: s.id, status, plan_state: s.plan_state, blocked_reason: s.blocked_reason, report: fs.existsSync(paths(dir).report) ? paths(dir).report : null, dir });
      if (waiting(s)) for (const l of nextSteps(id, s)) console.error(`aos-orch: ${l}`);
      process.exit(status === 'achieved' ? 0 : status === 'cancelled' ? 3 : s.plan_state === 'awaiting_approval' ? 4 : 2);
      break;
    }
    case 'plan': { // read-only: prints exactly what approve-plan would show, queues nothing
      const d = resolveGoalDir(arg1); const S = loadState(d);
      if (!S.tasks.length) { console.error(`aos-orch: ${arg1} has no plan yet (state: ${S.goal.orch.plan_state}). \`aos-orch run ${arg1}\` asks the planner for one and stops for your approval.`); process.exit(2); }
      console.log(`PLAN FOR REVIEW (read-only; nothing is approved by looking). Goal ${escCtrl(S.goal.id)}: ${escCtrl(S.goal.title)}  [${S.goal.status}/${S.goal.orch.plan_state}]`);
      console.log(reviewText(d, S));
      if (S.goal.orch.plan_state === 'awaiting_approval') console.log(`\nTo approve exactly this:  aos-orch approve-plan ${arg1}   (then \`aos-orch run ${arg1}\`)\nTo reject:                 aos-orch reject-plan ${arg1}`);
      break;
    }
    case 'status': {
      if (!arg1) {
        let ids = []; try { ids = fs.readdirSync(goalsRoot(orch)); } catch { /* none */ }
        out(ids.map((id) => { const S = loadState(goalDirOf(orch, id)); return S.goal ? { id, status: S.goal.status, title: S.goal.title, engine: engineAlive(goalDirOf(orch, id)) } : null; }).filter(Boolean));
      } else {
        const d = resolveGoalDir(arg1); const S = loadState(d);
        const sm = summarize(S, loadHeartbeat(d)); const att = attachedRun(d);
        const parkedForHuman = S.goal.orch?.plan_state === 'awaiting_approval' || /^awaiting human confirmation/.test(String(S.goal.blocked_reason || ''));
        if (att && !['achieved', 'failed', 'cancelled'].includes(S.goal.status) && (sm.heartbeat.status === 'stopped' || parkedForHuman)) sm.heartbeat = { ...sm.heartbeat, status: `waiting (attached run pid ${att})` }; // parked at plan approval / human confirm: the run is alive, the engine just holds no lock
        out({ ...sm, engine_running: engineAlive(d), engine: describeOwner(lockStatus(d)), governor: readJSON(path.join(orch, 'governor.json'), null) });
        if (S.tasks.length) console.error(`\nPLAN FOR REVIEW (exact commands, model tier and path scope per task):\n${reviewText(d, S)}`);
      }
      break;
    }
    case 'pause': case 'resume': case 'cancel': case 'kill': case 'approve-plan': case 'reject-plan': {
      const d = resolveGoalDir(arg1);
      let extra = {};
      if (cmd === 'approve-plan' && typeof flags['accept-repo-loosening'] === 'string') { // accepting changes the rules hash: queue it, then review and approve again
        enqueueCommand(d, { cmd: 'accept-repo-loosening', by: 'cli', ids: flags['accept-repo-loosening'].split(',').map((x) => x.trim()).filter(Boolean) });
        out(`accept-repo-loosening: queued; the engine recompiles the rules and the rules hash changes. Run \`aos-orch status ${arg1}\` to review the new rules, then \`aos-orch approve-plan ${arg1}\` to approve them`);
        break;
      }
      if (cmd === 'approve-plan') { // approve exactly what is shown here: the engine refuses if the plan differs from this hash
        const S = loadState(d);
        if (!S.tasks.length) die('there is no plan to approve yet');
        const rules_hash = rulesFingerprint(S.goal, readJSON(paths(d).rules, null));
        extra = { reviewed: { plan_hash: planHash(readJSON(paths(d).plan)?.plan ?? null), tasks_hash: tasksHashFor(S.goal, S.tasks), ...(rules_hash ? { rules_hash } : {}) } };
        // the plan was reviewed with `aos-orch plan` (or the attached run's screen): confirm WHAT is approved by its hash, without printing it all again
        console.error(`approved: plan ${extra.reviewed.plan_hash.slice(0, 12)}, ${S.tasks.length} task(s)${rules_hash ? `, rules ${rules_hash.slice(0, 12)}` : ''} (the engine refuses it if the plan changed since; \`aos-orch plan ${arg1}\` shows it)`);
        { // what must never be approved unseen is still printed: a tampered rules snapshot, and the rule loosenings this approval accepts
          const rt = rulesSummaryOf(d, S.goal).split('\n'); const i = rt.findIndex((l) => l.startsWith('LOOSENINGS YOU ARE APPROVING'));
          if (rt[0].startsWith('RULES TAMPERED')) console.error(rt[0]);
          if (i >= 0) { const end = rt.findIndex((l, k) => k > i && !l.startsWith('  ')); console.error(rt.slice(i, end < 0 ? undefined : end).join('\n')); }
        }
      }
      enqueueCommand(d, { cmd, by: 'cli', ...extra });
      const st = lockStatus(d); const att = attachedRun(d);
      if (att) out(`${cmd}: queued; the attached run (pid ${att}) will apply it within one tick`);
      else if (!st.owner_alive) out(`${cmd}: queued, but no engine is running for this goal; it applies on the next \`aos-orch run ${arg1}\` (or when \`aos-orch serve\` is started). To continue now: \`aos-orch run ${arg1}\``);
      else {
        out(`${cmd}: queued; the running engine applies it at its next tick (${describeOwner(st)})`);
        if (st.wedged) console.error(`aos-orch: WARNING the owning engine looks wedged; this command will not be applied until it is restarted (kill ${st.owner_pid}).`);
      }
      break;
    }
    case 'approvals': {
      { const d = resolveGoalDir(arg1); const S = loadState(d); if (S.tasks.length) console.error(`PLAN (exact commands, model tier and path scope per task):\n${reviewText(d, S)}\n`); }
      out(listApprovals(paths(resolveGoalDir(arg1)).approvals).map((a) => ({ id: a.id, task: a.task_id, tool: a.tool, status: a.status, reason: a.reason, expires_at: a.expires_at, input: a.tool === 'Bash' ? a.input?.command : a.input?.file_path, cwd: a.cwd ?? null }))); break; }
    case 'approve': case 'deny': {
      const d = resolveGoalDir(arg1); if (!arg2) die(`usage: aos-orch ${cmd} <goal-id> <A-n>`);
      out(decide(paths(d).approvals, arg2, { decision: cmd, scope: flags['for-task'] ? 'task' : 'once', by: 'cli' }));
      break;
    }
    case 'draft': { // one no-tools model call proposes a goal; prints it for review and writes goal.json (0600). Never runs it: `aos-orch run goal.json` is a separate, deliberate step.
      if (!arg1 || typeof flags.repo !== 'string') die('usage: aos-orch draft "<prompt>" --repo <path> [--out goal.json] [--profile strict|node-library|docs-only] [--answers "..."] [--max-tokens N] [--max-wall-s N] [--tier haiku|sonnet|opus]', 64);
      const profile = typeof flags.profile === 'string' ? flags.profile : 'strict';
      if (!Object.hasOwn(PROFILES, profile)) die(`unknown profile ${q(profile.slice(0, 30))}`, 64);
      const out = path.resolve(typeof flags.out === 'string' ? flags.out : 'goal.json');
      if (fs.existsSync(out)) die(`${out} already exists; choose another --out (a draft never overwrites a file)`, 64);
      const request = typeof flags.answers === 'string' ? `${arg1}\n\nAnswers to your questions:\n${flags.answers}` : arg1;
      const overrides = {};
      for (const [f, k] of [['max-tokens', 'max_new_tokens'], ['max-wall-s', 'max_wall_s']]) if (flags[f] !== undefined) { if (!/^[1-9]\d{0,12}$/.test(String(flags[f]))) die(`--${f} must be a positive integer`, 64); overrides[k] = Number(flags[f]); }
      if (flags.tier !== undefined) overrides.tier = String(flags.tier);
      const r = await draftGoal({ orchDir: orch, repo: path.resolve(flags.repo), prompt: request, profile, branch: typeof flags.branch === 'string' ? flags.branch : 'main', overrides });
      console.error(renderDraft(r));
      if (!r.ok && r.partial_spec) { // never a goal: a partial file with the valid parts and the errors, for the human to finish
        const pf = out.replace(/(\.json)?$/, '.partial.json');
        try { fs.writeFileSync(pf, `${JSON.stringify(r.partial_spec, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); console.error(`\nwrote the PARTIAL draft ${pf} (0600; valid parts + the errors; it is not a goal and \`aos-orch run\` refuses it). Fix it by hand.`); } catch (e) { console.error(`\ncould not write ${pf}: ${e.code || e.message}`); }
      }
      if (!r.ok) process.exit(2);
      if (r.questions.length) { console.error('\nThe model could not tell what "done" means. Answer and run again with --answers "..." (at most 2 rounds), or write goal.json by hand.'); process.exit(3); }
      fs.writeFileSync(out, `${JSON.stringify(r.spec, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      console.error(`wrote ${out} (0600). Review and edit it, then: aos-orch run ${out}   (stays attached and waits for you: review with \`aos-orch plan <id>\`, approve with \`aos-orch approve-plan <id>\`)`);
      break;
    }
    case 'confirm': { // a human confirms a verify:"human" criterion once every task is done
      if (!arg1 || !arg2) die('usage: aos-orch confirm <goal-id> <criterion-id>', 64);
      const d = resolveGoalDir(arg1); const S = loadState(d); const c = S.goal.success_criteria.find((x) => x.id === arg2);
      if (!c) die(`no such criterion: ${q(arg2.slice(0, 40))}`, 2);
      if (c.verify !== 'human') die('that criterion is verified by a check, not by a human', 2);
      if (c.met) die('that criterion is already confirmed', 2);
      if (!(S.tasks.length && S.tasks.every((t) => t.status === 'done'))) die('confirm only after every task is done', 2);
      console.error(`CONFIRMING (you are saying this is true): ${q(c.text)}`);
      enqueueCommand(d, { cmd: 'confirm', by: 'cli', criterion: arg2 });
      const att = attachedRun(d);
      out(att ? `confirm: queued; the attached run (pid ${att}) will apply it within one tick` : `confirm: queued; the engine applies it at its next tick${lockStatus(d).owner_alive ? '' : ` (no engine is running: it applies on the next \`aos-orch run ${arg1}\` or when \`aos-orch serve\` is started)`}`);
      break;
    }
    case 'rules': {
      const sub = arg1; const [, , , a3, a4] = pos;
      if (sub === 'show') {
        if (arg2) { const d = resolveGoalDir(arg2); out(renderRulesFor(d, loadState(d).goal)); }
        else { const r = renderUserRules(orch); out(r.text); if (!r.ok) process.exit(2); }
      } else if (sub === 'check') {
        if (!arg2) die('usage: aos-orch rules check <file> [--layer user|repo|goal]');
        const r = checkRulesFile(path.resolve(arg2), typeof flags.layer === 'string' ? flags.layer : 'user');
        if (!r.ok) { console.error(`aos-orch: INVALID:\n  ${r.errors.slice(0, 20).join('\n  ')}`); process.exit(2); }
        out(r.text);
      } else if (sub === 'explain') {
        if (!arg2 || !a3 || !a4) die(`usage: aos-orch rules explain <goal-id> <task-id> '{"tool_name":"Bash","tool_input":{"command":"ls"}}'`);
        const d = resolveGoalDir(arg2); const r = explainCall(d, loadState(d).goal, a3, a4);
        if (!r.ok) die(r.error, 2);
        out(`${r.decision.toUpperCase()}  rule ${q(r.rule_id)}  (layer ${q(r.layer)}, rules ${r.rules_hash})\n  ${q(r.reason)}\n  dry run: nothing was written, no approval was created`);
      } else die('usage: aos-orch rules show [goal-id] | check <file> [--layer L] | explain <goal-id> <task-id> <tool json>', 64);
      break;
    }
    case 'serve': {
      const port = parsePort(flags.port ?? process.env.AOS_ORCH_PORT ?? DEFAULT_PORT);
      const sup = new Supervisor({ orchDir: orch, ...(flags['max-workers'] ? { maxWorkers: Number(flags['max-workers']) } : {}),
        ...(flags['interval-s'] ? { intervalMs: Number(flags['interval-s']) * 1000 } : {}), ...(flags['poll-ms'] ? { pollMs: Number(flags['poll-ms']) } : {}) });
      const origins = (flags.origins || process.env.AOS_ORCH_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
      const srv = createControlServer({ supervisor: sup, port, dashboardUrl: flags['dashboard-url'] || process.env.AOS_DASHBOARD_URL || undefined,
        ...(origins.length ? { allowedOrigins: origins } : {}), log: (m) => console.error(`aos-orch: ${m}`) });
      await sup.start();
      await srv.listen();
      console.error(`aos-orch: control server on http://127.0.0.1:${srv.port} (token file: ${ensureCliToken(orch)}); \`aos-orch login-link\` prints a browser login URL`);
      let stopping = false;
      const down = async (sig) => {
        if (stopping) return; stopping = true;
        console.error(`aos-orch: ${sig}: stop dispatching, ${flags['leave-workers'] ? 'leaving' : flags['kill-workers'] ? 'killing' : 'draining'} workers`);
        await srv.close();
        await sup.stop({ workers: flags['leave-workers'] ? 'leave' : flags['kill-workers'] ? 'kill' : 'drain', drainMs: (Number(flags['drain-s']) || 30) * 1000 });
        process.exit(0);
      };
      process.on('SIGINT', () => down('SIGINT')); process.on('SIGTERM', () => down('SIGTERM'));
      await new Promise(() => {});
      break;
    }
    case 'verify': {
      const { verifyTree, renderVerify, defaultChecks } = await import('../lib/guard.mjs');
      const { parseShell } = await import('../lib/shell.mjs');
      if (typeof flags.repo !== 'string') die('usage: aos-orch verify --repo <path> [--base main] [--check "node --test"]... [--tree <commit>] [--profile name] [--json]', 2);
      const repo = path.resolve(flags.repo); const base = typeof flags.base === 'string' ? flags.base : 'main'; const profile = typeof flags.profile === 'string' ? flags.profile : 'node-library';
      const checks = [];
      for (const s of flags.check || []) {
        const p = typeof s === 'string' ? parseShell(s) : null;
        if (!p || p.commands.length !== 1 || p.commands[0].redirects.length || Object.values(p.flags).some(Boolean)) die(`--check must be one plain command (no pipes, redirects, substitutions): ${q(String(s ?? '').slice(0, 80))}`, 2);
        checks.push({ argv: p.commands[0].argv, timeout_s: 600 });
      }
      if (!checks.length) {
        let d = []; try { d = await defaultChecks(repo, base, profile); } catch (e) { die(e.message, 2); }
        if (!d.length) die(`no test command is derivable from profile ${profile} for this repo: pass --check "<command>"`, 2);
      }
      const r = await verifyTree({ repo, base, tree: typeof flags.tree === 'string' ? flags.tree : null, checks, profile, unsandboxed: !!flags['unsandboxed-checks'] });
      if (flags['unsandboxed-checks']) console.error('aos-orch: WARNING: --unsandboxed-checks: the checks ran agent-written code WITHOUT the OS sandbox');
      out(flags.json ? r : renderVerify(r));
      process.exit(r.accepted ? 0 : 1);
    }
    case 'doctor': { const D = await import('../lib/doctor.mjs'); const rep = await D.runDoctor({ orch, port: parsePort(flags.port ?? process.env.AOS_ORCH_PORT ?? DEFAULT_PORT), live: !!flags.live }); console.log(D.renderDoctor(rep)); process.exit(rep.exitCode); }
    case 'login-link': {
      const port = parsePort(flags.port ?? process.env.AOS_ORCH_PORT ?? DEFAULT_PORT);
      ensureCliToken(orch);
      out(`http://127.0.0.1:${port}/auth/login?code=${createLoginCode(orch)}`);
      console.error('aos-orch: one-time link, valid 2 minutes, opening it does not use it up until the page signs in; sessions last 12 h and end when the server restarts');
      break;
    }
    case 'token': {
      const f = ensureCliToken(orch);
      if (flags.show) out(readCliToken(orch)); else out(f);
      break;
    }
    case 'goals': {
      const row = (root, id, archived) => { const d = path.join(root, id); const S = loadState(d); return S.goal ? { id, status: S.goal.status, plan_state: S.goal.orch.plan_state, tasks: `${S.tasks.filter((t) => t.status === 'done').length}/${S.tasks.length}`, engine: archived ? false : engineAlive(d), title: S.goal.title, ...(archived ? { archived: true } : {}) } : null; };
      const ids = fs.existsSync(goalsRoot(orch)) ? fs.readdirSync(goalsRoot(orch)) : [];
      const rows = ids.map((id) => row(goalsRoot(orch), id, false)).filter(Boolean);
      if (flags.all) { let aids = []; try { aids = fs.readdirSync(archiveRoot(orch)).filter((id) => GID_RE.test(id)); } catch { /* none */ } rows.push(...aids.map((id) => row(archiveRoot(orch), id, true)).filter(Boolean)); }
      if (flags.json) out(rows); else out(rows.length ? rows.map((r) => escCtrl(`${r.id}  ${r.status}${r.status === 'draft' ? `/${r.plan_state}` : ''}  tasks ${r.tasks}  ${r.engine ? 'engine' : '-'}  ${r.title}${r.archived ? '  [archived]' : ''}`)).join('\n') : '(no goals)');
      break;
    }
    case 'archive': case 'unarchive': {
      const to = cmd === 'archive' ? 'archive' : 'goals';
      const olderThanDays = flags['older-than'] != null ? Number(flags['older-than']) : null;
      if (olderThanDays != null && !(olderThanDays >= 0)) die('--older-than needs a number of days');
      const filtered = !!(flags.blocked || flags.achieved || olderThanDays != null);
      if (cmd === 'unarchive' && (filtered || pos.length !== 2)) die('usage: aos-orch unarchive <goal-id>', 2);
      if (cmd === 'archive' && (pos.length > 1) === filtered) die('usage: aos-orch archive <goal-id>... | --blocked | --achieved | --older-than <days>  (ids or filters, not both) [--dry-run]', 2);
      const ids = cmd === 'unarchive' || !filtered ? pos.slice(1) : selectGoals(orch, { blocked: !!flags.blocked, achieved: !!flags.achieved, olderThanDays });
      const res = moveGoals(orch, ids, { to, dryRun: !!flags['dry-run'] });
      for (const r of res) console.log(escCtrl(`${r.action}  ${r.id}${r.reason ? `  (${r.reason})` : ''}`));
      if (!res.length) console.log('(nothing to move)');
      if (res.some((r) => r.action === 'refused')) process.exitCode = 1;
      break;
    }
    default:
      process.stderr.write(`aos-orch: unknown command ${q(String(cmd ?? '').slice(0, 40))}\n${USAGE}\n`);
      process.exit(2);
  }
}
main().catch((e) => die(e.message));
