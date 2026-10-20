# Declarative rule set: design

Status: DESIGN ONLY (no code changed). Scope: one declarative, versioned, hashable rule set that covers (A) what a worker
may do and (B) how the engine plans, retries, budgets, merges and stops. The default rule set must reproduce today's
behaviour exactly, so existing goals do not change.

Line numbers refer to the working tree on 2026-10-20 (HEAD `0a3e367` plus uncommitted edits). `engine.mjs`, `governor.mjs`,
`state.mjs` and `sandbox.mjs` are being edited in parallel, so their numbers may drift by a few lines.

---

## 1. Inventory: rules the engine enforces today

"Cfg" says whether a user can change the rule today: **code** = hard-coded, **goal** = goal.json field, **file** =
`$AOS_ORCH_DIR/policy.default.json` (or the file named by `orch.policy`), **cli** = runtime command, **dead** = the field is
stored but nothing reads it.

### 1A. Worker permissions (policy hook)

| # | Rule | Where | Cfg |
|---|---|---|---|
| A1 | Evaluation order: deny, then grants, then allow, then ask, then default deny. Any exception means deny | `policy.mjs:1-3, 286-323` | code |
| A2 | Tool allowlist `Read Glob Grep Edit Write Bash`, intersected with the task's `allowed_tools` | `policy.mjs:10, 293-295`; `plan.mjs:163` | file / code |
| A3 | CLI tool surface: `--tools`, `--allowedTools` (read-only), `--strict-mcp-config` with no servers, `--setting-sources project`, `--max-turns`, `--max-budget-usd` | `worker.mjs:8-9, 27-33` | code (+budgets) |
| A4 | Hook registered for `PreToolUse` and `PermissionRequest`, matcher `*`, 30 s timeout | `worker.mjs:58-62` | code |
| A5 | Writes only inside the worktree; anything outside `path_scope` is `ask` (`on_outside_scope`), unless a path grant covers it | `policy.mjs:103-120` | file |
| A6 | Reads only inside the worktree or `read_extra` | `policy.mjs:106-111` | file |
| A7 | Protected path globs (`~/.claude/**`, `~/.ssh/**`, `~/.config/**`, `**/.git/**`, `**/.claude/settings*.json`), matched case- and NFKC-insensitively | `policy.mjs:12, 67-68, 96-100` | file (**can be removed**, see G1) |
| A8 | Built-in protected rc files (`~/.zshrc` and similar) | `policy.mjs:47` | code |
| A9 | Symlink and dangling-link resolution; an unresolvable path is denied | `policy-hook.mjs:13-31` | code |
| A10 | Bash read-only allowlist (`ls cat head tail wc grep rg find -name diff git status/diff/log/show`) plus the task's `allowed_commands` | `policy.mjs:16, 268` | file / plan |
| A11 | Bash deny list and `deny_patterns` (pipe into an interpreter, `rm -r` on `/ ~ ..`) | `policy.mjs:17-19, 189, 216-219` | file |
| A12 | Always-deny commands (sudo, curl, ssh, eval, ...), no approval possible | `policy.mjs:28, 188` | code |
| A13 | Code execution is never allowed for a worker (interpreters, build and test runners, wrappers, editors, docker, gh) | `policy.mjs:34-42, 150-162` | code |
| A14 | git: deny subcommands (push, remote, config, fetch, ...), `-C`/`--git-dir`, `reset --hard`, checkout of the base branch, branch delete, hook-running subcommands | `policy.mjs:44-48, 192-202` | code |
| A15 | Package installs, recursive chmod and recursive rm outside the worktree are denied | `policy.mjs:29-30, 190-191, 246-248` | code |
| A16 | Shell constructs (substitution, expansion, heredoc, subshell, `cd` followed by more commands, wrappers, inline code, exec flags) go to `ask` when listed in `ask_on`, otherwise deny | `policy.mjs:211-239, 53-65` | file (`ask_on`) |
| A17 | A command longer than 16384 characters is denied | `policy.mjs:66, 209` | code |
| A18 | Approval: wait up to `wait_in_hook_s`, capped at 25 s; TTL comes from `approval_ttl_s`; an undecided request is denied with "do not retry" | `policy-hook.mjs:34-35, 61-75`; `engine.mjs:906-912` | file / goal |
| A19 | Grants: an approval becomes an exact-command or exact-path grant, scoped `once` or `task`; `once` grants are dropped after a merge | `approvals.mjs:60`; `engine.mjs:613, 634-638, 570` | human per call |
| A20 | Approval requests are deduplicated per (goal, task, attempt, tool, input, cwd) | `approvals.mjs:18-19` | code |
| A21 | Engine snapshot check: changed files outside `path_scope` and grants, or on protected paths, fail the attempt (`scope_violation`) | `engine.mjs:534-541`; `policy.mjs:329-333` | code (uses A7) |
| A22 | Worktree `.git` integrity is asserted before commit | `engine.mjs:527-531`; `git.mjs:49` | code |
| A23 | Worker OS sandbox (opt-in): writes limited; network fully open | `engine.mjs:859-862`; `sandbox.mjs:51-91` | goal `sandbox_workers` |
| A24 | Worker env built from scratch, no inherited secrets | `worker.mjs:36-56` | code |

### 1B. Plan, check and repository rules

| # | Rule | Where | Cfg |
|---|---|---|---|
| B1 | The planner always runs on `opus`, read-only tools, 300 s timeout, and the goal's `max_turns` and `attempt_usd_cap` | `engine.mjs:45, 712-735` | code / ctor |
| B2 | Plan validation: max_tasks, ids, tiers, acceptance, `path_scope` (not absolute, no `..`, not too broad, not under `.git`/`.claude`), no cycles | `plan.mjs:76-87, 107-151` | goal (`max_tasks`) |
| B3 | Each `allowed_commands` entry must be one simple, read-only command (`allowlistEntryProblem`) and must not be denied by DEFAULT_POLICY | `plan.mjs:128-135`; `policy.mjs:168-184` | code |
| B4 | Each task needs at least one check; `timeout_s` must be in (0, 3600]; the command must not be unsafe and must match the check allowlist | `plan.mjs:102, 136-142` | goal `check_allowlist` |
| B5 | Check allowlist = `orch.check_allowlist` plus the argv of every success criterion | `engine.mjs:901-905` | goal |
| B6 | Plan approval is `required` or `auto`; `auto` applies only when no task has commands and every check is auto-approvable (`grep test diff cmp`) | `state.mjs:232-234`; `plan.mjs:174-192`; `engine.mjs:690-695` | goal |
| B7 | Approval binds `plan_hash` and `tasks_hash` (tier excluded); the combined hash is shown and checked by the server | `plan.mjs:194-211`; `supervisor.mjs:212, 281`; `engine.mjs:272-299` | code |
| B8 | Plan tamper: every dispatch and verify re-checks the hashes; a mismatch halts the goal | `engine.mjs:290-299, 525, 768` | code |
| B9 | Repo config refusal: hooks, permissions, env, MCP servers, helpers and non-empty `.claude/{hooks,commands,agents,skills}` are refused at create and at dispatch unless the goal is trusted | `repo-config.mjs:10-81`; `engine.mjs:879-886, 977-979, 1002-1003` | goal `trust_repo_config` |
| B10 | Hashes of the instruction files (CLAUDE.md and others): a change not made by the engine fails the task without escalation | `repo-config.mjs:17, 85-91`; `engine.mjs:555-559, 895-898` | code |
| B11 | A repo is forbidden when it lies inside `~/.claude`, the orch dir or the engine checkout | `supervisor.mjs:29-37` | code |
| B12 | Checks: argv only, minimal env, output capped at 64 KB, sandboxed by default (no network except `check_localhost_ports`); refused when no sandbox is available | `checks.mjs:13-20, 38-75`; `sandbox.mjs:23-46` | goal `unsandboxed_checks`, `check_localhost_ports` |
| B13 | With no sandbox available and checks sandboxed, the goal halts before dispatch | `engine.mjs:764-766` | goal |

### 1C. Orchestration rules

