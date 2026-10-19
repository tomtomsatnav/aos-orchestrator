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
node orchestrator/bin/aos-orch.mjs run <goal.json | goal-id> [--auto-approve] [--trust-repo-config] [--unsandboxed-checks] [--poll-ms N] [--interval-s N]
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

`plan` is optional and skips the planner (it is validated exactly like a planner plan). `approval_policy.plan` (alias
`orch.plan_approval`) is `required` (default; the run stops at `draft / awaiting_approval` until `approve-plan`) or `auto`,
and `auto` only applies to plans without commands (see Security model). Other goal fields: `orch.trust_repo_config`,
`orch.unsandboxed_checks`, `orch.check_localhost_ports` (loopback ports checks may connect to). Plan checks must match
`orch.check_allowlist` (argv prefix) or a criterion check; unsafe plans (cycles, bad tiers, path scopes outside the repo,
`.git`/`.claude`, dangerous `allowed_commands`, shell/curl-style checks, missing timeouts) are rejected, never repaired.

## Security model (what is enforced now, what is not)

Enforced by code and covered by tests:

1. **Workers cannot run code.** The default allowlist is read-only inspection (`ls cat head tail wc grep rg find -name diff`,
   `git status|diff|log|show`) plus Read/Glob/Grep and Edit/Write inside `path_scope`. `lib/policy.mjs` hard-denies (no approval
   possible) interpreters, shells, package/build/test runners (`node npm npx pnpm yarn make python* ruby perl cargo go ...`),
   wrappers (`env xargs timeout nohup ...`), `eval/source`, `find -exec`, `rg --pre`, and git subcommands that run hooks, filters or
   aliases (`add commit checkout merge rebase stash ...`), even when allowlisted, granted, or re-added by a policy file.
   `validatePlan` REJECTS a plan whose `allowed_commands` contain any of them (the error names the entry). The planner prompt says
   so: verification belongs in each task's `checks`, which only the engine runs.
2. **Untrusted repo configuration is refused.** `createGoal` (so `aos-orch run goal.json`) refuses a repo whose
   `.claude/settings.json`, `settings.local.json` or other `settings*.json` (scanned from the given path up to the git root) define hooks,
   permissions, env, MCP servers, `apiKeyHelper`, `statusLine`, plugins or any unvetted key, that has a non-empty `.mcp.json`, or has
   non-empty `.claude/{hooks,commands,agents,skills}`. `--trust-repo-config` / `orch.trust_repo_config` overrides it and is recorded in
   `goal.json` and the event log with a warning. The integration checkout is re-scanned before every dispatch and before each merge, so a
   commit that adds such config later blocks the goal. `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` are not refused (trusted input):
   their sha256 (committed content at `base_commit`) goes into `goal.json` (`orch.instructions`), a notice
   `repo instructions will be loaded by workers: <path> <sha256 prefix>` is printed, and if the content on the integration branch differs at
   dispatch from what the engine last recorded, the task is failed without running; only the engine's own merges move the recorded hash.
   Workers always get `--setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools ...`.
3. **Plans with commands need a human.** A plan containing any `checks` command outside the vetted list, or any `allowed_commands`
   entry, always stops at `awaiting_approval` even with `--auto-approve` / `plan_approval: "auto"`. The vetted list is `grep`, `test`,
   `diff`, `cmp` (bare names or `/usr/bin|/bin/<name>`); `make test`, `node --test <glob>`, npm, pytest and the rest run worker-written
   code and are never auto-approvable. `aos-orch status|approvals|approve-plan` print each task's exact commands, model tier and path scope
   in plain text (on stderr; stdout stays JSON). The approval record (`orch.plan_approval`) stores sha256 hashes of `plan.json` and of the
   task commands/scopes; `approve-plan` carries the hash the human saw and is refused if the plan differs; every dispatch and every
   verification re-checks the hashes, so an edit after approval blocks the goal (`orch.plan.tampered`).
4. **Checks are sandboxed** (`lib/sandbox.mjs`, macOS `sandbox-exec`, deny-default profile written to `<goal>/sandbox/`). A check may read
   system and toolchain locations (`/usr /bin /sbin /System /Library /opt/homebrew`, the node install prefix, `~/.npm`), its worktree and its
   private TMPDIR (`<goal>/tmp/<task>/check-N`, removed afterwards); it may write only the worktree, that TMPDIR and `/dev/null`; all
   network is denied (loopback only for `orch.check_localhost_ports`); reads of `~/.ssh ~/.aws ~/.config ~/.claude ~/.gnupg`, keychains,
   shell history, other worktrees and the engine's goal/approvals/policy directories are denied. Paths reach the profile only as `-D`
   parameters through `execFile` (the profile text is static). If `sandbox-exec` is missing or fails its probe, checks are refused and
   the goal blocks before dispatch unless `orch.unsandboxed_checks` is set (recorded, warned, event-logged).

