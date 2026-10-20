# AOS orchestrator: engine, supervisor and control server

New here? Start with the top-level [README](../README.md): the three-command quickstart. In this document `aos-orch` is the installed command (`npm link`, see the README); `node orchestrator/bin/aos-orch.mjs` does the same without installing.

A deterministic engine that turns one human-written Goal into merge-ready work on a git branch. Design:
[docs/orchestrator-design.md](../docs/orchestrator-design.md). Verified CLI facts: [spike/README.md](spike/README.md).
The engine is tested against a scripted fake `claude`, which uses zero plan tokens; it has zero npm dependencies
(Node 18+, macOS first).

## How it works

```
aos-orch run goal.json
  create goal dir -> (planner: one Opus call, read-only tools) -> validate plan -> [human approves plan]
  every tick (default 10 s):  Beat -> Observe -> Reap -> Verify -> Plan -> Dispatch -> Budget -> Emit
  dispatch:  ready task -> git worktree + branch aos/<goal>/<task> -> headless worker (own process group)
  reap:      worker result -> engine snapshot (scope check) -> commit -> checks -> merge --no-ff into aos/<goal>/integration
  verify:    goal criteria run on the integration branch; all met -> achieved + report.md
```

- No LLM in the control loop. Only the planner and the workers call a model; every state change is code plus an Event.
- Workers never commit or merge. The engine snapshots the worktree (any file outside `path_scope` fails the attempt),
  commits as `aos-engine`, runs the task's checks with `execFile` (argv, no shell, minimal env, timeout, 64 KB output cap)
  and merges passing branches one at a time. It never touches the base branch, never pushes, and only deletes branches it created.
- Task lifecycle: `pending -> ready -> running -> done | failed`, plus `needs_review` (waiting for a human) and `cancelled`.
  The "checking" and "integrating" steps are `task.orch.phase` values while the AOS-1 status stays `running`.
  Retry ladder `haiku -> sonnet -> opus`, one rung per counted failure, `max_attempts` (default 3); a failure on the top
  tier is final: task `failed`, goal `blocked` with the reason, dependants stay `pending`.
- Not counted as an attempt: plan-limit rejection (governor pauses), a lost worker (engine crash), a task parked in
  `needs_review` for an approval. A `success` exit with `permission_denials` is a failed attempt (retry the same tier once
  with the denial list, then escalate).
- Crash/resume: all state is on disk; `workers/<task>.<n>.pid.json` lets a fresh engine re-adopt a live worker (matched with
  `ps` on the session id) or finish an attempt whose worker already exited with a result. A dead worker with no result
  is marked `lost` and requeued on the same tier without counting. Dispatch writes intent first and spawns second.
- Policy is enforced outside the model: `lib/policy-hook.mjs` is registered through `--settings` for `PreToolUse` and
  `PermissionRequest`. `evaluate(policy, toolCall, ctx)` in `lib/policy.mjs` is a pure function. Order: deny rules, task
  grants, allow rules, ask, default deny. `ask` writes `approvals/<id>.json`, waits up to `approval.wait_in_hook_s`
  (default 20 s) and then denies; the engine moves the task to `needs_review`.
- Governor (`lib/governor.mjs`): no new dispatch at 80% of the 5h window until it resets; pause everything at 90% of the 7d
  window (manual `resume`); a rejected `rate_limit_event` pauses until `resetsAt` plus 60 s; with no reset time it backs off
  15 -> 30 -> 60 -> 240 min. Budgets: new-token cap (soft 80%: no new opus work; hard 100%: stop dispatch, 60 s grace,
  SIGTERM the group), goal wall clock, per-attempt wall clock and stall, max attempts, max ticks, notional USD.

## Commands