| # | Rule | Where | Cfg |
|---|---|---|---|
| C1 | Budget defaults: `max_new_tokens` 2M, `max_parallel` 3, `max_attempts` 3, `max_tasks` 12, `task_wall_clock_s` 900, `stall_after_s` 300, `max_turns` 30, `attempt_usd_cap` 2, `approval_ttl_s` 86400 | `state.mjs:204-205` | goal |
| C2 | Goal budget: `max_ticks` 500, `max_usd` 5, `max_wall_clock_s` 7200 (mandatory) | `state.mjs:227-228` | goal |
| C3 | Soft limit at 80 % of tokens or wall clock: no new opus-tier dispatch. Hard limit at 100 %: block, 60 s grace, then SIGTERM | `governor.mjs:166-183`; `engine.mjs:44, 360, 750-757, 788` | code (thresholds) |
| C4 | Runtime budget patch (known keys, closed ranges) and `resume` only after a budget block | `state.mjs:274-299`; `engine.mjs:232-236, 255-263` | cli |
| C5 | Per-attempt kills: wall clock and stall (no progress) | `engine.mjs:358-359` | goal |
| C6 | Parallelism: `max_parallel` per goal; tasks with overlapping `path_scope` never run together; global `max_workers_global` (default 3, range 1-64) | `engine.mjs:784-791`; `supervisor.mjs:51, 85-87` | goal / `config.json` |
| C7 | Retry ladder: escalate `haiku → sonnet → opus`; `denied` retries the same tier once; a failure on the top tier is final; `merge_conflict`, `plan_tampered` and `repo_instructions_changed` do not escalate | `engine.mjs:496-517, 525, 559, 565` | code |
| C8 | Uncounted requeues: budget kill, overload (529), certain rate limit, lost worker, dispatch failure, pending approval | `engine.mjs:405-408, 450-478, 486-492, 793` | code |
| C9 | Two uncertain limit matches in a row count as a failed attempt | `engine.mjs:27, 464-469` | code |
| C10 | Governor: 5 h reserve 0.8 (no new dispatch), 7 d hold 0.9 (manual resume), backoff 15/30/60/240 min, overload backoff 30/60/120/300 s, 60 s jitter, detection texts | `governor.mjs:10-12, 41-115` | goal `orch.governor` (merged into a governor shared by all goals) |
| C11 | Merge: `--no-ff` into `aos/<goal>/integration`, never pushes; a conflict is a counted, non-escalating retry | `engine.mjs:561-565` | code |
| C12 | Definition of done: criteria run only once all tasks are done, on the integration branch (a check, `requires`, or all-done); all met means `achieved`, otherwise `blocked` | `engine.mjs:576-593, 641-656` | goal |
| C13 | Stop and ask the human: the plan awaits approval; a task waits in `needs_review` for a pending approval; the 7 d hold; budget blocks; a rejected plan; a stuck goal | `engine.mjs:243-245, 486-492, 659-664`; `governor.mjs:105-107` | code |
| C14 | Tick: lock TTL 60 s; heartbeat late at 1.5×, dead at 3×; error backoff doubles up to 900 s | `state.mjs:118, 158`; `engine.mjs:28, 160-167` | ctor |

### 1D. Gaps found while taking the inventory

- **G1. Merging can loosen.** `mergePolicy` (`policy.mjs:70-80`) is a shallow per-section merge. A goal `orch.policy`
  object or the policy file with `{"paths":{"deny":[]}}` drops the `.git` and `.claude/settings` protection, both in the
  hook and in `isProtectedRel` (the snapshot check, A21). The code-level floor (A8, A12-A15) survives.
- **G2. Rules are not snapshotted.** `_policy()` re-reads `policy.default.json` at every dispatch (`engine.mjs:906-912`),
  and the policy is not part of `tasks_hash`. A mid-run edit changes the rules without re-approval. Workers cannot write
  that file, because it is outside the worktree (A5) and denied by the sandbox (`sandbox.mjs:39`), but a human or another
  process can.
- **G3. Dead config.** Nothing reads `approval_policy.outside_allowlist`, `approval_policy.dangerous` (`state.mjs:232`),
  `paths.write`, `approval.on_timeout` (`policy.mjs:11, 22`) or `task.orch.read_scope` (`plan.mjs:162`).
- **G4. Rules appear in two places.** Plan validation checks `allowed_commands` against `DEFAULT_POLICY` (`plan.mjs:133`),
  not against the goal's effective policy.
- **G5. One goal can steer every goal.** `orch.governor` thresholds come from one goal but apply to `governor.json`,
  which all goals share.
- **G6. The server and the CLI use different defaults.** `POST /api/goals` hard-codes `max_ticks: 100000` and
  `plan_approval: 'required'` (`server/index.mjs:125-137`), while the CLI defaults to 500 ticks (`state.mjs:227`).
  Both should take their defaults from the compiled rules.

---

## 2. Proposed format

### 2.1 File and encoding

The rule set is **strict JSON** (`rules.json`) with a `description` string on any rule. Reasons:

- The zero-dependency constraint rules out a YAML library, and a hand-written YAML subset would be new attack surface
  for a security-relevant parser.
- JSON is what `goal.json`, `policy.default.json` and the plan already use. `schema.mjs` already validates a
  JSON-Schema subset (`type, required, enum, properties, items, pattern, minimum, minItems`). It needs only
  `additionalProperties:false` and `maxItems` added.
- Canonical hashing reuses `canonical()` and `sha256` from `plan.mjs:194-199`.

There is no JSONC and there are no comments. `description` fields survive into hashes and the review screen, where comments would not.

### 2.2 Layers and precedence

From the most trusted layer to the least trusted:

| Layer | Source | Who writes it | May loosen? |
|---|---|---|---|
| `floor` | code (`rules-floor.mjs`) | engine authors | n/a. It can never be overridden: A8, A9, A12-A15, A17, the B2 scope roots, B3, the B4 unsafe check commands and the 3600 s cap, B7-B11, the protected `**/.aos/**` glob |
| `default` | code: `DEFAULT_RULES`, which equals today's behaviour | engine | baseline |
| `user` | `$AOS_ORCH_DIR/rules.json` (replaces `policy.default.json`; the old file is read as a legacy alias) | human | yes: a human file outside every repo |
| `repo` | `<repo>/.aos/rules.json`, read **from `base_commit` with `git show`**, not from the working tree | repo authors (untrusted) | **no**, unless the human accepts each loosening at plan approval |
| `goal` | `goal.json` `orch.rules` (+ legacy fields `budgets`, `check_allowlist`, `policy`, `approval_policy`, `governor`, sandbox flags) | human (goal spec / CLI flags) | yes, but each loosening is listed on the approval screen |
| `plan` | per-task `allowed_commands`, `path_scope`, `checks`, `model_tier` | planner (untrusted) | no: these must lie inside the compiled grantable set |
| `grant` | approvals (`once` / `task`) | human, per call | an exact call only, never a pattern |

**Merge rule: a lower layer may only tighten.** Each field has a direction:

| Field kind | Tighten means | Merge |
|---|---|---|
| deny lists, `deny_patterns`, protected globs | add entries | union (they can never be removed) |
| allow lists (tools, bash, check allowlist, `read_extra`, tiers) | remove entries | intersection with the merged set so far. An entry not in that set is a **loosening** |
| numeric caps (budgets, timeouts, ports count) | lower | `min`. A higher value is a loosening |
| ordered enums (`deny > ask > allow`; plan approval `required > auto`; sandbox `required > off`) | stricter | max strictness. A weaker value is a loosening |
| safety booleans (`sandbox_workers`, `trust_repo_config` inverted) | the safe value | the safe value wins. The unsafe value is a loosening |

**Deny always wins** at evaluation time: if any layer denies a call, the call is denied, whatever any allow says. A
loosening is never applied silently. The compiler returns `{rules, loosenings[]}`. Each loosening is
`{layer, path, from, to, rule_id}`:

- Loosenings in the `user` and `goal` layers are applied and listed on the plan approval screen. Approving the plan
  accepts them, because they are part of the hash.
- Loosenings in the `repo` layer are **dropped** (tightening-only) unless the human runs
  `aos-orch approve --accept-repo-loosening <rule_id,...>` or ticks them in the UI. The hash covers that acceptance.
- Loosening the floor is a validation error at any layer.

