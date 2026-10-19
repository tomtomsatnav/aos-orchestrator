#!/usr/bin/env node
// aos-orch: minimal CLI for the AOS orchestrator engine (phase 1, headless, no HTTP server).
//   aos-orch run <goal.json | goal-id> [--auto-approve] [--poll-ms N] [--interval-s N]
//   aos-orch status [goal-id]
//   aos-orch pause|resume|cancel|kill|approve-plan|reject-plan <goal-id>
//   aos-orch approvals <goal-id> | approve <goal-id> <A-n> [--for-task] | deny <goal-id> <A-n>
// State lives under AOS_ORCH_DIR (default ${CLAUDE_PLUGIN_DATA or ~/.claude/plugins/data/aos-dashboard-aos-local}/orch).
// The real `claude` binary is used only when AOS_CLAUDE_BIN is unset.
import fs from 'node:fs';
import path from 'node:path';
import { Engine, createGoal, summarize } from '../lib/engine.mjs';
import { orchRoot, goalDirOf, goalsRoot, paths, readJSON, loadState, loadHeartbeat, enqueueCommand, pidAlive, ensureDir } from '../lib/state.mjs';
import { listApprovals, decide } from '../lib/approvals.mjs';

const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); if (['poll-ms', 'interval-s', 'orch-dir'].includes(k)) flags[k] = argv[++i]; else flags[k] = true; } else pos.push(a);
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
        if (flags['auto-approve']) spec.orch = { ...(spec.orch || {}), approval_policy: { ...(spec.orch?.approval_policy || {}), plan: 'auto' } };
        const id = spec.id && fs.existsSync(paths(goalDirOf(orch, spec.id)).goal) ? spec.id : null;
        if (id) dir = goalDirOf(orch, id); else ({ dir } = await createGoal(orch, spec));
      } else dir = resolveGoalDir(arg1);
      const eng = new Engine({ goalDir: dir, orchDir: orch, intervalMs: flags['interval-s'] ? Number(flags['interval-s']) * 1000 : 10000 });
      const onSig = async () => { console.error('aos-orch: signal received; releasing the lock (workers keep running and are re-adopted by the next run)'); await eng.stop(); process.exit(130); };
      process.on('SIGINT', onSig); process.on('SIGTERM', onSig);
      let last = '';
      const timer = setInterval(() => { const s = eng.summary(); const line = `${s.status} tasks=${JSON.stringify(s.tasks)} tokens=${s.usage.new_tokens}${s.paused_reason ? ` paused: ${s.paused_reason}` : ''}`; if (line !== last) { console.error(line); last = line; } }, 1000);
      let status;
      try { status = await eng.run({ pollMs: Number(flags['poll-ms']) || eng.intervalMs }); } finally { clearInterval(timer); await eng.stop(); }
      const s = eng.summary();
      out({ goal: s.id, status, plan_state: s.plan_state, blocked_reason: s.blocked_reason, report: fs.existsSync(paths(dir).report) ? paths(dir).report : null, dir });
      process.exit(status === 'achieved' ? 0 : status === 'cancelled' ? 3 : s.plan_state === 'awaiting_approval' ? 4 : 2);
      break;
    }
    case 'status': {
      if (!arg1) {
        let ids = []; try { ids = fs.readdirSync(goalsRoot(orch)); } catch { /* none */ }
        out(ids.map((id) => { const S = loadState(goalDirOf(orch, id)); return S.goal ? { id, status: S.goal.status, title: S.goal.title, engine: engineAlive(goalDirOf(orch, id)) } : null; }).filter(Boolean));
      } else { const d = resolveGoalDir(arg1); const S = loadState(d); out({ ...summarize(S, loadHeartbeat(d)), engine_running: engineAlive(d), governor: readJSON(path.join(orch, 'governor.json'), null) }); }
      break;
    }
    case 'pause': case 'resume': case 'cancel': case 'kill': case 'approve-plan': case 'reject-plan': {
      const d = resolveGoalDir(arg1);
      enqueueCommand(d, { cmd, by: 'cli' });
      out(engineAlive(d) ? `${cmd}: queued; the running engine applies it at its next tick` : `${cmd}: queued, but no engine is running for this goal; it applies on the next \`aos-orch run ${arg1}\``);
      break;
    }
    case 'approvals': { out(listApprovals(paths(resolveGoalDir(arg1)).approvals).map((a) => ({ id: a.id, task: a.task_id, tool: a.tool, status: a.status, reason: a.reason, expires_at: a.expires_at, input: a.tool === 'Bash' ? a.input?.command : a.input?.file_path }))); break; }
    case 'approve': case 'deny': {
      const d = resolveGoalDir(arg1); if (!arg2) die(`usage: aos-orch ${cmd} <goal-id> <A-n>`);
      out(decide(paths(d).approvals, arg2, { decision: cmd, scope: flags['for-task'] ? 'task' : 'once', by: 'cli' }));
      break;
    }
    default:
      die('usage: aos-orch run|status|pause|resume|cancel|kill|approve-plan|reject-plan|approvals|approve|deny ...', 64);
  }
}
main().catch((e) => die(e.message));
