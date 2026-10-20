# AOS orchestrator: engine, supervisor and control server

New here? Start with the top-level [README](../README.md): `npm test`, then the fake-claude demo. In this document `aos-orch` means `node orchestrator/bin/aos-orch.mjs`.

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
node orchestrator/bin/aos-orch.mjs run <goal.json | goal-id> [--wait-approval] [--auto-approve] [--trust-repo-config] [--unsandboxed-checks] [--sandbox-workers] [--poll-ms N] [--interval-s N]
node orchestrator/bin/aos-orch.mjs doctor [--live]     # preflight PASS/WARN/FAIL (exit 1 on FAIL): node, git worktree, claude version vs known-good table (lib/doctor.mjs) and required flags, `claude auth status`, sandbox-exec probes, state dir, port; --live = one tiny Haiku call validating the stream-json shapes
node orchestrator/bin/aos-orch.mjs status [goal-id]
node orchestrator/bin/aos-orch.mjs plan <goal-id>      # read-only: the plan review + rules summary; approves nothing
node orchestrator/bin/aos-orch.mjs pause|resume|cancel|kill|approve-plan|reject-plan <goal-id>
node orchestrator/bin/aos-orch.mjs approvals <goal-id> | approve <goal-id> <A-n> [--for-task] | deny <goal-id> <A-n>
```

`run` exits 0 achieved, 2 blocked, 3 cancelled, 4 waiting for plan approval, 5 goal locked by another engine. When `run` stops for a human (plan approval, or a `verify: "human"` criterion) it prints the exact next commands (`aos-orch plan <id>`, `approve-plan <id>`, `confirm <id> <criterion>`, then `run <id>` again). `run <goal> --wait-approval` stays attached instead: it prints the plan, waits, and runs the engine again only once your own `approve-plan` / `confirm` command has been queued (the engine applies that command itself; nothing proceeds without it), so the whole flow works from two terminals without `serve`. Control commands are queued as files in
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
`orch.unsandboxed_checks`, `orch.check_localhost_ports` (loopback ports checks may connect to), `orch.sandbox_workers`
(opt-in OS sandbox for the worker `claude` processes; CLI `--sandbox-workers`, see Security model 5). Plan checks must match
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

### Advisory review and untrusted prompt blocks

`review.advisory: true` (rules key; default off; a user or goal rules layer can set it, a repo layer cannot without an acceptance) adds ONE read-only
reviewer call after every task passed and the goal criteria are met, before the goal is marked achieved. It has no tools, runs in an empty
directory on `review.tier` (`haiku` default, or `sonnet`), is capped at $0.25 and 120 s, and reads `git diff base..integration` as an UNTRUSTED block.
Its answer (at most 12 short bullets, control characters escaped) appears as "Reviewer notes" in `report.md`. It is advisory only: it never blocks,
retries or changes a task or the goal status, a failed review is just reported as "did not complete", and its tokens count toward the goal usage.

Every prompt that carries text a model or a repo wrote (check output, dependency summaries, the planner-written task description, repo file
names and Makefile targets, the diff) wraps it in `<<<UNTRUSTED-<random> label ... UNTRUSTED-<random>>>` blocks (`lib/untrusted.mjs`): a fresh
nonce per prompt, control and bidi characters escaped, any occurrence of the nonce removed, plus one line telling the model the content is
data, never instructions. This labels injected text and removes the cheap ways to forge the label; it does not make injection impossible.
Each attempt in `attempt_log` also records the `claude --version` (probed once per engine start) and `report.md` warns if it changed during a goal.

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
5. **Opt-in worker sandbox** (`orch.sandbox_workers: true` or `aos-orch run goal.json --sandbox-workers`; default OFF, behaviour
   unchanged). The planner and every task worker are launched as `sandbox-exec -f <goal>/sandbox/worker-<hash>.sb -D ... claude -p ...`
   (`wrapWorkerCommand` in `lib/sandbox.mjs`; static deny-default profile, paths only as `-D` parameters). If `sandbox-exec` is missing
   or fails its probe, no worker starts (the dispatch fails and the goal halts); it never falls back to unsandboxed.
   `orch.worker.started` events and `<task>.<n>.pid.json` carry `sandboxed: true|false`.
   - **Writes allowed only to:** the task worktree; `<goal>/tmp/<task>` (the worker's TMPDIR); `<goal>/approvals/` and
     `<goal>/workers/decisions.ndjson` (the policy hook runs inside the sandbox and writes them); the Claude files a `claude -p` run
     writes: `~/.claude/projects/<slug of the worktree>/`, `~/.claude/session-env/<this run's session id>/` only,
     `~/.claude/{todos,file-history}`, `~/.local/state/claude` (version locks); this worker's scratchpad
     `/tmp/claude-<uid>/<slug of the worktree>/` (and creating the `/tmp/claude-<uid>` directory itself) and the Bash tool's
     `/tmp/claude-<hex>-cwd` file; `/dev/null`, ttys. The engine's `$TMPDIR` is NOT writable (the worker's `TMPDIR` is its goal tmp dir).
   - **Explicitly denied (probed):** `~/.claude/shell-snapshots/` (new files too; those snapshots are sourced by the user's interactive
     shell tool sessions), `~/.claude.json` and its `.tmp`/`.lock`/`.backup` siblings (user-scope MCP servers), other sessions'
     `~/.claude/session-env/<id>`, other sessions' scratchpads under `/tmp/claude-<uid>/`. `claude -p` still starts, authenticates from
     the keychain and answers (3 probe runs under this profile; the first two failed for harness reasons: the `/tmp/claude-<uid>`
     directory itself must be creatable and `USER`/`LOGNAME` must be in the env for the keychain lookup, which the engine's env has).
   - **Writes denied to everything else**, including the main repo working tree and its `.git` (read-only, so git works in a worktree),
     other worktrees, the rest of `<goal>/` (goal/tasks state, policy files, other tasks' tmp), `~` itself and shell rc files,
     `~/.claude/settings.json`, `CLAUDE.md`, skills, plugins, other projects' session dirs and auto-memory, `~/.ssh ~/.aws ~/.gnupg`
     (also unreadable), keychain directories (`~/Library/Keychains`, `/Library/Keychains`).
   - **Reads allowed:** system locations, the node prefix, the claude binary's real directory, `orchestrator/lib` (the hook), the
     worktree, the repo `.git`, `~/.claude` (except `~/.claude/sessions`) and `~/.claude.json`, `~/.gitconfig`, `~/Library/Keychains`,
     its goal tmp dir, the approvals dir, its policy and settings files. Other home files (`~/Documents`, other repos) are not readable.
   - **Not restricted:** network (all of it: `claude` must reach `api.anthropic.com` and `sandbox-exec` cannot filter by host, so a
     worker shell can still talk to any host); Mach/XPC lookups; **keychain READ**: auth needs it, so a worker's shell can also run
     `security find-generic-password` and read the Claude credentials (and, combined with the open network, exfiltrate them). Other
     Claude sessions' IPC is blocked (`~/.claude/sessions` unreadable, `/tmp/cc-socks` sockets denied).
   - Verified on macOS 27 (Darwin 27.0.0), claude 2.1.304, with real `claude -p --model haiku` runs under the profile: it starts,
     authenticates from the keychain, writes its session transcript, and completes a Write + Bash (`ls`) turn with the policy hook
     logging both decisions (cost < $0.002 per run). Shell probes inside the profile confirm writes to the main repo, another worktree,
     `~/aos-sandbox-probe`, `~/.ssh`, `~/.claude/settings.json` and `~/Library/Keychains` fail while worktree writes succeed.
     The write list is empirical for that claude version: a newer claude that writes elsewhere fails those writes (EPERM), which
     may break a feature; re-probe after upgrades.

Residual risks (honest list):

- **Workers (`claude` itself) are OS-sandboxed only when you opt in** (`--sandbox-workers`, protection 5). By default they are
  constrained only by the policy hook (PreToolUse and PermissionRequest) and the isolation flags, and the hook is a heuristic shell
  parser: an unparsed construct is `ask`, not proof of safety. Even sandboxed, a worker has the network, keychain read and read access
  to `~/.claude` (other sessions' transcripts), and can write the approvals inbox (the hook must), so a worker that gets a shell past the
  hook could forge an approval file for its own later calls. A worker still holds Edit/Write inside its scope, and anything it writes
  is later executed by the sandboxed checks.
- What the worker sandbox does NOT contain: the network, keychain reads (so Claude credentials can be read and sent anywhere), reads of
  `~/.claude` (other sessions' transcripts) and `~/.claude.json`, and anything inside the writable set above (the worktree and goal tmp
  are executed later by the sandboxed checks). It guards against accidents and limits blast radius; it is not a boundary against a
  determined malicious worker.
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
| `sandbox.mjs` | `sandbox-exec` probe, static deny-default profiles (checks; opt-in workers), `-D` parameter builder |
| `repo-config.mjs` | scan for hostile repo Claude Code config; CLAUDE.md hashing |
| `untrusted.mjs`, `review.mjs`, `cli-version.mjs` | UNTRUSTED prompt blocks; the opt-in advisory reviewer; `claude --version` probe and drift check |
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

- Control UI and monitor integration (goal hub, DAG, meters); the telemetry hook (`aos-hook.mjs` tagging): phases 2 and 4.
- Real-claude coverage is thin (8 small runs, see the top README). Unverified: OAuth with the minimal env, the real
  plan-limit failure text (the matcher is a configurable guess), `--setting-sources ""`, `--resume` for approval
  continuations, planner `--json-schema`.
- `aos` CLI integration (`scripts/aos.mjs`), `schemas/orch-task.schema.json` (validation lives in `lib/plan.mjs`).
- The planner call is not counted against the global worker cap; only task workers are.

## Supervisor and control server (phase 3)

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