### 2.3 Schema sketch (`rules_version: 1`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "additionalProperties": false,
  "required": ["rules_version"],
  "properties": {
    "rules_version": { "enum": [1] },
    "profile": { "enum": ["strict", "node-library", "docs-only"] },
    "description": { "type": "string", "maxLength": 500 },
    "worker": { "type": "object", "additionalProperties": false, "properties": {
      "tools": { "$ref": "#/$defs/idList" },
      "paths": { "type": "object", "additionalProperties": false, "properties": {
        "deny": { "$ref": "#/$defs/globRules" }, "read_extra": { "$ref": "#/$defs/globRules" },
        "on_outside_scope": { "enum": ["ask", "deny"] } } },
      "bash": { "type": "object", "additionalProperties": false, "properties": {
        "allow": { "$ref": "#/$defs/cmdRules" }, "deny": { "$ref": "#/$defs/cmdRules" },
        "deny_patterns": { "type": "array", "maxItems": 64, "items": { "type": "object", "required": ["id", "regex"] } },
        "ask_on": { "type": "array", "items": { "enum": ["substitution", "unparsed", "unknown_command"] } } } },
      "approval": { "type": "object", "properties": {
        "wait_in_hook_s": { "type": "integer", "minimum": 0, "maximum": 25 },
        "ttl_s": { "type": "integer", "minimum": 60, "maximum": 604800 },
        "grant_scopes": { "type": "array", "items": { "enum": ["once", "task"] } } } },
      "sandbox": { "enum": ["off", "required"] } } },
    "plan": { "type": "object", "properties": {
      "approval": { "enum": ["required", "auto"] },
      "planner_tier": { "enum": ["haiku", "sonnet", "opus"] }, "draft_tier": { "enum": ["haiku", "sonnet"] }, "planner_timeout_s": { "type": "integer", "maximum": 1800 },
      "max_tasks": { "type": "integer", "minimum": 1, "maximum": 50 },
      "tiers": { "type": "array", "items": { "enum": ["haiku", "sonnet", "opus"] } },
      "max_start_tier": { "enum": ["haiku", "sonnet", "opus"] },
      "scope_deny": { "$ref": "#/$defs/globRules" },
      "auto_approvable_checks": { "$ref": "#/$defs/cmdRules" } } },
    "checks": { "type": "object", "properties": {
      "allowlist": { "$ref": "#/$defs/cmdRules" }, "max_timeout_s": { "type": "integer", "maximum": 3600 },
      "sandbox": { "enum": ["required", "off"] },
      "localhost_ports": { "type": "array", "maxItems": 16, "items": { "type": "integer", "minimum": 1, "maximum": 65535 } } } },
    "retry": { "type": "object", "properties": {
      "max_attempts": { "type": "integer", "minimum": 1, "maximum": 10 },
      "ladder": { "type": "array", "items": { "enum": ["haiku", "sonnet", "opus"] } },
      "same_tier_retries": { "type": "object", "description": "cause -> retries before escalating, e.g. {\"denied\":1}" },
      "no_escalate": { "type": "array", "items": { "type": "string" } },
      "uncertain_limit_max": { "type": "integer", "minimum": 1, "maximum": 5 } } },
    "budgets": { "type": "object", "description": "the keys of DEFAULT_BUDGETS + goal.budget; soft_frac, hard_grace_s" },
    "governor": { "type": "object", "description": "reserve_5h, hold_7d, backoff_min[], overload_backoff_s[], jitter_s; user layer only" },
    "parallel": { "type": "object", "properties": { "max_parallel": { "type": "integer" }, "overlapping_scopes": { "enum": ["serialize"] },
      "soft_budget_blocks_tier": { "enum": ["opus", "none"] } } },
    "merge": { "type": "object", "properties": { "strategy": { "enum": ["no-ff"] }, "on_conflict": { "enum": ["retry_counted", "fail"] } } },
    "done": { "type": "object", "properties": { "criteria_when": { "enum": ["all_tasks_done"] }, "on_unmet": { "enum": ["block"] } } },
    "ask_human": { "type": "object", "properties": {
      "on_pending_approval": { "enum": ["needs_review"] }, "on_7d_hold": { "enum": ["manual_resume"] },
      "on_budget_hard": { "enum": ["block"] }, "on_plan_with_commands": { "enum": ["required"] } } },
    "repo_config": { "type": "object", "properties": { "trust": { "type": "boolean" } } }
  },
  "$defs": {
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,47}$" },
    "idList": { "type": "object", "properties": { "allow": { "type": "array", "items": { "type": "string" } } } },
    "cmdRules": { "type": "array", "maxItems": 128, "items": { "type": "object", "required": ["id", "cmd"],
      "properties": { "id": { "$ref": "#/$defs/id" }, "cmd": { "type": "string", "maxLength": 200 }, "description": { "type": "string" } } } },
    "globRules": { "type": "array", "maxItems": 128, "items": { "type": "object", "required": ["id", "glob"] } }
  }
}
```

Several enums above have one value (`merge.strategy`, `done.*`, `ask_human.*`). They make today's fixed behaviour
visible and hashable, and leave room for extension without implementing alternatives now. The governor keys are
accepted only in the `user` layer (this fixes G5).

Rule ids are qualified on output as `<layer>:<id>`, for example `floor:exec`, `default:bash.ls`, `repo:bash.rg-json` or
`goal:check.node-test`. Ids must be unique within a layer. Today's `rule` strings (`path_denied`, `outside_scope`,
`dangerous`, ...) become the floor and default ids, so existing tests and dashboards keep working.

### 2.4 Versioning and validation errors

- `rules_version` is required. An unknown version is refused (fail closed); there is no best-effort parse. A future v2
  ships a pure `migrate_1_to_2()`. The snapshot always stores the compiled v-current form plus the original source bytes.
- Validation returns `{ok, errors[]}`. Each error is a JSON path and a message, using the existing
  `schema.mjs` style (`$.worker.bash.allow[3].cmd: ...`). Domain checks run after the schema check:
  - each `cmd` entry goes through `allowlistEntryProblem()`. A worker bash entry that executes code is an error, not a loosening;
  - each `regex` must compile and be at most 200 characters (a ReDoS guard: no nested quantifiers, checked heuristically);
  - globs must be relative or `~/`, with no NUL;
  - ids are unique; unknown keys are rejected (`additionalProperties:false`).
- Where an error surfaces:
  - `user` or `goal` layer: `createGoal` throws (CLI exit 2) with the full list;
  - `repo` layer: refusal with the same wording as `repo-config.mjs` ("refusing repo ...: .aos/rules.json is invalid: ...");
  - plan: `orch.plan.rejected` (as today).

---

## 3. Security model of the rules themselves

1. **Workers can never change their own rules.**
   - Add `**/.aos/**` to the floor protected globs. This covers the hook (A7), `isProtectedRel` (A21) and the plan
     `BAD_SCOPE_ROOTS` (`plan.mjs:76`), so no `path_scope` can target `.aos`.
   - Floor globs are code, which closes G1 for `.git` and `.claude/settings*.json` as well.
2. **Snapshot and hash.** At plan creation the engine compiles all layers and writes `<goal>/rules.snapshot.json` (0600):
   `{rules_version, compiled, layers:[{layer, source, sha256}], loosenings, rules_hash}`. `rules_hash = sha256(canonical(compiled))`.
   - `plan_fingerprint` gains `rules_hash`, and the supervisor's combined hash becomes `sha256(plan:tasks:rules)`
     (`supervisor.mjs:212`). Approving a plan therefore approves the exact rules.
   - `_planIntact` (`engine.mjs:290`) also re-hashes the snapshot. Tampering halts the goal (`orch.rules.tampered`).
   - `_policy()` reads only the snapshot and never re-reads the user, repo or goal files mid-run (this fixes G2).
     The worker `policy.json` is derived from the snapshot plus the task context, as today.
3. **Untrusted repo rules.**
   - The engine reads `.aos/rules.json` from `base_commit` with `git show`, so the working tree and uncommitted edits are
     ignored. It is read only in createGoal; the integration branch is never consulted.
   - Repo rules may only tighten. Loosenings are dropped and reported as findings (see 2.2), in the same flow and
     wording as `scanRepoConfig`. A repo file that does not parse or validate refuses the repo, exactly like an
     invalid `.claude/settings.json` (`repo-config.mjs:48`).
   - `trust_repo_config` does **not** imply accepting rule loosenings. They are separate decisions.
   - A repo layer can never set: `worker.sandbox` off, `checks.sandbox` off, `plan.approval: auto`, `repo_config.trust`,
     the governor, or any value above the budget defaults (min-merge).
4. **Change during a run.** The pre-merge step already detects instruction changes (`engine.mjs:555`). The same check covers
   `.aos/rules.json` in the task diff, but the floor glob already makes such a change a `scope_violation`, so this is
   only defence in depth.
5. **Who can change rules mid-run.** Only an authenticated human command (CLI or control server): `rules tighten` applies
   immediately with a new hash and event; `rules loosen` puts the goal back to `awaiting_approval`. The existing
   `budgets` patch (C4) stays a human command and re-snapshots (see Q6).
6. **Approval screen.** `renderReview` (`plan.mjs:213`), the CLI `approve`, and the control server show:
   ```
   rules 3f9a1c07be21  profile=node-library  layers: default user(a1b2c3) repo(d4e5f6, 0 loosenings dropped) goal(9e8d7c)
   LOOSENINGS YOU ARE APPROVING (2):
     goal:budgets.max_new_tokens   2000000 -> 4000000
     user:checks.allow.npm-test    + "npm test"  (check, sandboxed)
   ```

---

## 4. Defaults

### 4.1 `strict` (= `DEFAULT_RULES` = today's behaviour)

```json
{
  "rules_version": 1, "profile": "strict",
  "description": "Engine default. Workers inspect read-only; all verification is sandboxed engine checks.",
  "worker": {
    "tools": { "allow": ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] },
    "paths": {
      "deny": [
        { "id": "home.claude", "glob": "~/.claude/**" }, { "id": "home.ssh", "glob": "~/.ssh/**" },
        { "id": "home.config", "glob": "~/.config/**" }, { "id": "git.dir", "glob": "**/.git/**" },
        { "id": "git.file", "glob": "**/.git" }, { "id": "claude.settings", "glob": "**/.claude/settings*.json" }],
      "read_extra": [], "on_outside_scope": "ask" },
    "bash": {
      "allow": [ {"id":"ls","cmd":"ls"}, {"id":"cat","cmd":"cat"}, {"id":"head","cmd":"head"}, {"id":"tail","cmd":"tail"},
        {"id":"wc","cmd":"wc"}, {"id":"grep","cmd":"grep"}, {"id":"rg","cmd":"rg"}, {"id":"find-name","cmd":"find -name"},
        {"id":"diff","cmd":"diff"}, {"id":"git-status","cmd":"git status"}, {"id":"git-diff","cmd":"git diff"},
        {"id":"git-log","cmd":"git log"}, {"id":"git-show","cmd":"git show"} ],
      "deny": [ {"id":"git-push","cmd":"git push"}, {"id":"git-remote","cmd":"git remote"}, {"id":"git-config","cmd":"git config"},
        {"id":"git-reset-hard","cmd":"git reset --hard"}, {"id":"sudo","cmd":"sudo"}, {"id":"curl","cmd":"curl"},
        {"id":"wget","cmd":"wget"}, {"id":"nc","cmd":"nc"}, {"id":"ssh","cmd":"ssh"}, {"id":"scp","cmd":"scp"},
        {"id":"rsync","cmd":"rsync"}, {"id":"npm-install","cmd":"npm install"}, {"id":"pip-install","cmd":"pip install"},
        {"id":"brew","cmd":"brew"}, {"id":"eval","cmd":"eval"}, {"id":"exec","cmd":"exec"} ],
      "deny_patterns": [
        { "id": "pipe-into-interpreter", "regex": "\\|\\s*(sh|bash|zsh|python3?|node|perl)\\b" },
        { "id": "rm-r-root", "regex": "rm\\s+-(?=[a-z]*r)[a-z]*\\s+(/|~|\\.\\.)" }],
      "ask_on": ["substitution", "unparsed", "unknown_command"] },
    "approval": { "wait_in_hook_s": 20, "ttl_s": 86400, "grant_scopes": ["once", "task"] },
    "sandbox": "off" },
  "plan": { "approval": "required", "planner_tier": "opus", "planner_timeout_s": 300, "draft_tier": "haiku", "max_tasks": 12,
    "tiers": ["haiku", "sonnet", "opus"], "max_start_tier": "opus", "scope_deny": [],
    "auto_approvable_checks": [ {"id":"grep","cmd":"grep"}, {"id":"test","cmd":"test"}, {"id":"diff","cmd":"diff"}, {"id":"cmp","cmd":"cmp"} ] },
  "checks": { "allowlist": [], "max_timeout_s": 3600, "sandbox": "required", "localhost_ports": [] },
  "retry": { "max_attempts": 3, "ladder": ["haiku", "sonnet", "opus"], "same_tier_retries": { "denied": 1 },
    "no_escalate": ["merge_conflict", "plan_tampered", "repo_instructions_changed"], "uncertain_limit_max": 2 },
  "budgets": { "max_new_tokens": 2000000, "max_wall_clock_s": 7200, "max_ticks": 500, "max_usd": 5, "attempt_usd_cap": 2,
    "task_wall_clock_s": 900, "stall_after_s": 300, "max_turns": 30, "soft_frac": 0.8, "hard_grace_s": 60, "draft_usd_cap": 0.1 },
  "governor": { "reserve_5h": 0.8, "hold_7d": 0.9, "jitter_s": 60, "backoff_min": [15, 30, 60, 240], "overload_backoff_s": [30, 60, 120, 300] },
  "parallel": { "max_parallel": 3, "overlapping_scopes": "serialize", "soft_budget_blocks_tier": "opus" },
  "merge": { "strategy": "no-ff", "on_conflict": "retry_counted" },
  "done": { "criteria_when": "all_tasks_done", "on_unmet": "block" },
  "ask_human": { "on_pending_approval": "needs_review", "on_7d_hold": "manual_resume", "on_budget_hard": "block", "on_plan_with_commands": "required", "on_human_criterion": "wait" },
  "repo_config": { "trust": false }
}
```

The success-criteria argv are still added to the check allowlist at compile time (B5), as an implicit `goal:criterion.<id>` entry.
`max_workers_global` remains supervisor configuration (`config.json`); it is not a per-goal rule.

### 4.2 Profile `node-library` (repo `.aos/rules.json`)

Workers still cannot run code: that is floor A13. This profile only **adds sandboxed checks** and tightens the rest.

```json
{
  "rules_version": 1, "profile": "node-library",
  "description": "Zero-dep Node library: tests via node --test / npm test, run by the engine in the sandbox.",
  "checks": { "allowlist": [
      { "id": "node-test", "cmd": "node --test", "description": "built-in test runner" },
      { "id": "npm-test", "cmd": "npm test" }, { "id": "node-check", "cmd": "node --check" } ],
    "max_timeout_s": 600 },
  "worker": { "paths": { "deny": [ { "id": "lockfile", "glob": "**/package-lock.json" }, { "id": "ci", "glob": "**/.github/**" } ] } },
  "plan": { "scope_deny": [ { "id": "no-node-modules", "glob": "node_modules/**" } ], "max_tasks": 8 },
  "retry": { "max_attempts": 3 }
}
```

The check allowlist entries in this file would be loosenings, because the default allowlist is empty. In a **repo**
file they are dropped unless the human accepts them at plan approval. In the **user** or **goal** layer they are listed
and approved with the plan. Approving them changes nothing else: these checks are not auto-approvable (B6), so the plan
still needs a human review.

### 4.3 Profile `docs-only`

```json
{
  "rules_version": 1, "profile": "docs-only",
  "description": "Edit Markdown only; no worker shell beyond read-only listing; cheap tiers.",
  "worker": { "tools": { "allow": ["Read", "Glob", "Grep", "Edit", "Write"] }, "paths": { "on_outside_scope": "deny" } },
  "plan": { "approval": "auto", "tiers": ["haiku", "sonnet"], "max_start_tier": "haiku",
    "scope_deny": [ { "id": "code", "glob": "**/*.{js,mjs,ts,py,sh}" } ], "max_tasks": 6 },
  "checks": { "allowlist": [ { "id": "grep", "cmd": "grep" }, { "id": "test", "cmd": "test" } ], "max_timeout_s": 60 },
  "retry": { "ladder": ["haiku", "sonnet"], "max_attempts": 2 },
  "budgets": { "max_new_tokens": 300000, "max_usd": 1 }
}
```

`plan.approval: "auto"` is a loosening (it weakens `required`). It is honoured only from the user or goal layer, and
even then only for plans without commands, as B6 already enforces. Everything else in this profile tightens.

---

## 5. Observability

Every decision carries the matching rule id. The rule id is safe to log (regex-checked, never free text).

- **Hook** (`policy-hook.mjs:44-75`). `decisions.ndjson` records gain `rule_id` (qualified), `rule_layer` and
  `rules_hash` (12 characters). The current `rule` field is kept unchanged for compatibility. An `ask` stores `rule_id` in
  the approval file (`approvals.mjs:46` already stores `rule`).
- **evaluate()** returns `{decision, reason, rule, rule_id, layer}`. When several rules match, the reported rule is the
  one that produced the final decision (`worst()` at `policy.mjs:122` keeps the decisive result).
- **Engine decisions** also get ids. Examples: `retry.ladder` on `task.retried`, `budgets.max_new_tokens` on
  `budget.exceeded`, `governor.reserve_5h` on `orch.governor.paused`, `merge.on_conflict` on `orch.integrate.conflict`,
  `plan.approval` on `orch.plan.approval_required`.

**Proposed additions to `docs/orch-state-contract.md`** (all additive; the monitor ignores unknown fields today):

| File | New fields |
|---|---|
| `goal.json` | `orch.rules: { hash (12 chars), version, profile, layers: [{layer, sha12}], loosenings: [{rule_id, layer}] }` (no values, no paths) |
| `events.ndjson` | new types `orch.rules.snapshotted {rules_hash, profile, loosenings}`, `orch.rules.refused {errors[≤5]}`, `orch.rules.tampered`, `orch.rules.changed {rules_hash, by, direction}`. Existing types gain `data.rule` (the qualified id) wherever a rule decided |
| `events.ndjson` `orch.policy.denied` | `data.rules: [{rule, count}]`, aggregated per attempt (the per-call detail stays in the 0600 decision log) |
| `approvals/A-n.json` | `rule_id` next to `rule` (the monitor already reads only `status`, `task_id`, `requested_at`) |
| `rules.snapshot.json` | optional for the monitor: size-capped, read as `{rules_hash, profile, compiled}` with path globs shown as-is (relative or `~`, no absolute paths) |

`rule` is already in the monitor's list of `data` fields (`data.{...,rule,label,...}`), so the event `text` will show
`orch.policy.denied ... rule=floor:exec` with no change on the monitor side. The dashboard (separate repo, read-only)
can then add:

1. a "rules" chip on the goal card: `profile · hash · N loosenings`;
2. a per-task denial breakdown by `rule`;
3. the rule id on each approval card (already planned in the design doc, section 7).

GoalDetail gains `rules{hash,profile,loosenings}`.

---

## 6. Migration and implementation plan

Each step is one PR, keeps the full suite green, and leaves `DEFAULT_RULES` behaviourally identical to today.

| # | Step | Tests | Risk |
|---|---|---|---|
| R0 | **Characterization only**: golden tests that pin today's decisions. Run ~60 tool calls from `policy.test.mjs` and `hardening.test.mjs`, plus the retry, governor and budget outcomes from the scenarios, and snapshot `{decision, rule}` | new `rules-golden.test.mjs` | none |
| R1 | `lib/rules.mjs` (pure): `DEFAULT_RULES`, `validateRules`, `compileRules(layers) → {compiled, loosenings, hash}`, `toPolicy(compiled)`, which returns exactly `DEFAULT_POLICY` for the default rules. Add `additionalProperties` and `maxItems` to `schema.mjs`. No wiring yet | unit tests for merge directions and every validation error; `toPolicy(DEFAULT_RULES)` deep-equals `DEFAULT_POLICY` | low |
| R2 | **Floor**: move `.git`, `.git/**`, `.claude/settings*.json` and `.aos/**` into the code floor (`BUILTIN_DENY_GLOBS`, `isProtectedRel`, `BAD_SCOPE_ROOTS`). Fixes G1 | a test that `{"paths":{"deny":[]}}` still denies `.git` and `.aos` writes and snapshot paths; golden tests unchanged | low (tightening only) |
| R3 | **Rule ids**: `evaluate()` returns `rule_id` and `layer`; the hook logs them; `createApproval` stores `rule_id` | extend `policy.test.mjs`; decision-log shape test | low |
| R4 | **Snapshot and hash**: write `rules.snapshot.json` at plan creation; add `rules_hash` to the fingerprint, the combined hash and `_planIntact`; `_policy()` reads the snapshot. A legacy goal without a snapshot compiles one from its existing fields on first load, flagged `legacy:true`, and its plan hash is unchanged until the next re-plan | tamper test (edit the snapshot, then dispatch halts); tests that a mid-run edit of the policy file has no effect; the server rejects a stale combined hash | **medium**: touches `engine.mjs` and `supervisor.mjs`, which are being edited in parallel; land it after that work merges |
| R5 | **User and goal layers**: `$AOS_ORCH_DIR/rules.json` (with `policy.default.json` as an alias) and `orch.rules`; the legacy goal fields map into the goal layer; loosenings are rendered in `renderReview`, the CLI `approve` and the UI | CLI tests for refusal output; loosening listing; tests that a `goal.orch.policy` override equals the old behaviour | medium |
| R6 | **Repo layer**: read `.aos/rules.json` from `base_commit` (`git.showBlob`); validate; drop and report loosenings; refuse an invalid file; add `--accept-repo-loosening` | fixtures: tighten-only repo, loosening repo, invalid repo, a file present only in the working tree (ignored); a worker-written `.aos` change becomes a `scope_violation` | medium (security-relevant) |
| R7 | **Plan validation against the compiled rules** (fixes G4): `allowed_commands`, `scope_deny`, `max_start_tier`, `tiers` and `max_timeout_s` | `validatePlan` table tests | low |
| R8 | **Orchestration rules wired in**: the retry ladder, `same_tier_retries`, `no_escalate`, `uncertain_limit_max`, `soft_frac`, `hard_grace_s`, `planner_tier` and `planner_timeout_s` replace their constants; governor keys only from the user layer (G5) | the existing scenarios (`escalation-needs-opus`, `flaky-task-retry`, `rate-limit-midway`) unchanged, plus new scenarios with custom values | medium |
| R9 | **Dead config** (G3): map `approval_policy.outside_allowlist` to `worker.paths.on_outside_scope` / `ask_on` and drop the others with an `orch.rules.deprecated` notice | a test that legacy goals still load | low |
| R10 | **CLI**: `aos-orch rules show [goal]`, `rules check <file>`, `rules explain <goal> <task> '<tool json>'` (dry-run `evaluate` showing the matched rule) | `cli.test.mjs` | low |
| R11 | **Contract and dashboard**: update `orch-state-contract.md` and the monitor fixtures in the dashboard repo | monitor golden fixtures | low |
| R12 | **Prompt to goal** (section 7): `lib/draft.mjs` (prompt, extraction, `validateDraft`), `verify:"human"` criteria, `aos-orch draft`, `POST /api/goals/draft` and the UI prefill. Needs R5 (compiled user and goal rules) and R7 (the shared check validation). The fake-claude scenario `draft-*.json` stands in for the model | `validateDraft` table tests (a criterion check off the allowlist, an unsafe argv, budgets above the rules, fewer than 2 criteria); a scenario where a vague prompt yields `questions`; a test that a human-review criterion blocks `achieved` until confirmed; a test that the server never creates a goal from a draft without an explicit submit | low-medium (no new privileges; one new model call with no tools) |

The order is fixed: R0 → R1 → R2/R3 (either order) → R4 → R5 → R6 → R7-R10 (any order) → R11, with R12 after R5 and R7. Until R4 lands no rule
input changes; from R4 on, any goal with no `.aos/rules.json` and no `orch.rules` compiles to `DEFAULT_RULES` and behaves
exactly as before. R0 proves that.

---

## 7. Prompt to goal

Today a human writes `goal.json` by hand (CLI) or fills in the title, description and criteria form (`POST /api/goals`).
The new flow: the human types a plain prompt and a repo, and the engine drafts a complete goal **for review, editing
and approval before any planning starts**. The draft is a proposal only: it has no goal directory, no worktree and no
events until the human submits it.

**Flow.** `prompt + repo`
→ `validateRepo` and the repo-config scan (B9, B11, unchanged: a refused repo is refused before any model call)
→ compile rules (user + repo + defaults; there is no goal layer yet)
→ **one drafting call**
→ `validateDraft`
→ show the draft to the human (edit, then submit)
→ the existing `createGoal`, unchanged
→ planner (B1)
→ plan approval (B6/B7).

Drafting adds a step in front of goal creation. It does not replace plan approval.

**The model call.** Rule `plan.draft_tier`, default `"haiku"`. Drafting is short structured extraction from text the
human wrote plus bounded repo facts (`gatherRepoFacts`, `plan.mjs:18`: the depth-2 tracked-file tree and Makefile
targets, plus `package.json` `scripts` keys only, never their bodies). The call runs with `--tools ""` (no tools at all),
`--max-turns 1`, `--max-budget-usd 0.10` (rule `budgets.draft_usd_cap`) and the same isolation flags as the planner (A3).
If the output fails to parse or validate, there is exactly one retry on `sonnet` with the validation errors appended.
After that the engine shows the errors to the human and creates nothing. The draft's tokens are not charged to any goal;
they are recorded in the draft record (`usage`).

**Output schema.** `{title, description, success_criteria:[{id, text, check?:{argv, timeout_s}, verify?:"human"}],
budgets?:{...}, questions?:[string], risks?:[string]}`.

**Validation against the rules.** This is the same code as R7 and B4, with no second implementation:
- each `check.argv` must pass `UNSAFE_CHECK_CMDS`, `commandAllowed(argv, compiled.checks.allowlist)` and
  `timeout_s ≤ checks.max_timeout_s`. Criterion argv are **not** auto-added to the allowlist for drafts. This closes the
  B5 path by which a criterion widens the check allowlist: a drafted check must already be allowed by the rules;
- budgets are clamped to the compiled `budgets` (min-merge). A drafted budget can only be lower than the rules;
- the title, description and criterion text are length-capped, and control characters are stripped;
- there must be 1-12 criteria, and at least one must have a `check` or there must be ≥2 human-review criteria (see below);
- a drafted value that would be a loosening is a validation error. The drafter cannot propose `trust_repo_config`,
  `unsandboxed_checks`, `plan_approval: auto` or any rules. Only the human can set those, in the review step.

**Vague prompts.**
- When the model cannot say what "done" means, it returns `questions` (at most 3). The CLI and UI show them and the
  human answers inline; the answers are appended to the prompt and drafting runs again (at most 2 rounds, then the human
  edits the form directly). There is never a silent guess.
- A criterion that no allowlisted command can verify (for example "the README reads well") gets `verify:"human"`. This is a
  new criterion kind: when all tasks are done, `_verify` (`engine.mjs:641`) treats it as unmet until a human confirms
  it (`aos-orch confirm <goal> <criterion>` or a UI button). The goal then waits in `blocked` with
  `blocked_reason: "awaiting human confirmation: c2"`, an `ask_human` rule (`on_human_criterion: "wait"`). This replaces
  today's silent "no check and no requires means met when all tasks are done" (`engine.mjs:589`) for drafted goals.
  Hand-written goals keep the old meaning until a rules version bump.

**CLI.** `aos-orch draft "<prompt>" --repo <path> [--out goal.json] [--profile node-library]`:
1. It prints the draft as a review block in the same style as `renderReview`: each criterion with its check command
   (`sandboxed, 60s`) or `HUMAN REVIEW`, the budgets with "(rule default)" or "(lowered by draft)", the rules hash and
   profile, and any questions.
2. It writes `goal.json` (0600) for the human to edit.
3. `aos-orch run goal.json` then continues exactly as today.

There is deliberately no `--yes` that drafts and runs in one step: the human must at least see the file.

**Control server and dashboard.**
- `POST /api/goals/draft {prompt, repo, profile?}` returns `{draft, errors[], questions[], rules_hash}`, rate-limited
  per session, with the same auth as goal creation. It creates no state.
- The orch UI goal form gets a "Draft from prompt" box that pre-fills the existing fields (title, description,
  criteria with argv, budgets), marks human-review criteria, and shows which allowlist rule each check matched
  (`checks.allow.node-test`).
- Submitting still goes through the unchanged `POST /api/goals`, so all existing validation applies.
- The read-only monitor shows nothing new until the goal exists. Afterwards `goal.created` gains `data.drafted: true`
  and `data.draft_tier` (a contract addition, section 5), and criteria with `verify:"human"` appear as `met:false` with
  a "needs confirmation" label.

**Security note.** The prompt and the repo facts are untrusted model input, and the drafting model is untrusted output.
The safety argument is the same as for the planner: the output can only choose among commands the rules already
allow. Everything still passes plan validation and human plan approval, and the drafting call has no tools.

---

## 8. Open questions (recommended answers)

1. **Strict JSON or JSONC (comments)?** Recommended: strict JSON with `description` fields. A comment-stripping
   tokenizer is small, but it is one more parser in front of a security file, and comments would not be covered by the hash.
2. **May a repo `.aos/rules.json` loosen anything at all?** Recommended: only through per-rule human acceptance at plan
   approval (`--accept-repo-loosening <ids>`), and never for floor, sandbox, plan-approval, trust or governor keys.
   Otherwise repo rules are tighten-only.
3. **Should a profile ever let a worker run code (for example `node --test`) when `sandbox_workers` is on?**
   Recommended: no, for now. Keep code execution in sandboxed checks (floor A13). The worker sandbox leaves the network
   open and keychain reads possible, so it is not a boundary that can carry that grant.
4. **Where do user defaults live?** Recommended: `$AOS_ORCH_DIR/rules.json`, read with `policy.default.json` as a legacy
   alias. That directory is already outside every repo and forbidden as a repo (`supervisor.mjs:33`). There is then no
   second location under `~`.
5. **Mid-run rule changes?** Recommended: tightening applies at once (new hash, `orch.rules.changed`, no re-approval).
   Loosening returns the goal to `awaiting_approval` with the diff shown. Per-call needs continue to go through approvals and grants.
6. **Are budgets rules (part of the hash), or operational limits outside it?** Recommended: they are in the rule set, so
   they are reviewed and hashed. The existing `budgets` command stays a human-only fast path that re-snapshots and logs
   `orch.rules.changed {direction:"loosen", keys}` without forcing a re-approval, because a budget never widens what a worker can touch.

---

## Implementation notes

Deviations and choices made while implementing R0-R4 (smallest sensible choice each time; none weakens security).

- **R1 list semantics.** A layer that names an allow list (`worker.bash.allow`, `checks.allowlist`, `worker.tools.allow`, ...) *replaces* it: entries
  not listed are removed (a tightening), entries not in the merged set so far are loosenings. There is no "add one entry" syntax. Deny lists are
  union-only, so an empty deny list is a no-op. Compiled list entries carry a `layer` tag (part of the hash); `toPolicy` drops it.
  Ordered kinds: `retry.ladder` may only become a subsequence of the current ladder; `plan.max_start_tier` is ordered `opus > sonnet > haiku` (lower is
  stricter); `parallel`, `merge`, `done`, `ask_human` values are "pinned" (any change is a loosening). `governor.*` is a free, user-layer-only value.
  A repo can never loosen `worker.sandbox`, `checks.sandbox`, `plan.approval` or `repo_config.trust`, even with `accept`.
- **R2 floor.** `FLOOR_DENY_GLOBS` in `policy.mjs` holds the six home/`.git`/`.claude/settings` globs plus `**/.aos/**` and `**/.aos`; it is applied in
  `denyGlobs` and `isProtectedRel` independently of `policy.paths.deny` (which still lists the first six for display, so `toPolicy(DEFAULT_RULES)` still
  equals `DEFAULT_POLICY`). Golden diff caused by R2 (tightening only): a worker `Write` to `.aos/rules.json` is now `deny/path_denied` (was
  `ask/outside_scope`), and `isProtectedRel('.aos/rules.json')` is `true` (was `false`). Side effect: a worker can no longer *read* `.aos/**` either.
- **R3 rule ids.** `evaluate()` adds `layer` and `rule_id` (`<layer>:<rule>`; the legacy `rule` string is the id). Layer is `default` for rules driven by the
  policy (tool allowlist, scope, bash allow/ask_on, deny patterns, an extra entry in the policy's own deny lists) and `floor` for rules enforced in code;
  when a call matches both (e.g. `git push`, `.git/**`), `floor` wins. The hook log gains `rule_id`, `rule_layer`, `rules_hash` (12 chars, `null` until R4
  puts a hash in the worker policy file); `approved` and `ask_unresolved` get `grant:approved` / `floor:ask_unresolved` plus `asked_by` (the rule that asked).
  `createApproval` stores `rule_id` next to `rule`. The `orch.*` event additions (section 5) are left to R8/R11.
- **R4 snapshot and hash.** (1) The snapshot is taken when the engine first loads a goal (tick step 0), not at plan creation, so the planner and every
  worker run under the same rules; a goal with a plan or approval but no snapshot is `legacy: true`. (2) Until R5 maps the user/goal layers into the
  compiled rules, `compiled` is the engine default rule set and the effective worker policy (policy file + goal override + approval ttl, merged exactly as
  `_policy()` did) is stored beside it as `policy`; `rules_hash = sha256(canonical({rules_version, compiled, policy}))`, recomputed from the file content at
  every check. (3) The fingerprint, the plan approval and the supervisor/CLI combined hash (`sha256(plan:tasks:rules)`) carry `rules_hash` only for non-legacy
  goals; a legacy goal keeps `sha256(plan:tasks)` and its snapshot hash is recorded in `goal.orch.rules.sha256`, which `_planIntact` also compares. A
  missing or unreadable snapshot hashes to `missing`/`invalid` and fails every check. (4) `_policy()` reads only the snapshot and, if it does not match
  `goal.json`, returns a policy that allows no tool. (5) The planner is refused (`orch.plan.rejected`) if the snapshot is tampered before planning. (6) Budget
  patches do not re-snapshot (budgets are not in the R4 snapshot; they stay in `goal.orch.budgets`). (7) Worker `policy.json` files carry `rules_hash`
  so the R3 decision log shows it. (8) `orch.rules.refused` and `orch.rules.changed` are not emitted yet (no layer can be refused or changed before R5).

### Review fixes after R1-R4 (Opus review)

- **Acceptance binds content.** Every loosening `rule_id` is `<layer>:<path>[.<entry id>]@<8 hex of sha256(canonical(new value))>` (`bindHash`). `--accept-repo-loosening`
  must quote the full id, so a repo that swaps the body under an accepted id (`sedn` from `sort` to `sed -n`) produces a new, unaccepted loosening. The bare id
  accepts nothing. Applies to every kind (lists, numbers, enums), not only entries.
- **Labels.** `profile` and `description` are applied from the user layer only; from `repo`/`goal` they are ignored and listed in `dropped` with `reason: "ignored: ..."`.
- **Schema.** `schema.mjs` uses `Object.hasOwn`, so `constructor`, `toString`, `__proto__`, `hasOwnProperty`, `valueOf` are unknown keys and do not satisfy `required`.
  `retry.same_tier_retries` keys must match `^[a-z][a-z_]{0,31}$`, not be a prototype name, and there are at most 8. `retry.ladder` and `plan.tiers` need >= 1 entry; a repo
  `plan.tiers` that would merge to an empty list leaves the previous list. `worker.approval.wait_in_hook_s` is now any number 0-25 (legacy goals use 0.3) and `ttl_s` starts at 1.
- **ReDoS.** `regexProblem()`: user deny patterns may not use backreferences, lookaround or named groups, a quantified group that contains a quantifier or alternation
  (`(a|aa)+`, `(a+)+`), more than 3 unbounded quantifiers, or exceed 200 characters. The engine's own two default patterns are exempt (one uses a lookahead). At run time
  non-built-in patterns run under a `vm` 100 ms timeout (a timeout or a bad pattern is `deny/policy_error`), and a Bash command longer than 4096 characters is not scanned by deny
  patterns and **asks** (`floor:command_too_long`; every other check still runs, a deny elsewhere still wins). Documented tightening: commands of 4097-16384 characters used to be
  allowed when they matched the allowlist; they now ask.
- **Tampered snapshot.** The worker/planner policy file is `{policy, rules_hash: <hash of the snapshot as found on disk>, rules_invalid?: true}`. With `rules_invalid` the hook denies
  everything with `rule=rules_snapshot_invalid`, `rule_id=floor:rules_snapshot_invalid`, and logs it. An unreadable snapshot hashes to `invalid`.
- **Nits.** `unparsed` is always `floor:unparsed`. The find-action ask carries `rule_id` `floor:find_action` (currently shadowed: `-exec/-ok` are denied earlier and `-delete/-fprint` ask
  through the exec-flag rule first, so it is a label for the day those change). The hook's `policy_error`, `approved` and `ask_unresolved` returns carry `rule_id`.
  `read_extra` entries are globs as declared: a plain path is a directory root, `*`/`**`/`?` match the resolved real path, `~/` expands, a relative entry is relative to the worktree (it
  was relative to the process cwd); absolute paths are valid for `read_extra` only. `approval_ttl_s` is not a patchable budget key (`BUDGET_LIMITS` has no such key), so there is no
  patch to honour: the TTL is fixed in the snapshot, as designed.

### R5-R7 (user, goal and repo layers; plan validation)

- **Spec key.** The goal spec's rules layer is `orch.rules` (as in the design); because R4 already uses `goal.orch.rules` for the snapshot summary, it is stored as `goal.orch.rules_layer`.
  `orch.accept_repo_loosening` (array of ids, <= 64) is stored as is.
- **Layers.** `default` -> `user` -> `repo` -> `goal`. `user` = `$AOS_ORCH_DIR/rules.json`; with none, the policy file the goal names (default `policy.default.json`, which the engine itself writes
  as DEFAULT_POLICY: mapping it is a no-op) mapped by `policyToRules`. `rules.json` wins when both exist. `goal` is ONE layer built from the legacy goal fields (only values that differ from the
  defaults, because a goal spec always carries a full `budgets` object and a default must not undo a user tightening), then the legacy `orch.policy` object, then `orch.rules_layer`, each
  overriding the previous per key (lists are replaced). Mapped legacy fields: `budgets.*` and `budget.*` (tokens, wall clock, turns, usd caps, parallel, attempts, tasks, approval ttl, ticks),
  `check_allowlist`, `check_localhost_ports`, `unsandboxed_checks`, `sandbox_workers`, `trust_repo_config`, `approval_policy.plan`. `orch.governor` is ignored with a note (R8, G5);
  `approval_policy.outside_allowlist/dangerous` are still unmapped (R9).
- **Legacy policy mapping.** Deny lists and deny patterns can only grow (the old shallow merge could empty them; the floor protected the critical paths either way), `bash.allow` entries that execute
  code are dropped with a note (the evaluator denied them anyway), `paths.deny` replacement is no longer possible, unknown keys are ignored with a note. A goal override of
  `approval.wait_in_hook_s`/`ttl_s` is a min-merge with the user value (the old merge took the goal's value, even a larger one; a larger one is now a listed loosening).
- **Write-back.** Compiled values the engine reads from `goal.json` are written back at snapshot time (`applyCompiledToGoal`): the budgets and caps above, `check_localhost_ports`,
  `unsandboxed_checks` (= `checks.sandbox: off`), `sandbox_workers` (= `worker.sandbox: required`) and `approval_policy.plan`. So a user rules file that lowers a cap or requires sandboxing
  binds goals whose spec says nothing. `trust_repo_config` is not written back (createGoal decides on the repo before any compile). Checks use the compiled `checks.allowlist`
  (empty if the snapshot is not intact); legacy (R4) goals keep their old behaviour entirely.
- **Snapshot.** Non-legacy snapshots add `dropped`, `notes` and `inputs` (each layer's validated rules, verified against the recorded layer hashes before any recompile). `policy` is exactly
  `toPolicy(compiled)`. The hash additionally covers `loosenings`/`dropped`/`notes` when non-empty (an R4 snapshot has none: its hash is unchanged). An invalid layer refuses the goal: at creation (preview
  compile, nothing is written) or, if a file breaks later, at the first tick (`blocked`, `halt_reason: "rules refused: ..."`, one `orch.rules.refused` event, no planner, no worker).
- **Approval screens.** `summarizeRules`/`renderRulesSummary` (rules.mjs) print profile, layers with a 6-character hash and the number of dropped loosenings, worker tools, bash allow, extra read roots, denies
  (bash, paths, patterns, the floor), checks, plan approval and tiers, limits, then `LOOSENINGS YOU ARE APPROVING (n)` (layer, path, change, id) and `NOT APPLIED (n)` for dropped repo loosenings. `aos-orch status`,
  `approve-plan` and `approvals` print it after the plan (`renderReview(view, rulesText)`); a tampered snapshot prints `RULES TAMPERED` instead. The server plan endpoint adds `rules` (the summary object,
  absolute paths scrubbed) and `rules_text` to its existing JSON (`plan_state`, `plan_hash`, `tasks` unchanged).
- **R6.** The repo layer is read once in `createGoal` with `git show <base_commit>:.aos/rules.json` (`showBlob`), capped at 64 KB, validated as layer `repo`; an invalid file refuses the repo (no goal directory is
  created). The parsed file is stored as `<goal>/repo-rules.json` and its sha256 in `goal.orch.repo_rules`; the snapshot compile re-checks that hash. Neither the working tree nor later commits are read.
  Acceptance: `orch.accept_repo_loosening` at creation (`run --accept-repo-loosening ids`), or `aos-orch approve-plan <goal> --accept-repo-loosening ids` which only QUEUES an `accept-repo-loosening` command
  (the design wrote `approve`, which is the tool-approval command here) and does not approve: the engine recompiles from the snapshot's stored inputs, writes a new snapshot and fingerprint
  (`orch.rules.changed {direction: loosen}`), the plan stays `awaiting_approval`, and the human reviews and approves again. It is refused after approval, for unknown ids, and when it would change nothing
  (a repo can never loosen sandbox, plan approval or trust). The server has no accept endpoint yet. A worker-written `.aos` change was already a `scope_violation` since R2 (floor glob); R6 adds the test.
- **R7.** `validatePlan(plan, {rules, policy})`: with the compiled rules it also enforces `plan.tiers`, `plan.max_start_tier`, `plan.scope_deny` (heuristic `scopeHitsDeny`: a literal name with an extension is a file,
  any other literal is a directory, wildcards are sampled; deliberately over-rejecting for directory scopes), `checks.max_timeout_s`; `allowed_commands` are evaluated with the goal's own worker policy (G4,
  also for legacy goals, whose policy is the snapshot's). The engine passes them from the intact snapshot, and the planner prompt lists the compiled tiers. `plan.auto_approvable_checks` and the task
  `tier_ladder` are still constants (R8).

### Review fixes after R5-R7 (Opus review)

- **B1 control characters.** `validateRules` walks EVERY string (cmd with all its argv tokens, globs, regexes, descriptions, ids, tool names, keys) and rejects C0, DEL, C1 and the Unicode bidi overrides
  (U+202A-202E, U+2066-2069). Validation error texts are escaped too. The renderer (`renderRulesSummary`, used by the CLI and the server `rules_text`) JSON-quotes any non-plain value and, as a last
  line of defence, escapes any control character left in a line. Probe: an allowlist `cmd` of `ls\x1b[2J\r...` is refused; if one reached a snapshot it prints as `"ls\u001b[2J\r..."`.
- **S1 acceptance ids** are `...@<32 hex>` (128 bits of sha256 of the new value). Loosenings accepted at creation (`--accept-repo-loosening`) are printed as `ACCEPTED repo loosening <id>: <path> + <full JSON>` notices.
- **S2.** `snapshotHash` also covers `inputs` and `layers` of non-legacy snapshots (an R4 snapshot has neither: its hash is unchanged). `recompileSnapshot(snap, accept, goal)` checks the inputs against
  `goal.orch.rules.layers` (sha12) and `goal.orch.repo_rules.sha256` and refuses on mismatch.
- **S3 globs.** `globToRegex` supports `{a,b}` (nested; an unbalanced brace is a literal) and `[abc]`/`[!abc]` (never matches `/`). Deny globs that are neither absolute nor `**`-led (`node_modules/**`, `*.pem`)
  are anchored at the worktree root (matched against the path relative to it; `isProtectedRel` does the same). Validation refuses globs with more than 4 `{` or 8 `*` runs (cheap regexes).
  Side effect (a fix): a `path_scope` with braces or classes used to match literally and now matches as written.
- **S4.** `scopeHitsDeny` folds case and NFKC like the runtime check, expands braces, expands each `[]` class to its members. `toPolicy` adds `paths.scope_deny` (only when non-empty, so `toPolicy(DEFAULT_RULES)`
  still equals `DEFAULT_POLICY`); `evaluate` denies a write matching it with `default:scope_denied`, and `isProtectedRel` treats it as protected for the engine's snapshot scan.
- **S5.** Plan-time `allowed_commands` are evaluated by the engine default AND the goal policy; a deny from either rejects the entry.
- **S6.** (a) The spec's own limits are recorded (`goal.orch.explicit_limits`); an explicit value equal to the default is a CAP in the goal layer: it lowers a user/repo value that is higher, it never raises a
  tighter one (the earlier tests rely on a default not undoing a user tightening). Goals created before the field existed keep the old rule. (b) `applyCompiledToGoal(goal, compiled, prev)`: on the accept recompile
  a limit whose goal.json value differs from the previous compiled value (a human patch) keeps the smaller of the patched and the new compiled value. The summary's `limits`/`max_tasks` show the enforced
  goal.json values, so they stay consistent after patches.
- **S7.** If the snapshot carries an applied (accepted) repo loosening, plan creation parks the plan for a human even when `plan.approval` is `auto` (`orch.plan.approval_required`).
- **S8.** All non-built-in deny patterns of one `evaluate()` call share a 1000 ms budget (`ctx.now` and `ctx.regex_budget_ms` exist for tests); past it the call is denied `floor:regex_budget`. Each vm timeout is
  `min(100 ms, remaining)`. The hook waits `wait_in_hook_s` minus the time already spent (`remainingWaitMs`). `evaluate` therefore reads a monotonic clock (it was already time-bounded through `vm`).
- **Nits.** `showBlob` resolves null only when `git ls-tree` lists nothing; git errors and blobs over 16 MB reject (createGoal refuses the repo; dispatch-time instruction hashing records `unreadable`, which
  differs from any recorded hash and so fails closed). The compiled `repo_config.trust` now decides at creation: a user `rules.json` with `repo_config.trust: false` locks it (a later `true` is dropped and listed as
  not applied) and the goal's `--trust-repo-config` is ignored; `goal.orch.trust_repo_config` is written back from the compiled value, and the repo-config scan runs after the rules preview. The approval summary's checks line lists the
  success-criteria check argv. Legacy-policy mapping notes unknown nested keys and reports `__proto__`; `mergePolicy` never assigns it.
- **Not done.** The server still has no accept-loosening endpoint (unchanged). Goldens: none changed.

R8 (verification findings N1, N2, S3a, S3b, S4):
- **Glob matching is linear.** `glob.mjs` no longer builds regular expressions: a glob is parsed into token sequences (braces pre-expanded, at most 64 alternatives, else it does not compile) and matched by a state-set simulation, O(path length x tokens), so `**a**a**a**b` and `*a*a*a*b` cannot blow up. Semantics are unchanged (anchoring, `*` stops at `/`, `**` crosses it, `**/` is an optional directory prefix, classes never match `/`, unbalanced `{`/`[` are literals, case/NFKC folding is done by the callers as before). Paths longer than 4096 characters are not matched: the hook denies them (`floor:path_too_long`), deny-style callers treat them as a match, scope-style callers as no match. Globs are limited to 8 wildcard runs, 4 braces and 64 brace alternatives, at validation in every layer and in `path_scope`.
- **Invalid globs fail closed.** `[z-a]` and other uncompilable globs are refused at validation (`globProblem`, `validateScope`). If one still reaches a matcher, it never throws: a deny-style call site (policy hook, `isProtectedRel`, `scopeHitsDeny`'s deny side) treats it as matching, a scope-style one as not matching, so the post-task snapshot check cannot crash. `isProtectedRel` now also handles `**`-led globs without a slash (`**.pem`).
- **Plan strings are terminal-safe.** `CTRL_RE`/`escCtrl`/`q` moved to `ctrl.mjs` (re-exported from `rules.mjs`) and now also cover LRM/RLM/ALM, zero-width characters, U+2060, BOM, U+2028/2029 and the tag block. `validatePlan` refuses them in every plan string (title, description, output_contract, acceptance, depends_on, path_scope, allowed_commands, check argv) and escapes error texts; only `description` and `output_contract` may contain `\n` and `\t`. `renderReview` and the server's plan view escape every field they show.
- **Scope-overlap sampler** (`scopeHitsDeny`) now samples range ends and midpoints and, for a negated class, characters the other glob mentions. It stays a heuristic: the runtime hook (and the post-task scope check) is the authority and enforces `scope_deny` on every write.
