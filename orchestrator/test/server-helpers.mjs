// Shared helpers for the control-server / supervisor tests: real HTTP on an ephemeral 127.0.0.1 port, fake claude, throwaway repos.
import http from 'node:http';
import { Supervisor } from '../lib/supervisor.mjs';
import { createControlServer } from '../server/index.mjs';
import { readCliToken } from '../server/auth.mjs';
import { sleep, NO_OS_SANDBOX } from './helpers.mjs';

export function request(port, { method = 'GET', path = '/', headers = {}, body, chunked = false, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: host ?? `127.0.0.1:${port}`, ...headers };
    const data = body === undefined ? null : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (data !== null && !chunked && h['Content-Length'] === undefined) h['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, setHost: false }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject);
    if (data !== null) { if (chunked) { for (let i = 0; i < data.length; i += 8192) req.write(data.slice(i, i + 8192)); req.end(); } else req.end(data); } else req.end();
  });
}

/** Supervisor + control server on an ephemeral port. api() sends the CLI token and records every body (for the no-paths scan). */
export async function startStack(sb, o = {}) {
  const logs = []; const bodies = [];
  const sup = new Supervisor({ orchDir: sb.orch, env: sb.env(), pollMs: 50, intervalMs: 200, scanMs: 60000,
    engineOpts: { killGraceMs: 300, budgetGraceMs: 400, plannerTimeoutMs: 30000 }, ...(o.sup || {}) });
  const srv = createControlServer({ supervisor: sup, port: 0, log: (m) => logs.push(m), ...(o.srv || {}) });
  await sup.start(); const port = await srv.listen();
  const token = readCliToken(sb.orch);
  const api = async (method, path, body, extra = {}) => {
    const r = await request(port, { method, path, body, headers: { Authorization: `Bearer ${extra.token ?? token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : (method === 'POST' || method === 'PATCH' ? { 'Content-Type': 'application/json' } : {})), ...(extra.headers || {}) } });
    bodies.push(r.text); return r;
  };
  const stack = { sup, srv, port, token, logs, bodies, api, req: (opts) => request(port, opts),
    async stop(opts = { workers: 'kill' }) { await srv.close(); await sup.stop(opts); } };
  sb.stacks = (sb.stacks || []).concat(stack);
  return stack;
}

export async function until(fn, { timeoutMs = 30000, pollMs = 40, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(pollMs); }
  throw new Error(`timed out waiting for ${what}`);
}

export const goalBody = (repo, o = {}) => ({ title: 'API goal', description: 'made over http', repo, base_branch: 'main',
  success_criteria: [{ text: 'all files present' }], budgets: { max_new_tokens: 2000000, max_wall_s: 3600, max_parallel: 3, max_attempts: 3 },
  check_allowlist: ['node'], ...(NO_OS_SANDBOX ? { unsandboxed_checks: true } : {}), ...o });

/** Create over HTTP, wait for the plan, return {id, plan}. */
export async function createAndPlan(stack, repo, o = {}) {
  const r = await stack.api('POST', '/api/goals', goalBody(repo, o));
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${r.text}`);
  const id = r.json.goal.id;
  await until(async () => (await stack.api('GET', `/api/goals/${id}/plan`)).json?.plan_state === 'awaiting_approval', { what: 'plan awaiting approval' });
  return { id, plan: (await stack.api('GET', `/api/goals/${id}/plan`)).json };
}
export async function approve(stack, id) {
  const plan = (await stack.api('GET', `/api/goals/${id}/plan`)).json;
  return stack.api('POST', `/api/goals/${id}/plan/approve`, { plan_hash: plan.plan_hash });
}
export const detail = async (stack, id) => (await stack.api('GET', `/api/goals/${id}`)).json.goal;
export const waitStatus = (stack, id, status, timeoutMs = 60000) => until(async () => { const g = await detail(stack, id); return g.status === status ? g : null; }, { timeoutMs, what: `${id} ${status}` });
