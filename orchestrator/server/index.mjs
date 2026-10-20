// Control server (design section 9): HTTP on 127.0.0.1 only. See orchestrator/README.md "Control server" for the contract.
// Pipeline per request: loopback peer -> Host allowlist (DNS rebinding) -> Origin allowlist/CORS -> preflight -> route (404/405)
// -> bearer auth (+ per-IP failed-auth limiter) -> JSON content-type + 64 KB body for mutations -> handler -> audit Event.
import http from 'node:http';
import path from 'node:path';
import { Auth, SESSION_TTL_MS } from './auth.mjs';
import { loginPage } from './login-page.mjs';
import { goalSummary, goalDetail, planView, approvalView, eventView, scrub, scrubDeep } from './views.mjs';
import { SupervisorError, validateRepo } from '../lib/supervisor.mjs';
import { ID_RE, readEvents, goalDirOf, readJSON, paths } from '../lib/state.mjs';
import { draftGoal, draftRules, checkProblem, PROFILES } from '../lib/draft.mjs';

export const SERVER_VERSION = '0.3.0';
export const DEFAULT_PORT = 4319;
export const DEFAULT_DASHBOARD = 'http://127.0.0.1:4318/';
const BODY_LIMIT = 64 * 1024;
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export class HttpError extends Error { constructor(status, code, message, headers) { super(message); this.status = status; this.code = code; this.headers = headers; } }
const bad = (m) => new HttpError(400, 'invalid_request', m);

export function parsePort(v) {
  const n = typeof v === 'number' ? v : /^\d{1,5}$/.test(String(v)) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`invalid port "${v}": must be an integer in 1024-65535`);
  return n;
}