```sh
node orchestrator/bin/aos-orch.mjs run <goal.json | goal-id> [--no-wait] [--auto-approve] [--trust-repo-config] [--unsandboxed-checks] [--sandbox-workers] [--poll-ms N] [--interval-s N]
node orchestrator/bin/aos-orch.mjs status [goal-id]
node orchestrator/bin/aos-orch.mjs plan <goal-id>      # read-only: the plan review + rules summary; approves nothing
node orchestrator/bin/aos-orch.mjs pause|resume|cancel|kill|approve-plan|reject-plan <goal-id>
node orchestrator/bin/aos-orch.mjs approvals <goal-id> | approve <goal-id> <A-n> [--for-task] | deny <goal-id> <A-n>
```

`run` stays attached and waits for you whenever a human is needed (plan approval, or a `verify: "human"` criterion): it prints the plan and the exact next commands (`aos-orch plan <id>`, `approve-plan <id>`, `confirm <id> <criterion>`), and the engine runs again only once your own command has been queued from a second terminal (the engine applies that command itself; nothing proceeds without it). `approve-plan` and `confirm` tell you when an attached run will pick the command up. It exits only at `achieved`, `blocked` or `cancelled`. `--no-wait` restores the old behaviour: exit at the first gate and run it again after the decision. Exit codes: 0 achieved, 2 blocked, 3 cancelled, 4 waiting for plan approval (`--no-wait`), 5 goal locked by another engine. Control commands are queued as files in
`<goal>/commands/` and applied by the running engine at its next tick. `cancel` and `kill`
both SIGTERM every worker process group (SIGKILL after the grace period), mark tasks `cancelled` and remove the worktrees.
The real `claude` binary is used only when `AOS_CLAUDE_BIN` is unset. `aos-orch --help` lists every command; an unknown command exits 2.

Goal file (`goal.json`):

```json
{ "id": "g-demo", "title": "...", "description": "...",
  "success_criteria": [{ "id": "c1", "text": "...", "check": { "argv": ["make", "test"], "timeout_s": 300 } }],
  "budget": { "max_ticks": 500, "max_usd": 5, "max_wall_clock_s": 7200 },
  "orch": { "repo": "/abs/path", "base_branch": "main",
            "check_allowlist": ["make test", "node --test"],
            "budgets": { "max_new_tokens": 2000000, "max_parallel": 3, "max_attempts": 3, "max_tasks": 12, "task_wall_clock_s": 900 },
            "approval_policy": { "plan": "required" } },
  "plan": { "tasks": [] } }
```

`plan` is optional and skips the planner (it is validated exactly like a planner plan). `approval_policy.plan` (alias
`orch.plan_approval`) is `required` (default; the run stops at `draft / awaiting_approval` until `approve-plan`) or `auto`,
and `auto` only applies to plans without commands (see [docs/security.md](../docs/security.md)). Other goal fields: `orch.trust_repo_config`,
`orch.unsandboxed_checks`, `orch.check_localhost_ports` (loopback ports checks may connect to), `orch.sandbox_workers`
(opt-in OS sandbox for the worker `claude` processes; CLI `--sandbox-workers`, see [docs/security.md](../docs/security.md), protection 5). Plan checks must match
`orch.check_allowlist` (argv prefix) or a criterion check; unsafe plans (cycles, bad tiers, path scopes outside the repo,
`.git`/`.claude`, dangerous `allowed_commands`, shell/curl-style checks, missing timeouts) are rejected, never repaired.

## Rules

Everything a worker may do and how the engine retries, budgets and stops is one versioned rule set (`docs/rules-design.md`). The
default rules reproduce the engine's original behaviour. Layers, most trusted first: code floor (never overridable), engine defaults,
user `$AOS_ORCH_DIR/rules.json`, the repo's `.aos/rules.json` (read from the base commit, tighten-only unless a human accepts each
loosening), the goal (`orch.rules` plus the legacy goal fields). A lower layer can only tighten; loosenings are listed on the plan
approval screen and the rules hash is bound into the plan approval. Rules are snapshotted per goal (`rules.snapshot.json`) and
re-verified at every dispatch.

