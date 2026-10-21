// ENGINE-OWNED preload for every node:test check the engine runs (`node --import <this file> --test ...`). A copy of this file lives in a read-only dir
// outside the worktree (lib/harness-guard.mjs). It runs BEFORE any worker-written code, in every test-file process, and:
//   1. snapshots node:assert, node:assert/strict and node:test (CJS export objects, their ESM namespaces, the exported functions) and FREEZES the export objects,
//      so code under test cannot replace assert.* with a no-op (the "Object.keys(assert) -> noop + syncBuiltinESMExports" cheat);
//   2. wraps process.reallyExit (process.exit goes through it) and registers the FIRST 'exit' handler plus a root `after` hook, each re-verifying every
//      snapshotted function by identity and writing a marker {nonce, ok, checked, problems} into the engine's marker dir;
//   3. captures the nonce + marker dir from the environment and DELETES them from process.env (so code under test cannot read or forge them via process.env).
//   4. (round 2) records, sticky, a module-loader hook registration (module.register / process.registerHooks), a REPLACEMENT of the fs read functions, and a
//      node child process / Worker whose outcome the test never looked at (spawnSync result never read, async child with no exit/close listener or callback).
// The engine treats a missing / unparsable / wrong-nonce / not-ok marker as `harness_tamper`. Limits (documented in the README): code running in the same
// process could still read /proc/self/environ (Linux) to learn the nonce, or tamper with things we do not snapshot.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as ASSERT_NS from 'node:assert';
import * as STRICT_NS from 'node:assert/strict';
import * as TEST_NS from 'node:test';

const env = process.env;
const nonce = env.AOS_GUARD_NONCE; const dir = env.AOS_GUARD_DIR;
const isolationNone = process.execArgv.some((a) => /^--(?:experimental-)?test-isolation=none$/.test(a));
const isRunner = process.execArgv.includes('--test') && !env.NODE_TEST_CONTEXT && !isolationNone;
if (nonce && dir && !isRunner) setup();

