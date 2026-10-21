// aos-orch archive / unarchive / goals --all, temp state dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HERE } from './helpers.mjs';

const CLI = path.join(HERE, '..', 'bin', 'aos-orch.mjs');
function mk() {
  const orch = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-arch-'));
  const add = (id, status, { ageDays = 0, lock } = {}) => {
    const d = path.join(orch, 'goals', id); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'goal.json'), JSON.stringify({ id, title: `t-${id}`, status, updated_at: new Date(Date.now() - ageDays * 86400000).toISOString(), orch: { plan_state: 'approved' } }));
    fs.writeFileSync(path.join(d, 'tasks.json'), '[]');
    if (lock) fs.writeFileSync(path.join(d, '.tick.lock'), JSON.stringify({ pid: lock, ts: Date.now(), token: 'x', label: 'run' }));
  };
  const cli = (...a) => { const r = spawnSync(process.execPath, [CLI, '--orch-dir', orch, ...a], { encoding: 'utf8', env: { ...process.env, AOS_ORCH_DIR: orch } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const has = (sub, id) => fs.existsSync(path.join(orch, sub, id, 'goal.json'));
  return { orch, add, cli, has, done: () => fs.rmSync(orch, { recursive: true, force: true }) };
}

test('archive/unarchive roundtrip, goals --all marks archived', (t) => {
  const s = mk(); t.after(s.done); s.add('g1', 'achieved'); s.add('g2', 'blocked');
  let r = s.cli('archive', 'g1'); assert.equal(r.code, 0); assert.match(r.out, /moved {2}g1/);
  assert.ok(!s.has('goals', 'g1')); assert.ok(s.has('archive/goals', 'g1'));
  assert.doesNotMatch(s.cli('goals').out, /g1/);
  assert.match(s.cli('goals', '--all').out, /g1 .*\[archived\]/);
  assert.equal(JSON.parse(s.cli('goals', '--all', '--json').out).find((g) => g.id === 'g1').archived, true);
  r = s.cli('unarchive', 'g1'); assert.equal(r.code, 0); assert.ok(s.has('goals', 'g1')); assert.ok(!s.has('archive/goals', 'g1'));
  assert.equal(s.cli('unarchive', 'g1').code, 1); // not archived any more
});

test('archive refuses live-lock and active goals, and never deletes', (t) => {
  const s = mk(); t.after(s.done); s.add('live', 'blocked', { lock: process.pid }); s.add('act', 'active'); s.add('drafty', 'draft', { lock: process.pid });
  const r = s.cli('archive', 'live', 'act', 'drafty');
  assert.equal(r.code, 1); assert.equal((r.out.match(/refused/g) || []).length, 3);
  for (const id of ['live', 'act', 'drafty']) assert.ok(s.has('goals', id));
  assert.equal(s.cli('archive', 'nope').code, 1);
  assert.equal(s.cli('archive', '../x').code, 1);
});

test('archive filters: --blocked, --achieved, --older-than (finished goals only), and a live goal is skipped as refused only when named', (t) => {
  const s = mk(); t.after(s.done);
  s.add('b-old', 'blocked', { ageDays: 40 }); s.add('b-new', 'blocked'); s.add('a-old', 'achieved', { ageDays: 40 }); s.add('act-old', 'active', { ageDays: 90 });
  let r = s.cli('archive', '--blocked', '--older-than', '30'); assert.equal(r.code, 0); assert.match(r.out, /b-old/); assert.doesNotMatch(r.out, /b-new|a-old/);
  r = s.cli('archive', '--achieved'); assert.match(r.out, /a-old/); assert.ok(s.has('archive/goals', 'a-old'));
  r = s.cli('archive', '--older-than', '1'); assert.doesNotMatch(r.out, /act-old/); assert.ok(s.has('goals', 'act-old')); assert.ok(s.has('goals', 'b-new'));
  assert.equal(s.cli('archive', '--blocked').out.includes('b-new'), true);
  assert.equal(s.cli('archive').code, 2); assert.equal(s.cli('archive', 'x', '--blocked').code, 2);
});

test('archive --dry-run moves nothing', (t) => {
  const s = mk(); t.after(s.done); s.add('g1', 'achieved');
  const r = s.cli('archive', '--achieved', '--dry-run'); assert.match(r.out, /would-move {2}g1/);
  assert.ok(s.has('goals', 'g1')); assert.ok(!fs.existsSync(path.join(s.orch, 'archive')));
});