```
aos-orch draft "<prompt>" --repo <path> [--out goal.json] [--profile strict|node-library|docs-only] [--answers "..."] [--max-tokens N] [--max-wall-s N] [--tier haiku|sonnet|opus]
aos-orch confirm <goal-id> <criterion-id>
aos-orch rules show [goal-id]          # defaults + user layer, or the goal's snapshot (what the approval screen prints)
aos-orch rules check <file> [--layer user|repo|goal]   # validate a rules file (or, with --layer goal, a whole goal file: its orch.rules) and show what it would change
aos-orch rules explain <goal-id> <task-id> '{"tool_name":"Bash","tool_input":{"command":"ls"}}'   # dry-run the policy: decision + rule id
```

### Prompt to goal (`aos-orch draft`)

`aos-orch draft "add a retry to the fetcher" --repo ~/code/app` makes one model call with no tools (`--tools ""`, one turn, `budgets.draft_usd_cap`
$0.10, tier `plan.draft_tier`, an empty working directory) and prints a draft for review: each criterion with its sandboxed check command
and the allowlist rule that permits it, or `HUMAN REVIEW`, the budgets (each marked as a draft default, proposed by the model, or set by your flag, with the rules' limit), the rules hash and any questions. Drafted goals are small, so unless the model or a flag says otherwise they get 150000 tokens, 1200 s and 2 attempts (never above the rules). `--max-tokens`, `--max-wall-s` and `--tier` only tighten: a value above the rules is refused before any model call; `--tier` caps the tier tasks may start at (a goal-layer `plan.max_start_tier`). It writes `goal.json`
(0600, never overwrites) and creates nothing else; `aos-orch run goal.json` is a separate step. The model output is untrusted and is
validated against the compiled rules: a check argv must already be on the rules' check allowlist (criteria never widen it), budgets may
only be lower than the rules, no rule/trust/sandbox/approval field is accepted, control and bidi characters are rejected, and a draft needs
at least 2 criteria (or a human-review one). A vague prompt returns up to 3 `questions` (exit 3); answer with `--answers` (two rounds at most).
One invalid output is retried once on sonnet. A `verify: "human"` criterion keeps the goal `blocked` ("awaiting human confirmation: c2")
until `aos-orch confirm <goal> c2` (or `POST /api/goals/:id/criteria/:cid/confirm`) once every task is done. A goal made from a draft records
`drafted: true` and `draft_tier` on `goal.created`. On the plan approval screens a profile's own additions to the check allowlist are shown in a separate, labelled block (they are expected, and still listed and hashed); every other loosening stays under `LOOSENINGS YOU ARE APPROVING`. Tasks whose `path_scope` mentions nothing in the goal text are marked `BEYOND THE PROMPT` (a heuristic, informational; `GET /api/goals/:id/plan` tasks carry `beyond_prompt` and `beyond_paths`).

## Security model

See [docs/security.md](../docs/security.md): the enforced protections, the opt-in worker sandbox, and the residual risks.

## State layout

State lives in `$AOS_ORCH_DIR`; by default `~/.aos/orch` (`$XDG_STATE_HOME/aos/orch` when that is set). Older versions kept it inside the dashboard plugin's data folder (`~/.claude/plugins/data/aos-dashboard-aos-local/orch`): if that folder exists and the new default does not, it is still used (one line on stderr says so), so existing goals and the dashboard keep working. `AOS_ORCH_DIR` overrides both. Dirs 0700, files 0600:

```
governor.json  policy.default.json
goals/<goal-id>/
  goal.json tasks.json agents.json heartbeat.json events.ndjson     # AOS-1 files; extensions under an `orch` key
  plan.json  report.md  criteria.json  .tick.lock  attached.json  commands/  tmp/
  approvals/A-<n>.json  approvals/audit.ndjson
  workers/settings.json decisions.ndjson
  workers/<task>.<n>.{pid.json,policy.json,prompt.txt,stream.ndjson,stderr,result.json}   # planner uses task id "planner"
```

Worktrees live outside the repo: `<repo>-aos-worktrees/<goal>/{integration,<task>}`; branches `aos/<goal>/integration` and
`aos/<goal>/<task>` (kept after the run for review; the report lists the exact review and merge commands).

## Modules (`lib/`)

| File | Role |
|---|---|
| `state.mjs` | layout, atomic writes, events (monotonic `seq`), per-goal lock (O_EXCL + pid, stale takeover), command queue, goal spec |
| `schema.mjs` | mini JSON-schema validator + AOS-1 schemas + the design's `orch.*` / `human.approve|deny` event extension |
| `plan.mjs` | planner prompt (`AOS_PLANNER` marker), JSON extraction, strict validation, task construction |
| `policy.mjs`, `policy-hook.mjs` | pure policy function, and the hook executable (verified JSON decision shapes, fails closed) |
| `approvals.mjs` | file inbox: create (O_EXCL), decide, expire (timeout = deny), audit log |
| `governor.mjs` | rate-limit parsing, thresholds, backoff, limit-failure matcher (UNVERIFIED), budgets |
| `worker.mjs` | command line (spike-verified flags only), minimal env, detached spawn, stream-json tail, process-group kill |
| `git.mjs`, `checks.mjs` | execFile-only git helpers; check runner (sandboxed by default) |
| `sandbox.mjs` | `sandbox-exec` probe, static deny-default profiles (checks; opt-in workers), `-D` parameter builder |
| `repo-config.mjs` | scan for hostile repo Claude Code config; CLAUDE.md hashing |
| `engine.mjs`, `report.mjs` | the tick, lifecycle, recovery, cancel, final report |

## Tests

```sh
node --test 'orchestrator/test/*.test.mjs'
npm test         # the same, ~2 min on a laptop, zero model calls (there is no Makefile)
```

Tests run the engine against `test/fake-claude.mjs` (`AOS_CLAUDE_BIN`, scenario in `AOS_FAKE_SCENARIO`) in throwaway git
repos under `$TMPDIR`. They cover: happy path with a 3-task DAG, retry/escalation, plan validation, plan approval and
idempotent ticks, rate-limit pause/resume and the utilisation reserve (injected clock), budgets (dispatch stop and kill
after grace), wall-clock kill with SIGKILL escalation, parallelism cap and scope overlap, crash/resume (re-adopt, lost
worker), cancel/kill switch, pause/resume, locking, policy hook (table-driven plus real runs), approvals (granted, timeout
= deny, expiry), scope violation, merge conflict, worker command line and env, event-log validity; `hardening.test.mjs` (no code execution via the allowlist, hostile repo configs,
CLAUDE.md hash, plan approval gate and hash binding) and `sandbox.test.mjs` (macOS only, skipped elsewhere: write/read/network
denials with canary files, private TMPDIR, timeouts, output cap, static profile with hostile worktree paths, refusal without the sandbox) and `worker-sandbox.test.mjs` (macOS only: worker
profile write allow/deny matrix with `/bin/sh` probes, engine and CLI `--sandbox-workers` with the fake claude and an allow-all hook
proving a shell write to the main repo fails, refusal without `sandbox-exec`).
Note: the engine tests use a stand-in for the human (`helpers.humanApproves`) because plans with node checks no longer auto-approve.

## Not done yet

- Control UI and monitor integration (goal hub, DAG, meters) and the telemetry hook (`aos-hook.mjs` tagging) live in the dashboard repo.
- Real-claude coverage is thin (10 real runs, see the top README). Unverified: OAuth with the minimal env, the real
  plan-limit failure text (the matcher is a configurable guess), `--setting-sources ""`, `--resume` for approval
  continuations, planner `--json-schema`.
- `aos` CLI integration (`scripts/aos.mjs`), `schemas/orch-task.schema.json` (validation lives in `lib/plan.mjs`).
- The planner call is not counted against the global worker cap; only task workers are.

## Supervisor and control server

```sh
node orchestrator/bin/aos-orch.mjs serve [--port 4319] [--max-workers 3] [--dashboard-url http://127.0.0.1:4318/] [--origins a,b]
                                         [--leave-workers | --kill-workers] [--drain-s 30]    # env: AOS_ORCH_PORT, AOS_ORCH_ORIGINS, AOS_DASHBOARD_URL
node orchestrator/bin/aos-orch.mjs login-link [--port N]   # prints a one-time browser login URL (valid 2 minutes)
node orchestrator/bin/aos-orch.mjs token [--show]          # prints the token FILE path; the token itself only with --show
node orchestrator/bin/aos-orch.mjs goals [--json]
```

`lib/supervisor.mjs`: one process, one engine tick loop per non-terminal goal found in `AOS_ORCH_DIR/goals` (rescanned every 2 s;
a goal owned by another live engine is skipped). A global slot gate (`max_workers_global` in `<orch>/config.json` or `--max-workers`,
default 3) is consulted by every engine before it starts a worker: reservations are counted, and a goal may only take a free slot if no
other goal that was recently denied (or has a ready task) runs fewer workers (least-running-first, so one goal cannot starve others).
The plan-usage governor is the shared `governor.json` (7-day hold pauses all goals until a human `resume`, 5-hour reserve stops new
work, rejected calls pause until the reset); the gate checks it too. Shutdown (SIGTERM/SIGINT): stop dispatching, then `drain` (default:
workers finish and are merged, up to `--drain-s`, the rest are killed), `--kill-workers` or `--leave-workers`; state stays resumable
(a killed worker is `lost` and requeued uncounted; a left one is re-adopted). `setBudgets` + `resume` unblock a goal that was blocked by a
budget cap (`orch.budgets.updated` / `orch.goal.unblocked` events); other blocks (failed task, rejected plan) are not resumable.

### Control server (`server/`, HTTP on 127.0.0.1 only)

Request pipeline: loopback peer -> `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (else 403, DNS rebinding) -> if `Origin` is
present it must be `http://127.0.0.1:4318`, `http://localhost:4318`, the dashboard URL's origin, an `--origins` entry or the server's own origin
(else 403); CORS headers (`Access-Control-Allow-Origin: <that origin>`, `Access-Control-Allow-Headers: Authorization, Content-Type`, `Vary: Origin`,
never `*`) only for allowed origins; preflight `OPTIONS` answers 204 for GET/POST/PATCH with those two headers only -> `/api/*` needs `Authorization: Bearer <token>`
(401 with one uniform body whatever the failure; routes are not revealed to unauthenticated callers) -> mutations need `Content-Type: application/json`
(415 otherwise, so form posts are refused) and a body of at most 64 KB (413) -> handler. Header timeout 10 s, request timeout 15 s. 10 failed
credentials per minute lock the IP out (429, `Retry-After`, doubling up to 15 min). No cookies anywhere. Logs contain `METHOD path status` only (no query string, no tokens).

Credentials: the CLI token (`<orch>/control-token`, 32 random bytes hex, 0600, dir 0700, constant-time compare, persists across restarts) and browser
session tokens (random, 12 h, MEMORY ONLY: a server restart needs a new `login-link`; revocable with `POST /auth/logout`). `aos-orch login-link` writes
a hashed single-use code (2 minutes) under `<orch>/login-codes/` and prints `http://127.0.0.1:<port>/auth/login?code=...`. `GET /auth/login` only serves a tiny
page (strict CSP, `Referrer-Policy: no-referrer`) and does NOT consume the code; the page removes the code from the address bar, POSTs it to `/auth/exchange`
and redirects to the dashboard (default `http://127.0.0.1:4318/`, `--dashboard-url`) with the session in the URL FRAGMENT: `#aos_token=<session>`. The
dashboard reads `location.hash`, stores it in `sessionStorage`, clears the hash and sends it as `Authorization: Bearer`. `EventSource` cannot set headers,
so the UI should poll `GET /api/goals` and `/api/goals/:id/events?after=`; `GET /api/stream` (SSE, header auth) exists for fetch-streaming clients.

Endpoints (all JSON; errors are `{error:{code,message}}`; unknown route 404, wrong method 405):

| Method and path | Notes |
|---|---|
| `GET /auth/login?code=` | login page, no state change |
| `POST /auth/exchange` `{code}` | -> `{token, token_type, expires_at, expires_in_s}` |
| `POST /auth/logout` | revokes the calling session |
| `GET /api/health` | `{ok, version, goals, workers:{running,max}, governor:{five_hour, seven_day, paused, resume_at, reason}}` (utilisation 0..1 or null) |
| `GET /api/goals` | `{goals:[GoalSummary]}` |
| `POST /api/goals` | body per the brief; 201 `{goal: GoalDetail, notices}`; 400 invalid, 422 repo/config refusal. Extension: optional `check_allowlist:[string]` (commands the planner may use in checks; without it a planned goal cannot have checks). `plan_approval` may only be `"human"`; criteria are `{text}` (met when all tasks are done), or `{text, check:{argv,timeout_s}}` (the argv must already be allowed by the rules or by `check_allowlist` in the same body: 422 `criterion_refused` otherwise), or `{text, verify:"human"}`. Optional `profile` and `drafted:{tier}` |
| `POST /api/goals/draft` `{prompt, repo, profile?}` | 200 `{draft, errors, questions, rules_hash, draft_tier}`. One no-tools model call; **creates no goal** (only `POST /api/goals` does). Same auth as goal creation; 6 per minute per session, then 429 |
| `POST /api/goals/:id/criteria/:cid/confirm` | a human confirms a `verify:"human"` criterion (only once every task is done); 409 otherwise; audited |
| `GET /api/goals/:id` | `{goal: GoalDetail}` |
| `POST /api/goals/:id/pause\|resume\|cancel\|kill` | kill needs `{confirm:true}`; 200 `{goal, applied}`; 409 on terminal / not-resumable goals |
| `PATCH /api/goals/:id/budgets` | any of `max_new_tokens max_wall_s max_parallel max_attempts` (+ `max_usd max_ticks`); integers in closed ranges |
| `GET /api/goals/:id/plan` | `{plan_state, plan_hash, tasks:[{id,title,tier,depends_on,path_scope,allowed_commands,checks:[{cmd,argv,timeout_s}],allowed_tools}]}` |
| `POST /api/goals/:id/plan/approve` `{plan_hash}` / `plan/reject` `{reason}` | `plan_hash` binds plan.json and the task commands/scopes; a stale hash is 409 |
| `GET /api/goals/:id/events?after=&limit=` | `{events, next_after, has_more}`, limit 1-500 |
| `GET /api/approvals[?status=pending\|approved\|denied\|expired\|all]` | default pending |
| `POST /api/approvals/:id/approve\|deny` `{scope?:'once'\|'task'}` | approval ids are goal-qualified: `<goal_id>~A-<n>` |
| `GET /api/stream[?goal=]` | SSE `goal_event` messages, header auth only |

GoalSummary/GoalDetail follow the brief; additive extras: `paused`, `blocked_reason`. Responses never contain filesystem paths: `repo_name` is a basename,
engine free text is scrubbed (absolute paths become basenames), approval `cwd` is relative to the worktree. Documented exception: an approval's `summary`
is the exact command / file the worker asked for (a human cannot approve blind; only the worktree prefix is replaced by `<worktree>`), and plan `checks`/`allowed_commands`
are shown verbatim for the same reason.
Audit: every mutating call appends a `human.note` Event with actor `control` and `data {audit:true, action, session}` (`cli` or a hash of the session id, never a token) to
the goal's `events.ndjson`, in addition to the engine's own `human.*` events; refused attempts are recorded too.
