#!/usr/bin/env node
// aos-orch: minimal CLI for the AOS orchestrator engine (phase 1, headless, no HTTP server).
//   aos-orch run <goal.json | goal-id> [--auto-approve] [--trust-repo-config] [--unsandboxed-checks] [--sandbox-workers] [--poll-ms N] [--interval-s N]
//   aos-orch status [goal-id]
//   aos-orch pause|resume|cancel|kill|approve-plan|reject-plan <goal-id>
//   aos-orch serve [--port 4319] [--max-workers N] [--dashboard-url URL] [--origins a,b] [--leave-workers|--kill-workers] [--drain-s N]
//   aos-orch login-link [--port N] | token [--show] | goals [--json]
//   aos-orch approvals <goal-id> | approve <goal-id> <A-n> [--for-task] | deny <goal-id> <A-n>
// State lives under AOS_ORCH_DIR (default ${CLAUDE_PLUGIN_DATA or ~/.claude/plugins/data/aos-dashboard-aos-local}/orch).
// The real `claude` binary is used only when AOS_CLAUDE_BIN is unset.
import fs from 'node:fs';
import path from 'node:path';
import { Engine, createGoal, summarize, assertRepoTrusted } from '../lib/engine.mjs';
import { reviewView, renderReview, planHash, tasksHash } from '../lib/plan.mjs';
import { rulesFingerprint } from '../lib/rules.mjs';
import { orchRoot, goalDirOf, goalsRoot, paths, readJSON, loadState, loadHeartbeat, enqueueCommand, pidAlive, ensureDir, lockStatus, describeOwner } from '../lib/state.mjs';
import { listApprovals, decide } from '../lib/approvals.mjs';
import { Supervisor } from '../lib/supervisor.mjs';
import { createControlServer, parsePort, DEFAULT_PORT } from '../server/index.mjs';
import { ensureCliToken, readCliToken, createLoginCode } from '../server/auth.mjs';

const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); if (['poll-ms', 'interval-s', 'orch-dir', 'port', 'max-workers', 'dashboard-url', 'origins', 'drain-s'].includes(k)) flags[k] = argv[++i]; else flags[k] = true; } else pos.push(a);
}
const [cmd, arg1, arg2] = pos;
const orch = flags['orch-dir'] ? path.resolve(flags['orch-dir']) : orchRoot();
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const die = (m, code = 1) => { console.error(`aos-orch: ${m}`); process.exit(code); };

function resolveGoalDir(id) {
  if (!id) die('goal id required');
  const d = goalDirOf(orch, id);
  if (!fs.existsSync(paths(d).goal)) die(`no such goal: ${id} (looked in ${goalsRoot(orch)})`);
  return d;
}
const engineAlive = (dir) => { const l = readJSON(paths(dir).lock, null); return !!l && pidAlive(l.pid); };