// ---------------------------------------------------------------- strict input validation
const exact = (o, allowed, at) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) throw bad(`${at}: unknown field "${k}"`); };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, at, min, max) => { if (typeof v !== 'string' || v.trim().length < min || v.length > max || /[\0]/.test(v)) throw bad(`${at} must be a string of ${min}-${max} characters`); return v; };
const int = (v, at, lo, hi) => { if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${at} must be an integer in [${lo}, ${hi}]`); return v; };
const bool = (v, at) => { if (typeof v !== 'boolean') throw bad(`${at} must be a boolean`); return v; };
const BRANCH_RE = /^(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'goal';

export function parseGoalBody(b) {
  if (!isObj(b)) throw bad('body must be a JSON object');
  exact(b, ['title', 'description', 'repo', 'base_branch', 'success_criteria', 'budgets', 'trust_repo_config', 'plan_approval', 'unsandboxed_checks', 'check_allowlist', 'profile', 'drafted'], 'goal');
  const out = { title: str(b.title, 'title', 1, 200), description: b.description === undefined ? '' : str(b.description, 'description', 0, 8000), repo: str(b.repo, 'repo', 1, 1024) };
  out.base_branch = b.base_branch === undefined ? 'main' : str(b.base_branch, 'base_branch', 1, 100);
  if (!BRANCH_RE.test(out.base_branch)) throw bad('base_branch is not a safe branch name');
  if (!Array.isArray(b.success_criteria) || b.success_criteria.length < 1 || b.success_criteria.length > 20) throw bad('success_criteria must be an array of 1-20 items');
  out.success_criteria = b.success_criteria.map((c, i) => { if (!isObj(c)) throw bad(`success_criteria[${i}] must be an object`); exact(c, ['text', 'check', 'verify'], `success_criteria[${i}]`);
    const o = { text: str(c.text, `success_criteria[${i}].text`, 1, 500) };
    if (c.verify !== undefined) { if (c.verify !== 'human') throw bad(`success_criteria[${i}].verify must be "human"`); if (c.check !== undefined) throw bad(`success_criteria[${i}]: a check or verify "human", not both`); o.verify = 'human'; }
    if (c.check !== undefined) { // validated against the compiled rules by the handler (a criterion check never widens the allowlist)
      if (!isObj(c.check) || !Array.isArray(c.check.argv)) throw bad(`success_criteria[${i}].check must be {argv, timeout_s}`);
      o.check = { argv: c.check.argv, timeout_s: c.check.timeout_s };
    }
    return o; });
  const B = b.budgets === undefined ? {} : b.budgets;
  if (!isObj(B)) throw bad('budgets must be an object');
  exact(B, ['max_new_tokens', 'max_wall_s', 'max_parallel', 'max_attempts'], 'budgets');
  out.budgets = {};
  if (B.max_new_tokens !== undefined) out.budgets.max_new_tokens = int(B.max_new_tokens, 'budgets.max_new_tokens', 1, 1e10);
  if (B.max_wall_s !== undefined) out.budgets.max_wall_s = int(B.max_wall_s, 'budgets.max_wall_s', 1, 31536000);
  if (B.max_parallel !== undefined) out.budgets.max_parallel = int(B.max_parallel, 'budgets.max_parallel', 1, 16);
  if (B.max_attempts !== undefined) out.budgets.max_attempts = int(B.max_attempts, 'budgets.max_attempts', 1, 10);
  out.trust_repo_config = b.trust_repo_config === undefined ? false : bool(b.trust_repo_config, 'trust_repo_config');
  out.unsandboxed_checks = b.unsandboxed_checks === undefined ? false : bool(b.unsandboxed_checks, 'unsandboxed_checks');
  if (b.plan_approval !== undefined && b.plan_approval !== 'human') throw bad('plan_approval must be "human" (the API never auto-approves plans)');
  // extension of the contract: commands the planner may use in checks (every plan with commands still needs a human)
  if (b.check_allowlist !== undefined) {
    if (!Array.isArray(b.check_allowlist) || b.check_allowlist.length > 20) throw bad('check_allowlist must be an array of up to 20 strings');
    out.check_allowlist = b.check_allowlist.map((s, i) => str(s, `check_allowlist[${i}]`, 1, 100));
  }
  if (b.profile !== undefined) { if (typeof b.profile !== 'string' || !Object.hasOwn(PROFILES, b.profile)) throw bad('profile must be one of strict, node-library, docs-only'); out.profile = b.profile; }
  if (b.drafted !== undefined) { if (!isObj(b.drafted)) throw bad('drafted must be an object'); exact(b.drafted, ['tier'], 'drafted'); if (!['haiku', 'sonnet'].includes(b.drafted.tier)) throw bad('drafted.tier must be haiku or sonnet'); out.drafted = { tier: b.drafted.tier }; }
  return out;
}

// ---------------------------------------------------------------- the server
export function createControlServer(opts) {
  const { supervisor: sup } = opts;
  const clock = opts.clock || sup.clock || { now: () => Date.now() };
  const log = opts.log || (() => {});
  const dashboardUrl = new URL(opts.dashboardUrl || DEFAULT_DASHBOARD);
  if (!/^https?:$/.test(dashboardUrl.protocol) || dashboardUrl.username || dashboardUrl.password) throw new Error('dashboardUrl must be a plain http(s) URL');
  dashboardUrl.hash = '';
  const auth = new Auth({ orchDir: sup.orchDir, clock });
  const extraOrigins = new Set([...(opts.allowedOrigins || ['http://127.0.0.1:4318', 'http://localhost:4318']), dashboardUrl.origin]);
  let port = opts.port ?? DEFAULT_PORT;
  const sseClients = new Set();
  const draftHits = new Map(); const draftBusy = new Set(); const DRAFT_PER_MIN = 6; const DRAFT_PARALLEL = 3;
  let sseSeq = 0;

  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = () => new Set([...extraOrigins, `http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  // ---- responses
  function send(res, status, body, extra = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...res.aosCors, ...extra });
    res.end(data);
  }
  const sendErr = (res, e) => {
    if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } }, e.headers || {});
    if (e instanceof SupervisorError) return send(res, e.status, { error: { code: e.code, message: scrub(e.message) } });
    log(`internal error: ${String(e?.message || e).slice(0, 200)}`);
    return send(res, 500, { error: { code: 'internal', message: 'internal error' } });
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const len = req.headers['content-length'];
      if (len !== undefined && (!/^\d+$/.test(len) || Number(len) > BODY_LIMIT)) return reject(new HttpError(413, 'payload_too_large', `body limit is ${BODY_LIMIT} bytes`, { Connection: 'close' }));
      const chunks = []; let n = 0; let done = false;
      req.on('data', (c) => { if (done) return; n += c.length; if (n > BODY_LIMIT) { done = true; reject(new HttpError(413, 'payload_too_large', `body limit is ${BODY_LIMIT} bytes`, { Connection: 'close' })); } else chunks.push(c); });
      req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
      req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });
  }

  // ---- routes
  const goalId = (p) => { if (!ID_RE.test(p.id)) throw bad('invalid goal id'); return p.id; };
  const confirmBody = (b) => { if (b !== undefined && !isObj(b)) throw bad('body must be a JSON object'); return b || {}; };
  const aud = (c, goal, action, data = {}) => sup.audit(goal, action, { session: auth.auditId(c.principal), ...data });
  const by = (c) => `control:${auth.auditId(c.principal)}`;
  const lifecycle = (kind) => async (c) => {
    const id = goalId(c.params); const b = confirmBody(c.body);
    if (kind === 'kill' && b.confirm !== true) throw new HttpError(400, 'confirm_required', 'kill requires {"confirm": true}');
    exact(b, kind === 'kill' ? ['confirm'] : [], kind);
    sup.state(id);
    aud(c, id, kind);
    const applied = await sup[kind](id, by(c));
    return { goal: goalDetail(sup, id), applied };
  };
  const routes = [
    ['GET', '/api/health', () => {
      const g = sup.governorState(); const raw = g.raw || {};
      return { ok: true, version: SERVER_VERSION, goals: sup.goalIds().length, workers: { running: sup.workerCount(), max: sup.maxWorkers },
        governor: { five_hour: raw.five_hour?.utilization ?? null, seven_day: raw.seven_day?.utilization ?? null, paused: !g.dispatch, resume_at: g.resume_at_ms ? new Date(g.resume_at_ms).toISOString() : null, reason: g.reason ? scrub(g.reason) : null } };
    }],
    ['GET', '/api/goals', () => ({ goals: sup.goalIds().map((id) => { try { return goalSummary(sup, id); } catch { return null; } }).filter(Boolean).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) })],
    ['POST', '/api/goals', async (c) => {
      const p = parseGoalBody(c.body);
      const root = await validateRepo(p.repo, { orchDir: sup.orchDir });
      if (p.success_criteria.some((c) => c.check)) { // a criterion check must already be allowed by the rules (user + repo + profile layers) or by the allowlist typed in the same request: criteria never widen it
        const dr = await draftRules({ orchDir: sup.orchDir, root, branch: p.base_branch, profile: p.profile || 'strict' });
        if (!dr.ok) throw new HttpError(422, 'goal_refused', scrub(`rules refused: ${dr.errors.slice(0, 3).join('; ')}`).slice(0, 1500));
        const c0 = dr.comp.compiled; const plus = { ...c0, checks: { ...c0.checks, allowlist: [...c0.checks.allowlist, ...(p.check_allowlist || []).map((cmd, i) => ({ id: `form${i}`, cmd, layer: 'goal' }))] } };
        p.success_criteria.forEach((c, i) => { const why = c.check ? checkProblem(c.check, plus) : null; if (why) throw new HttpError(422, 'criterion_refused', scrub(`success_criteria[${i}].check: ${why}`).slice(0, 500)); });
      }
      const id = `g-${new Date(clock.now()).toISOString().slice(0, 10).replace(/-/g, '')}-${slug(p.title)}-${Math.random().toString(16).slice(2, 6)}`;
      const spec = { id, title: p.title, description: p.description, success_criteria: p.success_criteria,
        budget: { max_ticks: 100000, max_usd: 5, max_wall_clock_s: p.budgets.max_wall_s ?? 7200 },
        orch: { repo: root, base_branch: p.base_branch, trust_repo_config: p.trust_repo_config, ...(p.profile && PROFILES[p.profile] ? { rules: PROFILES[p.profile] } : {}), ...(p.drafted ? { drafted: p.drafted } : {}), unsandboxed_checks: p.unsandboxed_checks, plan_approval: 'required',
          ...(p.check_allowlist ? { check_allowlist: p.check_allowlist } : {}),
          budgets: Object.fromEntries(['max_new_tokens', 'max_parallel', 'max_attempts'].filter((k) => p.budgets[k] !== undefined).map((k) => [k, p.budgets[k]])) } };
      let made;
      try { made = await sup.createGoal(spec); } catch (e) { throw new HttpError(422, 'goal_refused', scrub(String(e.message)).slice(0, 1500)); }
      aud(c, made.goal.id, 'goal.create', { title: p.title.slice(0, 100), trust_repo_config: p.trust_repo_config, unsandboxed_checks: p.unsandboxed_checks });
      return [201, { goal: goalDetail(sup, made.goal.id), notices: made.notices.map(scrub) }];
    }],
    // R12: a draft is a PROPOSAL. This route never creates a goal (only an explicit POST /api/goals does); it is authenticated like goal creation and rate-limited per session.
    ['POST', '/api/goals/draft', async (c) => {
      if (!isObj(c.body)) throw bad('body must be a JSON object'); exact(c.body, ['prompt', 'repo', 'profile'], 'draft');
      const prompt = str(c.body.prompt, 'prompt', 1, 6000); const repo = str(c.body.repo, 'repo', 1, 1024);
      let profile = 'strict'; if (c.body.profile !== undefined) { if (typeof c.body.profile !== 'string' || !Object.hasOwn(PROFILES, c.body.profile)) throw bad('profile must be one of strict, node-library, docs-only'); profile = c.body.profile; }
      const who = auth.auditId(c.principal); const now = clock.now();
      const recent = (draftHits.get(who) || []).filter((t) => now - t < 60000);
      if (recent.length >= DRAFT_PER_MIN || draftBusy.has(who) || draftBusy.size >= DRAFT_PARALLEL) throw new HttpError(429, 'rate_limited', 'too many draft requests; wait a moment', { 'Retry-After': '10' });
      draftHits.set(who, [...recent, now]); draftBusy.add(who);
      let r; try { r = await draftGoal({ orchDir: sup.orchDir, repo, prompt, profile, env: sup.env, spawnFn: sup.spawnFn, claudeBin: sup.claudeBin, ...(opts.draft || {}) }); } finally { draftBusy.delete(who); }
      log(`draft ${r.ok ? 'ok' : 'refused'} tier=${r.tier} tokens=${r.usage.new_tokens}`);
      return scrubDeep({ draft: r.draft, errors: r.errors, questions: r.questions, rules_hash: r.rules_hash, draft_tier: r.tier, profile: r.profile, usage: r.usage });
    }],
    ['POST', '/api/goals/:id/criteria/:cid/confirm', async (c) => {
      const id = goalId(c.params); const b = confirmBody(c.body); exact(b, [], 'confirm');
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(c.params.cid)) throw bad('invalid criterion id');
      sup.state(id);
      aud(c, id, 'criterion.confirm', { criterion: c.params.cid });
      await sup.confirmCriterion(id, c.params.cid, by(c));
      return { goal: goalDetail(sup, id) };
    }],
    ['GET', '/api/goals/:id', (c) => { const id = goalId(c.params); sup.state(id); return { goal: goalDetail(sup, id) }; }],
    ['POST', '/api/goals/:id/pause', lifecycle('pause')],
    ['POST', '/api/goals/:id/resume', lifecycle('resume')],
    ['POST', '/api/goals/:id/cancel', lifecycle('cancel')],
    ['POST', '/api/goals/:id/kill', lifecycle('kill')],
    ['PATCH', '/api/goals/:id/budgets', async (c) => {
      const id = goalId(c.params); if (!isObj(c.body)) throw bad('body must be a JSON object');
      sup.state(id);
      aud(c, id, 'budgets.patch', { patch: JSON.stringify(c.body).slice(0, 300) });
      const applied = await sup.setBudgets(id, c.body, by(c));
      return { goal: goalDetail(sup, id), applied };
    }],
    ['GET', '/api/goals/:id/plan', (c) => { const id = goalId(c.params); sup.state(id); return planView(sup, id); }],
    ['POST', '/api/goals/:id/plan/approve', async (c) => {
      const id = goalId(c.params); if (!isObj(c.body)) throw bad('body must be a JSON object'); exact(c.body, ['plan_hash'], 'approve');
      const h = str(c.body.plan_hash, 'plan_hash', 64, 64);
      sup.state(id);
      aud(c, id, 'plan.approve', { plan_hash: h.slice(0, 12) });
      await sup.approvePlan(id, h, by(c));
      return { goal: goalDetail(sup, id) };
    }],
    ['POST', '/api/goals/:id/plan/reject', async (c) => {
      const id = goalId(c.params); if (!isObj(c.body)) throw bad('body must be a JSON object'); exact(c.body, ['reason'], 'reject');
      const reason = str(c.body.reason ?? '', 'reason', 0, 500);
      sup.state(id);
      aud(c, id, 'plan.reject', { reason });
      await sup.rejectPlan(id, by(c));
      return { goal: goalDetail(sup, id) };
    }],
    ['GET', '/api/goals/:id/events', (c) => {
      const id = goalId(c.params); sup.state(id);
      const after = c.query.has('after') ? Number(c.query.get('after')) : 0; const limit = c.query.has('limit') ? Number(c.query.get('limit')) : 100;
      int(after, 'after', 0, 1e12); int(limit, 'limit', 1, 500);
      const all = readEvents(goalDirOf(sup.orchDir, id), { sinceSeq: after });
      const events = all.slice(0, limit).map(eventView);
      return { events, next_after: events.length ? events.at(-1).seq : after, has_more: all.length > limit };
    }],
    ['GET', '/api/approvals', (c) => {
      const st = c.query.get('status') || 'pending';
      if (!['pending', 'approved', 'denied', 'expired', 'all'].includes(st)) throw bad('status must be pending|approved|denied|expired|all');
      return { approvals: sup.allApprovals().filter((a) => st === 'all' || a.status === st).map((a) => approvalView(sup, a)) };
    }],
    ['POST', '/api/approvals/:id/approve', (c) => decideRoute(c, 'approve')],
    ['POST', '/api/approvals/:id/deny', (c) => decideRoute(c, 'deny')],
    ['GET', '/api/stream', (c) => c.stream()],
    ['POST', '/auth/logout', (c) => { if (c.principal.kind === 'session') auth.revoke(c.token); return { ok: true, revoked: c.principal.kind === 'session' }; }],
  ];
  function decideRoute(c, decision) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})~(A-\d{1,6})$/.exec(c.params.id);
    if (!m || !ID_RE.test(m[1])) throw bad('invalid approval id');
    const b = confirmBody(c.body); exact(b, ['scope'], 'decision');
    const scope = b.scope === undefined ? 'once' : b.scope;
    if (!['once', 'task'].includes(scope)) throw bad('scope must be "once" or "task"');
    sup.state(m[1]);
    const rec = sup.decideApproval(m[1], m[2], decision, scope, by(c));
    aud(c, m[1], `approval.${decision}`, { approval: m[2], task: rec.task_id, scope });
    return { approval: approvalView(sup, { goal: m[1], ...rec }) };
  }
  const compiled = routes.map(([method, pat, fn]) => ({ method, fn, pat, re: new RegExp(`^${pat.replace(/:([a-z]+)/g, '(?<$1>[^/]+)')}$`) }));
  const publicRoutes = [
    { method: 'GET', re: /^\/auth\/login$/ }, { method: 'POST', re: /^\/auth\/exchange$/ },
  ];

  // ---- SSE: auth via Authorization header only (EventSource cannot set it: the browser UI polls; fetch-streaming clients may use this)
  function stream(c) {
    if (sseClients.size >= 8) throw new HttpError(429, 'too_many_streams', 'too many open streams');
    const only = c.query.get('goal'); if (only && !ID_RE.test(only)) throw bad('invalid goal id');
    const { res, req } = c;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff', ...res.aosCors });
    req.socket.setTimeout(0);
    const last = new Map();
    const ids = () => (only ? [only] : sup.goalIds());
    for (const id of ids()) { try { last.set(id, readEvents(goalDirOf(sup.orchDir, id)).at(-1)?.seq || 0); } catch { /* none */ } }
    res.write(': connected\n\n');
    const client = { res };
    const timer = setInterval(() => {
      let out = '';
      for (const id of ids()) {
        let evs = []; try { evs = readEvents(goalDirOf(sup.orchDir, id), { sinceSeq: last.get(id) ?? 0 }); } catch { /* gone */ }
        if (!last.has(id)) { last.set(id, 0); }
        for (const e of evs.slice(0, 100)) { last.set(id, e.seq); if (e.type === 'heartbeat.tick') continue; out += `id: ${++sseSeq}\nevent: goal_event\ndata: ${JSON.stringify(eventView(e))}\n\n`; }
      }
      res.write(out || ': keepalive\n\n');
    }, opts.sseIntervalMs ?? 500);
    sseClients.add(client);
    const end = () => { clearInterval(timer); sseClients.delete(client); };
    res.on('close', end);
    return STREAMING;
  }
  const STREAMING = Symbol('streaming');

  // ---- request handling
  async function handle(req, res) {
    res.aosCors = {};
    let urlPath = '-';
    try {
      const ra = req.socket.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra)) { req.socket.destroy(); return; }
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, 'invalid_request', 'bad request target');
      const url = new URL(req.url, 'http://x');
      urlPath = url.pathname;
      const host = String(req.headers.host || '').toLowerCase();
      if (!hosts().has(host)) throw new HttpError(403, 'forbidden_host', 'host not allowed');
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (!origins().has(origin)) throw new HttpError(403, 'forbidden_origin', 'origin not allowed');
        res.aosCors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' };
      }
      if (req.method === 'OPTIONS') {
        if (origin === undefined) throw new HttpError(403, 'forbidden_origin', 'preflight requires an allowed origin');
        const m = String(req.headers['access-control-request-method'] || '').toUpperCase();
        if (!['GET', 'POST', 'PATCH'].includes(m)) throw new HttpError(403, 'forbidden_method', 'method not allowed');
        const hs = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
        if (hs.some((h) => !['authorization', 'content-type'].includes(h))) throw new HttpError(403, 'forbidden_headers', 'header not allowed');
        res.writeHead(204, { ...res.aosCors, 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store', 'Content-Length': 0 });
        return res.end();
      }
      // routing
      const pub = publicRoutes.find((r) => r.re.test(url.pathname));
      const match = pub ? null : compiled.map((r) => ({ r, m: r.re.exec(url.pathname) })).filter((x) => x.m);
      if (!pub && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/')) throw new HttpError(404, 'not_found', 'no such route');
      // /api/*: authenticate BEFORE revealing which routes exist
      let principal = null; let token = null;
      const needsAuth = !pub && (url.pathname.startsWith('/api/') || (match && match.length));
      if (needsAuth) {
        const wait = auth.blocked(ra);
        if (wait) throw new HttpError(429, 'rate_limited', 'too many failed attempts; try again later', { 'Retry-After': String(wait) });
        const h = req.headers.authorization;
        const mm = typeof h === 'string' ? /^Bearer ([^\s]+)$/.exec(h) : null;
        token = mm ? mm[1] : null;
        principal = token ? auth.verify(token) : null;
        if (!principal) { if (h !== undefined) auth.fail(ra); throw new HttpError(401, 'unauthorized', 'authentication required', { 'WWW-Authenticate': 'Bearer' }); }
      }
      if (pub) {
        if (req.method !== pub.method) throw new HttpError(405, 'method_not_allowed', 'method not allowed', { Allow: pub.method });
        if (pub.method === 'GET') { // the login page; never consumes the code
          const { html, csp } = loginPage(dashboardUrl.href);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp, 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
          return res.end(html);
        }
        const wait = auth.blocked(ra);
        if (wait) throw new HttpError(429, 'rate_limited', 'too many failed attempts; try again later', { 'Retry-After': String(wait) });
        const body = await jsonBody(req);
        if (!isObj(body)) throw bad('body must be a JSON object');
        exact(body, ['code'], 'exchange');
        const r = auth.exchange(body.code);
        if (!r) { auth.fail(ra); throw new HttpError(401, 'unauthorized', 'authentication required'); }
        return send(res, 200, { token: r.token, token_type: 'Bearer', expires_at: new Date(r.expires_ms).toISOString(), expires_in_s: SESSION_TTL_MS / 1000 });
      }
      if (!match.length) throw new HttpError(404, 'not_found', 'no such route');
      const hit = match.find((x) => x.r.method === req.method);
      if (!hit) throw new HttpError(405, 'method_not_allowed', 'method not allowed', { Allow: [...new Set(match.map((x) => x.r.method))].join(', ') });
      let body;
      if (MUTATING.has(req.method)) body = await jsonBody(req, true);
      const ctx = { req, res, url, query: url.searchParams, params: { ...hit.m.groups }, body, principal, token, stream: null };
      ctx.stream = () => stream(ctx);
      const out = await hit.r.fn(ctx);
      if (out === STREAMING) return;
      if (Array.isArray(out)) return send(res, out[0], out[1]);
      return send(res, 200, out);
    } catch (e) { if (!res.headersSent) sendErr(res, e); else res.end(); } finally { log(`${req.method} ${urlPath} -> ${res.statusCode}`); }
  }

  async function jsonBody(req, allowEmpty = false) {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
    const buf = await readBody(req);
    if (!buf.length) { if (allowEmpty) return undefined; throw bad('empty body'); }
    try { return JSON.parse(buf.toString('utf8')); } catch { throw bad('body is not valid JSON'); }
  }

  const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => { handle(req, res); });
  server.headersTimeout = opts.headersTimeoutMs ?? 10000;
  server.requestTimeout = opts.requestTimeoutMs ?? 15000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  server.on('clientError', (err, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch { /* gone */ } });

  return {
    server, auth,
    get port() { return port; },
    /** Bind 127.0.0.1 only. port 0 (ephemeral) is for tests; the CLI validates 1024-65535 with parsePort. */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { port = server.address().port; server.off('error', reject); resolve(port); });
      });
    },
    close() {
      for (const c of sseClients) { try { c.res.end(); } catch { /* gone */ } }
      return new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
    },
  };
}
