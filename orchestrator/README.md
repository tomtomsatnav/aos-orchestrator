# AOS orchestrator: engine core (phase 1)

A deterministic engine that turns one human-written Goal into merge-ready work on a git branch. Design:
[docs/orchestrator-design.md](../docs/orchestrator-design.md). Verified CLI facts: [spike/README.md](spike/README.md).
Phase 1 is the engine only: it is tested against a scripted fake `claude`, uses zero plan tokens and zero npm dependencies
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
node orchestrator/bin/aos-orch.mjs run <goal.json | goal-id> [--auto-approve] [--poll-ms N] [--interval-s N]
node orchestrator/bin/aos-orch.mjs status [goal-id]
node orchestrator/bin/aos-orch.mjs pause|resume|cancel|kill|approve-plan|reject-plan <goal-id>
node orchestrator/bin/aos-orch.mjs approvals <goal-id> | approve <goal-id> <A-n> [--for-task] | deny <goal-id> <A-n>
```

`run` exits 0 achieved, 2 blocked, 3 cancelled, 4 waiting for plan approval. Control commands are queued as files in
`<goal>/commands/` and applied by the running engine at its next tick (no HTTP server in this phase). `cancel` and `kill`
both SIGTERM every worker process group (SIGKILL after the grace period), mark tasks `cancelled` and remove the worktrees.
The real `claude` binary is used only when `AOS_CLAUDE_BIN` is unset.

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

`plan` is optional and skips the planner (it is validated exactly like a planner plan). `approval_policy.plan` is
`required` (default; the run stops at `draft / awaiting_approval` until `approve-plan`) or `auto`. Plan checks must match
`orch.check_allowlist` (argv prefix) or a criterion check; unsafe plans (cycles, bad tiers, path scopes outside the repo,
`.git`/`.claude`, dangerous `allowed_commands`, shell/curl-style checks, missing timeouts) are rejected, never repaired.

## State layout

`AOS_ORCH_DIR` (default `${CLAUDE_PLUGIN_DATA or ~/.claude/plugins/data/aos-dashboard-aos-local}/orch`), dirs 0700, files 0600:

```
governor.json  policy.default.json
goals/<goal-id>/
  goal.json tasks.json agents.json heartbeat.json events.ndjson     # AOS-1 files; extensions under an `orch` key
  plan.json  report.md  criteria.json  .tick.lock  commands/  tmp/
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
| `git.mjs`, `checks.mjs` | execFile-only git helpers; check runner |
| `engine.mjs`, `report.mjs` | the tick, lifecycle, recovery, cancel, final report |

## Tests

```sh
node --test orchestrator/test/engine.test.mjs orchestrator/test/policy.test.mjs orchestrator/test/units.test.mjs orchestrator/test/cli.test.mjs
make test        # includes the line above; ~35 s, zero model calls
```

Tests run the engine against `test/fake-claude.mjs` (`AOS_CLAUDE_BIN`, scenario in `AOS_FAKE_SCENARIO`) in throwaway git
repos under `$TMPDIR`. They cover: happy path with a 3-task DAG, retry/escalation, plan validation, plan approval and
idempotent ticks, rate-limit pause/resume and the utilisation reserve (injected clock), budgets (dispatch stop and kill
after grace), wall-clock kill with SIGKILL escalation, parallelism cap and scope overlap, crash/resume (re-adopt, lost
worker), cancel/kill switch, pause/resume, locking, policy hook (table-driven plus real runs), approvals (granted, timeout
= deny, expiry), scope violation, merge conflict, worker command line and env, event-log validity.

## Not done yet

- Control server (`127.0.0.1:4319`), token/cookie auth, HTTP approvals API, SSE events: phase 3.
- Control UI and monitor integration (goal hub, DAG, meters); the telemetry hook (`aos-hook.mjs` tagging): phases 2 and 4.
- Real-claude runs: nothing here has ever called the real binary. Unverified: OAuth with the minimal env, the real
  plan-limit failure text (the matcher is a configurable guess), `--setting-sources ""`, `--resume` for approval
  continuations, planner `--json-schema`.
- One engine per goal and per process; the global worker semaphore across goals, goal creation via API, `aos` CLI
  integration (`scripts/aos.mjs`), `schemas/orch-task.schema.json` (validation lives in `lib/plan.mjs`).
- Resuming a `blocked` goal after raising a budget (re-run is only supported for active/draft/paused goals).