function setup() {
  delete env.AOS_GUARD_NONCE; delete env.AOS_GUARD_DIR; // captured above: not readable by anything that runs later
  const { writeFileSync } = fs; const { ownKeys, getOwnPropertyDescriptor } = Reflect;
  const freeze = Object.freeze; const isFrozen = Object.isFrozen; const keysOf = Object.keys;
  const pid = process.pid; const file = String(process.argv[1] || '');
  const origReallyExit = process.reallyExit; const origExit = process.exit;
  const req = createRequire(import.meta.url);
  const targets = []; const add = (name, o) => { if (o && (typeof o === 'object' || typeof o === 'function') && !targets.some((t) => t.o === o)) targets.push({ name, o }); };
  const A = req('node:assert');
  const FS = req('node:fs'); const FSP = FS.promises; const CP = req('node:child_process'); const MOD = req('node:module'); const WT = req('node:worker_threads');
  const FS_KEYS = ['readFileSync', 'readFile', 'readSync', 'read', 'openSync', 'open', 'createReadStream', 'readdirSync', 'readdir', 'existsSync', 'statSync', 'lstatSync'];
  const FSP_KEYS = ['readFile', 'open', 'readdir', 'stat'];
  const fsSnap = [['fs', FS, FS_KEYS], ['fs.promises', FSP, FSP_KEYS]].map(([name, o, ks]) => ({ name, o, vals: ks.filter((k) => typeof o[k] === 'function').map((k) => [k, o[k]]) }));
  const sticky = []; const note = (m) => { if (sticky.length < 10 && !sticky.includes(m)) sticky.push(m); };
  const unseen = []; // node children / workers whose outcome was never looked at: {what, seen: () => boolean}
  const isNodeCmd = (c) => { const b = String(c || '').split(/[\\/]/).pop(); return c === process.execPath || b === 'node' || b === 'node.exe'; };
  const wrapFn = (o, k, make) => { const orig = o[k]; if (typeof orig !== 'function') return; try { Object.defineProperty(o, k, { value: make(orig), writable: true, configurable: true, enumerable: true }); } catch { /* keep going */ } };
  // (a) a module loader hook can rewrite any module that loads after it (test files, helpers): recorded, the run is reported as harness_tamper
  for (const k of ['register', 'registerHooks']) wrapFn(MOD, k, (orig) => function (...a) { note(`a module loader hook was registered (module.${k}): it can rewrite test code at load time`); return orig.apply(this, a); });
  // (b) node child processes: a spawnSync result nobody read, or an async child nobody waits for, ran assertions outside this guard and its verdict is lost
  wrapFn(CP, 'spawnSync', (orig) => function spawnSync(file, ...rest) {
    const r = orig.call(this, file, ...rest); if (!isNodeCmd(file) || !r || typeof r !== 'object') return r;
    let seen = false; const rec = { what: 'spawnSync(node)', seen: () => seen }; unseen.push(rec);
    return new Proxy(r, { get(t, k, rc) { if (k === 'status' || k === 'signal' || k === 'error' || k === 'stdout' || k === 'stderr' || k === 'output') seen = true; return Reflect.get(t, k, rc); } });
  });
  const watch = (orig, nodeArg) => function (file, ...rest) {
    const c = orig.call(this, file, ...rest); const hasCb = typeof rest[rest.length - 1] === 'function';
    if (c && typeof c.listenerCount === 'function' && (nodeArg === 'fork' || isNodeCmd(file))) unseen.push({ what: `${nodeArg}(node)`, seen: () => hasCb || c.listenerCount('exit') + c.listenerCount('close') > 0 });
    return c;
  };
  for (const k of ['spawn', 'execFile']) wrapFn(CP, k, (orig) => watch(orig, k));
  wrapFn(CP, 'fork', (orig) => watch(orig, 'fork'));
  try { MOD.syncBuiltinESMExports(); } catch { /* ESM named imports keep the originals */ }
  void WT;
  add('assert', A); add('assert.strict', A.strict); add('assert/strict', req('node:assert/strict')); add('test', req('node:test'));
  const nsList = [['ns:assert', ASSERT_NS], ['ns:assert/strict', STRICT_NS], ['ns:test', TEST_NS]];
  let frozen = 0;
  const tryFreeze = (o) => { try { freeze(o); frozen++; } catch { /* not freezable */ } };
  for (const t of targets) { for (const k of ownKeys(t.o)) { const d = getOwnPropertyDescriptor(t.o, k); if (d && typeof d.value === 'function' && k !== 'prototype') tryFreeze(d.value); } tryFreeze(t.o); }
  const snap = targets.map((t) => ({ name: t.name, o: t.o, props: ownKeys(t.o).map((k) => [k, getOwnPropertyDescriptor(t.o, k)]) }));
  const nsSnap = nsList.map(([name, ns]) => ({ name, ns, vals: keysOf(ns).map((k) => [k, ns[k]]) }));
  let bad = []; let checked = 0;
  const verify = () => {
    const problems = []; checked = 0;
    for (const s of snap) {
      const cur = ownKeys(s.o);
      if (cur.length !== s.props.length) problems.push(`${s.name}: property set changed (${s.props.length} -> ${cur.length})`);
      for (const [k, d] of s.props) {
        const c = getOwnPropertyDescriptor(s.o, k); checked++;
        if (!c || c.value !== d.value || c.get !== d.get || c.set !== d.set || c.enumerable !== d.enumerable || (d.configurable === false && c.configurable !== false)) problems.push(`${s.name}.${String(k)} was replaced or redefined`);
        else if (typeof d.value === 'function' && k !== 'prototype' && !isFrozen(d.value) && isFrozen(s.o)) problems.push(`${s.name}.${String(k)} was unfrozen`);
      }
      if (!isFrozen(s.o)) problems.push(`${s.name} is not frozen`);
    }
    for (const s of nsSnap) for (const [k, v] of s.vals) { checked++; if (s.ns[k] !== v) problems.push(`${s.name}.${k} (ESM export) was replaced`); }
    for (const f of fsSnap) for (const [k, v] of f.vals) { checked++; if (f.o[k] !== v) problems.push(`${f.name}.${k} (a file read function) was replaced: tests could be fed other content`); }
    for (const m of sticky) problems.push(m);
    for (const u of unseen) if (!u.seen()) problems.push(`a ${u.what} child was started and its outcome never looked at (its assertions run outside the guard)`);
    if (process.reallyExit !== wrappedReallyExit) problems.push('process.reallyExit was replaced');
    for (const p of problems) if (bad.length < 10 && !bad.includes(p)) bad.push(p); // sticky: a tamper seen once stays reported
    return problems;
  };
  const marker = (kind, extra) => { try { writeFileSync(`${dir}/${pid}.${kind}`, JSON.stringify({ nonce, pid, file, ...extra })); } catch { /* the engine reports a missing marker */ } };
  let finalized = false;
  const finalize = (code) => { if (finalized) return; finalized = true; try { verify(); } catch (e) { bad.push(`verification failed: ${String(e && e.message).slice(0, 100)}`); } marker('end', { ok: bad.length === 0, checked, frozen, problems: bad, code: code ?? null }); };
  const wrappedReallyExit = function reallyExit(code) { finalize(code); return origReallyExit.call(process, code); };
  try { Object.defineProperty(process, 'reallyExit', { value: wrappedReallyExit, writable: false, configurable: false, enumerable: false }); } catch { /* keep going: the exit handler still verifies */ }
  void origExit;
  marker('start', {});
  process.on('exit', (code) => finalize(code)); // registered first: runs before any listener the code under test adds
  try { TEST_NS.after(() => { const p = verify(); if (p.length) throw new Error(`harness_tamper: ${p[0]}`); }); } catch { /* no root hook available */ }
}