Residual risks (honest list):

- **Workers (`claude` itself) are NOT OS-sandboxed in this phase.** They are constrained only by the policy hook (PreToolUse and
  PermissionRequest) and the isolation flags, and the hook is a heuristic shell parser: an unparsed construct is `ask`, not proof of safety.
  A worker still holds Edit/Write inside its scope, and anything it writes is later executed by the sandboxed checks.
- The sandbox is defense in depth, not proof: `sandbox-exec` is deprecated and its profile language undocumented; a kernel or sandbox bug
  defeats it. It does not limit CPU, memory, disk use inside the worktree or processes (only the timeout and the group kill do).
  `file-read-metadata` is allowed everywhere, so a check can `stat` (not read or list) paths such as `~/.ssh`. Mach lookups are allowed
  (node and system tools need them), so local services reachable through Mach/XPC are not blocked. Git commands inside a check cannot read
  the main repository's `.git` (outside the worktree).
- The CLAUDE.md hash covers committed content of the repo root files only (not ancestor directories of the worktree, not user-level
  memory); `--setting-sources` is `project`, which still loads the repo's project settings (that is why the scan exists);
  `--setting-sources ""` remains unverified. `git diff/log/show` can invoke textconv/external-diff drivers defined in the repository's own
  git config, which is trusted. A trusted-repo override (`--trust-repo-config`) removes protection 2.
- Auto-approval of command-free plans still trusts the vetted check list; a `grep` check can read any file inside its sandbox.
- macOS-version quirks seen on macOS 27 (Darwin 27.0.0): the profile needs `process-exec*`, `process-fork` and read access to the node
  prefix; node aborts at startup if its current directory is not readable (cwd must be inside the allowed worktree); the symlinked
  `/tmp` and `/var` must be passed as real paths (the builder resolves them).

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
| `git.mjs`, `checks.mjs` | execFile-only git helpers; check runner (sandboxed by default) |
| `sandbox.mjs` | `sandbox-exec` probe, static deny-default profile, `-D` parameter builder |
| `repo-config.mjs` | scan for hostile repo Claude Code config; CLAUDE.md hashing |
| `engine.mjs`, `report.mjs` | the tick, lifecycle, recovery, cancel, final report |

## Tests

```sh
node --test 'orchestrator/test/*.test.mjs'
make test        # includes the line above; ~35 s, zero model calls
```

Tests run the engine against `test/fake-claude.mjs` (`AOS_CLAUDE_BIN`, scenario in `AOS_FAKE_SCENARIO`) in throwaway git
repos under `$TMPDIR`. They cover: happy path with a 3-task DAG, retry/escalation, plan validation, plan approval and
idempotent ticks, rate-limit pause/resume and the utilisation reserve (injected clock), budgets (dispatch stop and kill
after grace), wall-clock kill with SIGKILL escalation, parallelism cap and scope overlap, crash/resume (re-adopt, lost
worker), cancel/kill switch, pause/resume, locking, policy hook (table-driven plus real runs), approvals (granted, timeout
= deny, expiry), scope violation, merge conflict, worker command line and env, event-log validity; `hardening.test.mjs` (no code execution via the allowlist, hostile repo configs,
CLAUDE.md hash, plan approval gate and hash binding) and `sandbox.test.mjs` (macOS only, skipped elsewhere: write/read/network
denials with canary files, private TMPDIR, timeouts, output cap, static profile with hostile worktree paths, refusal without the sandbox).
Note: the engine tests use a stand-in for the human (`helpers.humanApproves`) because plans with node checks no longer auto-approve.

## Not done yet

- Control server (`127.0.0.1:4319`), token/cookie auth, HTTP approvals API, SSE events: phase 3.
- Control UI and monitor integration (goal hub, DAG, meters); the telemetry hook (`aos-hook.mjs` tagging): phases 2 and 4.
- Real-claude runs: nothing here has ever called the real binary. Unverified: OAuth with the minimal env, the real
  plan-limit failure text (the matcher is a configurable guess), `--setting-sources ""`, `--resume` for approval
  continuations, planner `--json-schema`.
- One engine per goal and per process; the global worker semaphore across goals, goal creation via API, `aos` CLI
  integration (`scripts/aos.mjs`), `schemas/orch-task.schema.json` (validation lives in `lib/plan.mjs`).
- Resuming a `blocked` goal after raising a budget (re-run is only supported for active/draft/paused goals).
