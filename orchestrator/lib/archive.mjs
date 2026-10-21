// Archive / unarchive goal directories: an atomic rename between <state>/goals/ and <state>/archive/goals/. Never deletes.
// The dashboard reads only <state>/goals/, so archived goals disappear from its GOALS panel and "Needs you".
import fs from 'node:fs';
import path from 'node:path';
import { goalsRoot, goalDirOf, paths, readJSON, pidAlive, lockStatus } from './state.mjs';

export const GID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const archiveRoot = (orch) => path.join(orch, 'archive', 'goals');
export const archivedDirOf = (orch, id) => path.join(archiveRoot(orch), id);

/** Why a goal dir must not be moved right now, or null. Live lock, a live attached `run`, or status active. */
export function archiveRefusal(dir) {
  const g = readJSON(paths(dir).goal, null);
  if (!g) return 'no goal.json';
  const st = lockStatus(dir);
  if (st.owner_alive) return `its engine lock is live (pid ${st.owner_pid})`;
  const l = readJSON(paths(dir).lock, null);
  if (l && pidAlive(l.pid)) return `its engine lock is held by live pid ${l.pid}`;
  const a = readJSON(path.join(dir, 'attached.json'), null);
  if (a && pidAlive(a.pid) && Date.now() - a.ts < 5000) return `an attached run (pid ${a.pid}) is waiting on it`;
  if (g.status === 'active') return 'status is active';
  return null;
}

const listIds = (root) => { try { return fs.readdirSync(root).filter((id) => GID_RE.test(id)); } catch { return []; } };
const updatedMs = (dir, g) => { const t = Date.parse(g.updated_at || ''); return Number.isFinite(t) ? t : fs.statSync(paths(dir).goal).mtimeMs; };

/** Goal ids matching the filters (AND). With no status filter, only finished goals (achieved/failed/cancelled/blocked) qualify for --older-than. */
export function selectGoals(orch, { blocked, achieved, olderThanDays, now = Date.now() }) {
  const ids = [];
  for (const id of listIds(goalsRoot(orch))) {
    const dir = goalDirOf(orch, id); const g = readJSON(paths(dir).goal, null); if (!g) continue;
    if (blocked || achieved) { if (!((blocked && g.status === 'blocked') || (achieved && g.status === 'achieved'))) continue; }
    else if (!['achieved', 'failed', 'cancelled', 'blocked'].includes(g.status)) continue;
    if (olderThanDays != null && now - updatedMs(dir, g) < olderThanDays * 86400000) continue;
    ids.push(id);
  }
  return ids;
}

/** Move each id; returns [{id, action:'moved'|'would-move'|'refused', reason?}]. */
export function moveGoals(orch, ids, { to, dryRun = false }) {
  const [fromOf, toOf] = to === 'archive' ? [goalDirOf, archivedDirOf] : [archivedDirOf, goalDirOf];
  return ids.map((id) => {
    if (!GID_RE.test(id)) return { id, action: 'refused', reason: 'invalid goal id' };
    const src = fromOf(orch, id); const dst = toOf(orch, id);
    if (!fs.existsSync(paths(src).goal)) return { id, action: 'refused', reason: `no such goal in ${to === 'archive' ? 'goals' : 'archive'}` };
    if (fs.existsSync(dst)) return { id, action: 'refused', reason: `${dst} already exists` };
    if (to === 'archive') { const why = archiveRefusal(src); if (why) return { id, action: 'refused', reason: why }; }
    if (dryRun) return { id, action: 'would-move' };
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    try { fs.renameSync(src, dst); } catch (e) { return { id, action: 'refused', reason: e.message }; }
    return { id, action: 'moved' };
  });
}
