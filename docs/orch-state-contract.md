# Orchestrator state contract (what the dashboard relies on)

The dashboard monitor (`monitor.mjs` in https://github.com/tomtomsatnav/agent-orchestration-standard, port 4318) never imports or calls the orchestrator. Its whole coupling is the files below, the
hook env tags, and two ports. Anything that writes this layout (this engine, or any other orchestrator) is compatible. Source of truth for the mapping: the comment block above `loadGoalEntry` in `monitor.mjs`.

## On-disk layout (read-only for the monitor)

Root: `$AOS_ORCH_DIR`, else `$XDG_STATE_HOME/aos/orch` (when set) or `~/.aos/orch`. Readers must also look in the legacy root `${CLAUDE_PLUGIN_DATA:-~/.claude/plugins/data/aos-dashboard-aos-local}/orch`: the orchestrator keeps using it when it exists and the new root does not.
Goals: `<root>/goals/<gid>/`, `gid` matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (others are ignored). Only dirs containing a
parseable `goal.json` count; the 50 most recently modified `goal.json` are read. Files are size-capped (2 MB), cached by
mtime+size, rescanned at most once a second. A partial/corrupt write keeps the last good data; a missing file = empty.

| File | Read as | Fields used |
|---|---|---|
| `goal.json` (object) | goal | `title`, `description`, `status` (`achieved\|failed\|cancelled` are terminal), `created_at`, `updated_at`, `blocked_reason`, `success_criteria[{id,text,met}]`, `budget.max_wall_clock_s`, `orch.repo` (absolute; only its basename is exposed, and it maps tagged workers to a project), `orch.plan_state` (`planning\|awaiting_approval\|approved\|rejected\|none`; `supplied` -> `planning`; unknown -> `none`), `orch.plan_awaiting_since_ms`, `orch.paused_reason`, `orch.resume_at`, `orch.started_ms`, `orch.budgets.{max_new_tokens,max_parallel,max_attempts}`, `orch.usage.{new_tokens,notional_usd}` |
| `tasks.json` (array, max 200) | tasks | `id`, `title`, `status` (`done\|failed\|cancelled\|needs_review\|running\|ready\|...`), `depends_on[]`, `attempts`, `max_attempts`, `orch.{phase,model_tier,branch,last_failure{kind,note},tokens.new}`, `orch.attempt_log[{tier,started_at,ended_at,new_tokens,notional_usd,checks_ok,counted}]` |
| `events.ndjson` | last 25 lines (tail read of 256 KB; partial/bad lines dropped) | `type`, `ts`, `task_id`, `data.{reason,error,msg,title,status,plan_state,tier,attempt,outcome,rule,label,tool,exit_code,kind,cause,ok}` (first 4 scalar values become `text`) |
| `approvals/A-<n>.json` | pending approvals | `status === 'pending'`, `task_id`, `requested_at` (else file mtime) |

Free text is scrubbed (absolute paths and token-like strings removed) and length-capped before leaving the process.

## Worker env tags (set by the engine, read by `hooks/aos-hook.mjs`)

`AOS_GOAL_ID`, `AOS_TASK_ID`, `AOS_ATTEMPT`, `AOS_WORKTREE` are set in each worker's environment. The hook records only
`AOS_GOAL_ID` -> `gid` and `AOS_TASK_ID` -> `tid` into `hook-events.ndjson`, and only if they match `^[A-Za-z0-9._-]{1,64}$`;
no other env value is read. The monitor uses `gid`/`tid` to tag agents (`goal_id`, `task_id`, `goal_title`), group them under
the goal's repo (`orch.repo` basename) instead of the worktree, and count `workers` (running tagged agents) per goal.
`AOS_ATTEMPT` and `AOS_WORKTREE` are consumed by the orchestrator's own policy hook, not by the dashboard.

## Ports, CORS, login

- Monitor `127.0.0.1:4318` (override `PORT`): read-only. `Host` and any `Origin` must be `127.0.0.1` or `localhost` (any port), else 403.
  Non-GET/HEAD -> 405. No CORS headers are sent. Responses carry `nosniff`, `no-store`, `no-referrer`, `X-Frame-Options: DENY`.
- Control server `127.0.0.1:4319` (orchestrator-owned, not required by the monitor): browser login is `aos-orch login-link`, which prints
  `/auth/login?code=<one-time code>` (code valid 2 min, stored hashed, consumed once). The login page POSTs the code to `/auth/exchange`
  and receives a session token; every later call sends `Authorization: Bearer <session token>` (CLI uses a token file instead). Session
  tokens live in server memory only, last 12 h, and at most 50 are kept (oldest evicted). No cookies and no CSRF header. CORS answers only
  dashboard origins and allows only the `Authorization` and `Content-Type` request headers. The UI (`ui/orch.js`) calls it directly with
  `mode: cors`; override with `<html data-aos-control-url>`. The monitor only links to it and the token never goes to 4318.

## HTTP shapes

- `GET /api/goals` -> `{ "goals": [GoalSummary] }` (max 50, newest `updated_at` first; each includes `workers`).
- `GET /api/goals/<gid>` -> `{ "goal": GoalDetail }` (wrapper key is `goal`; the UI reads `j.goal`). 404 for unknown/invalid id, 400 for bad URL encoding.
- `GET /api/state` also carries `goals` (max 20 summaries); replay (`?at=`) omits `goals`.
- GoalSummary: `id, title, status, repo_name, created_at, updated_at, plan_state, paused_reason, resume_at, blocked_reason,
  budget{max_new_tokens,used_new_tokens,max_wall_s,used_wall_s,max_parallel,running,max_attempts}, tasks_total, tasks_done,
  tasks_failed, approvals_pending, workers, outcome{merged,discarded,tokens_per_accepted,cost_usd,waiting_s,waiting_on}`.
- GoalDetail = summary + `description, criteria[{id,text,met}], last_events[{type,ts,task_id,text}], tasks[{id,title,status,phase,
  tier,depends_on,attempts,max_attempts,branch,ran_s,new_tokens,check_summary,outcome,retries,tier_path,cost_usd,waiting_s,
  waiting_for_human,error?}]`. No absolute path appears in any response.

## Tests

`tests-monitor/` runs against golden goal dirs in `tests-monitor/fixtures/` and has no orchestrator import. To regenerate them
(needs the engine checked out), see `tests-monitor/fixtures/README.md`.

## Coupling note

`goalOutcome` in `monitor.mjs` counts plan waiting time (`waiting_on: plan`) only while the goal `status` is `draft`. This is coupled to the engine: an orchestrator that leaves `plan_state: awaiting_approval` set after the goal leaves `draft` will not show that wait.
