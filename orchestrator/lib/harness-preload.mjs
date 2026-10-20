// ENGINE-OWNED preload for every node:test check the engine runs (`node --import <this file> --test ...`). A copy of this file lives in a read-only dir
// outside the worktree (lib/harness-guard.mjs). It runs BEFORE any worker-written code, in every test-file process, and:
//   1. snapshots node:assert, node:assert/strict and node:test (CJS export objects, their ESM namespaces, the exported functions) and FREEZES the export objects,
//      so code under test cannot replace assert.* with a no-op (the "Object.keys(assert) -> noop + syncBuiltinESMExports" cheat);
//   2. wraps process.reallyExit (process.exit goes through it) and registers the FIRST 'exit' handler plus a root `after` hook, each re-verifying every
//      snapshotted function by identity and writing a marker {nonce, ok, checked, problems} into the engine's marker dir;
//   3. captures the nonce + marker dir from the environment and DELETES them from process.env (so code under test cannot read or forge them via process.env).
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