async function main() {
  ensureDir(orch);
  switch (cmd) {
    case 'run': {
      if (!arg1) die('usage: aos-orch run <goal.json | goal-id>');
      let dir;
      if (fs.existsSync(arg1) && fs.statSync(arg1).isFile()) {
        const spec = JSON.parse(fs.readFileSync(arg1, 'utf8'));
        if (flags['trust-repo-config']) spec.orch = { ...(spec.orch || {}), trust_repo_config: true };
        if (flags['unsandboxed-checks']) spec.orch = { ...(spec.orch || {}), unsandboxed_checks: true };
        if (flags['sandbox-workers']) spec.orch = { ...(spec.orch || {}), sandbox_workers: true };
        if (flags['auto-approve']) spec.orch = { ...(spec.orch || {}), approval_policy: { ...(spec.orch?.approval_policy || {}), plan: 'auto' } };
        const id = spec.id && fs.existsSync(paths(goalDirOf(orch, spec.id)).goal) ? spec.id : null;
        if (id) dir = goalDirOf(orch, id); else { const made = await createGoal(orch, spec); dir = made.dir; for (const n of made.notices) console.error(`aos-orch: ${n}`); }
      } else dir = resolveGoalDir(arg1);
      assertRepoTrusted(readJSON(paths(dir).goal));
      const eng = new Engine({ goalDir: dir, orchDir: orch, intervalMs: flags['interval-s'] ? Number(flags['interval-s']) * 1000 : 10000 });
      const onSig = async () => { console.error('aos-orch: signal received; releasing the lock (workers keep running and are re-adopted by the next run)'); await eng.stop(); process.exit(130); };
      process.on('SIGINT', onSig); process.on('SIGTERM', onSig);
      let last = '';
      const timer = setInterval(() => { const s = eng.summary(); const line = `${s.status} tasks=${JSON.stringify(s.tasks)} tokens=${s.usage.new_tokens}${s.paused_reason ? ` paused: ${s.paused_reason}` : ''}`; if (line !== last) { console.error(line); last = line; } }, 1000);
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
      } finally { clearInterval(timer); await eng.stop(); }
      const s = eng.summary();
      out({ goal: s.id, status, plan_state: s.plan_state, blocked_reason: s.blocked_reason, report: fs.existsSync(paths(dir).report) ? paths(dir).report : null, dir });
      process.exit(status === 'achieved' ? 0 : status === 'cancelled' ? 3 : s.plan_state === 'awaiting_approval' ? 4 : 2);
      break;
    }
    case 'status': {
      if (!arg1) {
        let ids = []; try { ids = fs.readdirSync(goalsRoot(orch)); } catch { /* none */ }
        out(ids.map((id) => { const S = loadState(goalDirOf(orch, id)); return S.goal ? { id, status: S.goal.status, title: S.goal.title, engine: engineAlive(goalDirOf(orch, id)) } : null; }).filter(Boolean));
      } else {
        const d = resolveGoalDir(arg1); const S = loadState(d);
        out({ ...summarize(S, loadHeartbeat(d)), engine_running: engineAlive(d), engine: describeOwner(lockStatus(d)), governor: readJSON(path.join(orch, 'governor.json'), null) });
        if (S.tasks.length) console.error(`\nPLAN FOR REVIEW (exact commands, model tier and path scope per task):\n${renderReview(reviewView(S.tasks))}`);
      }
      break;
    }
    case 'pause': case 'resume': case 'cancel': case 'kill': case 'approve-plan': case 'reject-plan': {
      const d = resolveGoalDir(arg1);
      let extra = {};
      if (cmd === 'approve-plan') { // approve exactly what is shown here: the engine refuses if the plan differs from this hash
        const S = loadState(d);
        if (!S.tasks.length) die('there is no plan to approve yet');
        console.error(`PLAN YOU ARE APPROVING (commands run as you, checks inside the OS sandbox):\n${renderReview(reviewView(S.tasks))}`);
        const rules_hash = rulesFingerprint(S.goal, readJSON(paths(d).rules, null));
        extra = { reviewed: { plan_hash: planHash(readJSON(paths(d).plan)?.plan ?? null), tasks_hash: tasksHash(S.tasks), ...(rules_hash ? { rules_hash } : {}) } };
        console.error(`plan hash ${extra.reviewed.plan_hash.slice(0, 12)}${rules_hash ? `  rules hash ${rules_hash.slice(0, 12)}` : ''}`);
      }
      enqueueCommand(d, { cmd, by: 'cli', ...extra });
      const st = lockStatus(d);
      if (!st.owner_alive) out(`${cmd}: queued, but no engine is running for this goal; it applies on the next \`aos-orch run ${arg1}\` (or when \`aos-orch serve\` is started)`);
      else {
        out(`${cmd}: queued; the running engine applies it at its next tick (${describeOwner(st)})`);
        if (st.wedged) console.error(`aos-orch: WARNING the owning engine looks wedged; this command will not be applied until it is restarted (kill ${st.owner_pid}).`);
      }
      break;
    }
    case 'approvals': {
      { const S = loadState(resolveGoalDir(arg1)); if (S.tasks.length) console.error(`PLAN (exact commands, model tier and path scope per task):\n${renderReview(reviewView(S.tasks))}\n`); }
      out(listApprovals(paths(resolveGoalDir(arg1)).approvals).map((a) => ({ id: a.id, task: a.task_id, tool: a.tool, status: a.status, reason: a.reason, expires_at: a.expires_at, input: a.tool === 'Bash' ? a.input?.command : a.input?.file_path, cwd: a.cwd ?? null }))); break; }
    case 'approve': case 'deny': {
      const d = resolveGoalDir(arg1); if (!arg2) die(`usage: aos-orch ${cmd} <goal-id> <A-n>`);
      out(decide(paths(d).approvals, arg2, { decision: cmd, scope: flags['for-task'] ? 'task' : 'once', by: 'cli' }));
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
      const ids = fs.existsSync(goalsRoot(orch)) ? fs.readdirSync(goalsRoot(orch)) : [];
      const rows = ids.map((id) => { const S = loadState(goalDirOf(orch, id)); return S.goal ? { id, status: S.goal.status, plan_state: S.goal.orch.plan_state, tasks: `${S.tasks.filter((t) => t.status === 'done').length}/${S.tasks.length}`, engine: engineAlive(goalDirOf(orch, id)), title: S.goal.title } : null; }).filter(Boolean);
      if (flags.json) out(rows); else out(rows.length ? rows.map((r) => `${r.id}  ${r.status}${r.status === 'draft' ? `/${r.plan_state}` : ''}  tasks ${r.tasks}  ${r.engine ? 'engine' : '-'}  ${r.title}`).join('\n') : '(no goals)');
      break;
    }
    default:
      die('usage: aos-orch run|serve|login-link|token|goals|status|pause|resume|cancel|kill|approve-plan|reject-plan|approvals|approve|deny ...', 64);
  }
}
main().catch((e) => die(e.message));
