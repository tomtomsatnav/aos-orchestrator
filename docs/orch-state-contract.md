# Orchestrator state contract (what the dashboard relies on)

The dashboard monitor (`monitor.mjs` in https://github.com/tomtomsatnav/agent-orchestration-standard, port 4318) never imports or calls the orchestrator. Its whole coupling is the files below, the
hook env tags, and two ports. Anything that writes this layout (this engine, or any other orchestrator) is compatible. Source of truth for the mapping: the comment block above `loadGoalEntry` in `monitor.mjs`.

## On-disk layout (read-only for the monitor)

Root: `$AOS_ORCH_DIR`, else `$XDG_STATE_HOME/aos/orch` (when set) or `~/.aos/orch`. Readers must also look in the legacy root `${CLAUDE_PLUGIN_DATA:-~/.claude/plugins/data/aos-dashboard-aos-local}/orch`: the orchestrator keeps using it when it exists and the new root does not.
Goals: `<root>/goals/<gid>/`, `gid` matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (others are ignored). Only dirs containing a
parseable `goal.json` count; the 50 most recently modified `goal.json` are read. Files are size-capped (2 MB), cached by
mtime+size, rescanned at most once a second. A partial/corrupt write keeps the last good data; a missing file = empty.

Archived goals: `aos-orch archive` moves a goal dir to `<root>/archive/goals/<gid>/` (atomic rename; `unarchive` moves it back). The monitor/dashboard reads only `<root>/goals/`, never `archive/`, so archived goals are absent from GOALS and "Needs you".

| File | Read as | Fields used |
|---|---|---|
| `goal.json` (object) | goal | `title`, `description`, `status` (`achieved\|failed\|cancelled` are terminal), `created_at`, `updated_at`, `blocked_reason`, `success_criteria[{id,text,met}]`, `budget.max_wall_clock_s`, `orch.repo` (absolute; only its basename is exposed, and it maps tagged workers to a project), `orch.plan_state` (`planning\|awaiting_approval\|approved\|rejected\|none`; `supplied` -> `planning`; unknown -> `none`), `orch.plan_awaiting_since_ms`, `orch.paused_reason`, `orch.resume_at`, `orch.started_ms`, `orch.budgets.{max_new_tokens,max_parallel,max_attempts}`, `orch.usage.{new_tokens,notional_usd}` |
| `tasks.json` (array, max 200) | tasks | `id`, `title`, `status` (`done\|failed\|cancelled\|needs_review\|running\|ready\|...`), `depends_on[]`, `attempts`, `max_attempts`, `orch.{phase,model_tier,branch,last_failure{kind,note},tokens.new}`, `orch.attempt_log[{tier,started_at,ended_at,new_tokens,notional_usd,checks_ok,counted,anticheat?}]` |
| `events.ndjson` | last 25 lines (tail read of 256 KB; partial/bad lines dropped) | `type`, `ts`, `task_id`, `data.{reason,error,msg,title,status,plan_state,tier,attempt,outcome,rule,label,tool,exit_code,kind,cause,ok}` (`orch.anticheat.*` events use `kind` and `reason`) (first 4 scalar values become `text`) |
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

## Anti-cheat fields (additive, optional)

`tasks.json` `orch.attempt_log[].anticheat` (present once the attempt reached verification): `{ status: "pass"|"warn"|"fail", failed: <kind>|null, findings: [{kind, severity: "fail"|"warn"|"allowed", path?, detail}] (max 20), tests: [{check, tests, pass, skipped, todo, baseline}] }`.
`kind` is one of `vacuous_pass`, `tests_reduced`, `tests_skipped`, `check_config_changed`, `tests_deleted`, `acceptance_modified`, `acceptance_empty`, `literal_copy`, `harness_tamper`, `tests_weakened`; a failed attempt also has `attempt_log[].outcome` equal to that kind (and `orch.last_failure.kind`). `severity: "allowed"` means a rule fired but a human-approved plan field (`allow_skip`, an explicit config file in `path_scope`) let it through; `warn` is advisory.
`goal.json` `orch.anticheat`: `{ baselines: {<check argv>: {tests, source: "run"|"static", at}}, criteria: {<criterion id>: {kind, reason}}, acceptance?: {items: [{task, files[], commit}]}, acceptance_result?: {ok, files, tests, output?}, disputes?: {<acceptance task id>: {state: "open"|"revised"|"unchanged"|"refused", impls[], files[], from_commit, to_commit?, from_tier, tier, reason?, stat?, diff?, reply?, impl_note?}} }`. During a dispute the acceptance task has `orch.dispute` and each waiting implementation task `orch.awaiting_dispute` (status `pending`).
Events: `orch.anticheat.baseline`, `.passed`, `.warning`, `.failed` (`data.kind`, `data.reason`), `.acceptance`; `orch.acceptance.disputed`, `.revised` (`data.diff_stat`), `.upheld`, `.revision_refused`; `orch.plan.acceptance_tier`. The control server's status JSON has `anticheat: {failures: {<kind>: n}, warnings, allowed, baselines, acceptance, criteria}`. `report.md` has an "Anti-cheat" section.

## Run record fields (additive, optional)

Written by the engine, not read by the monitor. Every field here may be absent (older goals, a feature off, or a step not reached) and may be `null`; readers must tolerate both.

`goal.json` `orch.claude_version_start`: string, the `claude --version` first line seen at the goal's first attempt start (max 80 chars, non-printable characters become `?`). Set once and never overwritten; absent when the probe failed.
`tasks.json` `orch.attempt_log[].claude_version`: same format, the version probed for that attempt; `null` when the probe failed. The probe is cached per engine start, so values change only across engine restarts. `report.md` warns when a later attempt's version differs from `claude_version_start`.
`tasks.json` `orch.attempt_log[].self_checks`: `{ runs, capped, ms, output_bytes, max }`, written when the attempt ends and only if the attempt had self-checks set up (rules `worker.self_check` on and the task has approved checks). `runs` = engine-run self-checks, `capped` = requests refused past `max`, `ms` and `output_bytes` = totals, `max` = `worker.self_checks_max` in force.
Events (`events.ndjson`, `data` only; the monitor's `data` list above does not include them, so they show only through the first-4-scalars text rule): `orch.check.self_run` `{attempt, run, max, argv (max 300 chars), ok, exit_code, timed_out, sandboxed, duration_ms, output_bytes, refused? (max 200 chars)}`, emitted after each engine self-check including refused ones; `orch.check.self_capped` `{attempt, max}` when a request arrives past `max`; `orch.check.self_flooded` `{attempt, bad, capped, max}` when an attempt's inbox exceeds `max + 16` bad or surplus requests, after which it is no longer serviced. Self-check output is advisory: the engine still runs every check itself afterwards.
`tasks.json` `orch.attempt_log[].base_sha`: the 40-hex integration-branch commit the attempt's fresh branch started from. Every attempt (retries included) drops the previous attempt's worktree and branch and branches anew from the current integration tip, so a retry sees everything merged since.
`goal.json` `orch.plan_warnings[<task>]` may hold a `WHOLE-SUITE CHECK: ...` note: the task's check runs the whole test suite (`npm test`, `node --test` without files or with a directory/glob), so the engine added every other code-changing task as a dependency at plan time (event `orch.plan.deps_added` `{added[], rule}`); a plan where that is impossible is rejected.
`tasks.json` `orch.attempt_log[].stderr_tail`: string, the last 20 lines and at most 2000 chars of the worker's stderr (control characters escaped, lines cut at 300 chars). Written at attempt end only when stderr is non-empty and the attempt had no result, `is_error`, or a non-zero exit code.
Status output `task_list[].last_stderr` and `last_stderr_outcome`: computed on read by `summarize()` (not stored in `tasks.json`) from the newest attempt with a `stderr_tail`. Only for tasks not `done`; absent when no attempt has one. `last_stderr_outcome` is that attempt's `outcome` (may be `null`).
`goal.json` `orch.protected_result`: `{ ok, files, not_executed[], at, output?, kind? }`. `files` = number of JS protected test files run; `not_executed` = up to 20 protected paths with no runner (non-JS). `ok: false` blocks the goal with the original-tests reason (`goal.status` `blocked`). `output` (max 600 chars) is present on failure; `kind` only for `harness_tamper` or an anti-cheat per-file kind. Written at verify whenever `orch.protected_tests.files` is non-empty, and overwritten on each run; absent when protection is off or it has not run yet.
`goal.json` `orch.review`: `{ tier, text, error, new_tokens, notional_usd, at }`. Advisory only (rules `review.advisory: true`), written once when the goal reaches `achieved`. `text` = sanitized reviewer notes (max 3000 chars), `null` on error; `error` = string, `null` on success. Never changes task or goal status; its tokens and cost are added to `orch.usage`. Event `orch.review.advisory` `{tier, ok, error, new_tokens}`. Shown in `report.md` only.

## Tests

`tests-monitor/` runs against golden goal dirs in `tests-monitor/fixtures/` and has no orchestrator import. To regenerate them
(needs the engine checked out), see `tests-monitor/fixtures/README.md`.

## Coupling note

`goalOutcome` in `monitor.mjs` counts plan waiting time (`waiting_on: plan`) only while the goal `status` is `draft`. This is coupled to the engine: an orchestrator that leaves `plan_state: awaiting_approval` set after the goal leaves `draft` will not show that wait.
