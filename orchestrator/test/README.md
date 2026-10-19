# Fake `claude` for engine tests

`fake-claude.mjs` is a scripted stand-in for the `claude` CLI so the orchestrator engine can be tested with zero model
calls (design: `docs/orchestrator-design.md` section 11; evidence: `orchestrator/spike/README.md`). It never contacts a
network or the real binary. Node 18+, no dependencies. Point the engine at it with `AOS_CLAUDE_BIN=<abs path>/fake-claude.mjs`
(the file is executable and has a `#!/usr/bin/env node` shebang).

## Run the tests

```sh
node --test orchestrator/test/fake-claude.test.mjs     # or: node orchestrator/test/fake-claude.test.mjs
```

## Environment

| Variable | Meaning |
|---|---|
| `AOS_FAKE_SCENARIO` | Path to the scenario JSON (required; otherwise exit 2 with `fake-claude: AOS_FAKE_SCENARIO is not set ...`) |
| `AOS_FAKE_STATE` | State dir. Counts invocations per task (so `tasks.<id>` lists advance per attempt), logs every call to `invocations.ndjson` (`task_id`, `attempt`, `argv`, `prompt`, `model`, `AOS_*` env, `session_id`), and receives `<session>.transcript.jsonl`. Unset: every call is attempt 0, no logs |
| `AOS_TASK_ID` | Task id used to pick the scenario entry. Inherited by hook commands, as are all other env vars (`AOS_GOAL_ID`, ...) |

Scenario file problems fail before any stdout: exit 2 and `fake-claude: cannot read scenario file <p>: ENOENT ...`,
`... is not valid JSON: ...`, or `... unknown behavior '<x>' ...`.

## Scenario schema

```json
{
  "default":  Step,
  "planner":  Step,
  "tasks":    { "<task id | regex>": [Step, Step, ...] },
  "strict_permissions": false
}
```

- **Selection.** If the prompt contains the marker **`AOS_PLANNER`** (the engine's planner prompt must include it), the
  call is the planner and uses `planner` (falling back to `default`). Otherwise `tasks[AOS_TASK_ID]` (exact key), then the
  first key that, read as a regex, matches `AOS_TASK_ID` or the prompt; else `default`; else a bare success.
  A value may be one Step or a list.
- **Per attempt.** The n-th invocation for a task id (counted in `AOS_FAKE_STATE/counts/`) uses `list[n]`; past the end the
  last step repeats. The planner has its own counter.
- **`strict_permissions`**: without hooks, edits are applied (permissive). With `true`, a tool call that no `--allowedTools`
  rule, PreToolUse allow or PermissionRequest hook allows is auto-denied, like the real headless CLI.

Step fields (all optional):

| Field | Meaning |
|---|---|
| `behavior` | `success` (default), `fail_checks`, `error`, `rate_limit`, `budget_exceeded`, `denied_tool`, `crash`, `hang`, `slow` (see below) |
| `edits` | `[{path, content, append?, tool?}]`: real file writes relative to cwd (dirs created), each issued as a `Write` (or `Edit` if `append`) tool call that goes through the hooks |
| `commands` | `[{command, run?}]` or strings: `Bash` tool calls that go through the hooks; executed with `sh -c` in cwd only if `run: true` |
| `commit` | `true`: `git add -A && git commit` in cwd after the edits (author `fake-claude`) |
| `usage` | `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`; defaults 6 / 500 / 14000 / 4000. Split evenly over the turns as per-message `assistant` usage (one message id per turn, like the real stream); the sum equals `result.usage` |
| `cost_usd` | `total_cost_usd`; default computed from usage with a notional list price |
| `turns` | `num_turns` (default: tool calls + 1) |
| `delay_ms` | wait after `system/init`, before any tool call (all behaviors) |
| `message` | final assistant text / `result.result` (for `rate_limit` the limit text) |
| `rate_limit` | `{five_hour_utilization, seven_day_utilization, five_hour_resets_at, seven_day_resets_at, status?}` for the `rate_limit_event`. Default is a benign `allowed` event (0.14 / 0.30, resets in the future). `status` is derived (`>=1` rejected, `>=0.75` allowed_warning) unless given |
| `permission_denials` | `[{tool_name, tool_input, reason?}]` appended to `result.permission_denials` and emitted as `system/permission_denied` (in addition to hook-made denials) |
| `plan` | planner only: object (or string) returned as the result text. `plan_format`: `raw` (default), `fenced` (```` ```json ````), `prose` (text around the JSON). With `--json-schema` it is also in `structured_output` |
| `ignore_sigterm` | `true`: ignore SIGTERM (only SIGKILL stops it) |
| `api_error_status` | `rate_limit` only; default 429 |

Behaviors:

| Behavior | Output | Exit |
|---|---|---|
| `success` | edits applied, optional commit, stream, `result` subtype `success`, `is_error:false` | 0 |
| `fail_checks` | identical to `success`; the scenario's edits are the ones that make the engine's checks fail | 0 |
| `error` | `result` `is_error:true`, subtype `error_during_execution`, `errors:[message]` | 1 |
| `rate_limit` | `rate_limit_event` status `rejected`, utilization 1.0, then `result` `is_error:true`, `api_error_status:429`, `result:<message>`, zero usage (UNVERIFIED, see below) | 1 |
| `budget_exceeded` | `result` subtype `error_max_budget_usd`, `terminal_reason:"budget_exhausted"`, `errors:["Reached maximum budget ($X)"]`, no `result` key (as spike E5) | 1 |
| `denied_tool` | like `success` but `permission_denials` populated (scenario list plus hook denials) | 0 |
| `crash` | applies the first half (rounded up) of the tool calls, one assistant line, then dies: no `result`, no transcript | 137 |
| `hang` | applies edits, then sleeps until killed | n/a |
| `slow` | `delay_ms`, then success | 0 |

Also: a `success`/`fail_checks`/`denied_tool`/`slow` step whose cost exceeds `--max-budget-usd` becomes a
`budget_exceeded` result (the real CLI checks after the turn, spike 1f).

## CLI emulated

`-p/--print` is required (prompt as argument, or stdin when absent). `--output-format text|json|stream-json`: `json` prints
only the final result object; `stream-json` without `--verbose` fails (`Error: When using --print, --output-format=stream-json requires --verbose`, exit 1).
Stream order: `system/hook_started|hook_response` (SessionStart hooks), `system/init`, then per tool call `assistant`
(`tool_use`) / `system/permission_denied` / `user` (`tool_result`), one `rate_limit_event` after the first assistant line,
the final `assistant` text, and `result` (fields as in spike E1/E5: `usage`, `modelUsage`, `total_cost_usd`, `session_id`,
`permission_denials`, `terminal_reason`, `api_error_status`, ...).

Flags are parsed like commander: value flags take one value (`--flag=value` ok); variadic flags (`--allowedTools`,
`--disallowedTools`, `--tools`, `--add-dir`, `--mcp-config`, `--file`, `--betas`) swallow following arguments up to the next
`-flag` (so keep the prompt before them, as the design's command line does); `--resume [id]` takes an optional value.
`--session-id` (UUID, else random) and `--resume <id>` fix `session_id`. Honoured: `--model` (aliases haiku/sonnet/opus mapped to
model ids in `init`/`modelUsage`), `--settings` (file or inline JSON; hooks), `--tools` (a tool not listed returns a tool error
and is not a denial), `--allowedTools` / `--disallowedTools` (exact tool names, `Tool(prefix:*)` and `Tool(exact)`), `--permission-mode`
(`bypassPermissions`/`dontAsk` skip PermissionRequest), `--max-budget-usd`, `--json-schema`. Parsed and ignored: `--max-turns`
(validated only, matching the unreliable real cap), `--setting-sources` (validated), `--strict-mcp-config`, `--mcp-config`,
`--append-system-prompt`, `--add-dir`, `--include-partial-messages`, everything else. Unknown flags are treated as
no-value booleans and ignored. Invalid values (`--output-format xml`, bad `--permission-mode`, non-integer `--max-turns`,
non-positive `--max-budget-usd`, non-UUID `--session-id`, bad `--setting-sources`, missing value) print an error and exit 1
with empty stdout. `--version` prints `2.1.303 (Claude Code)`.

## Hooks

If `--settings` registers command hooks, they run (`/bin/sh -c`, cwd = worker cwd, env = the launcher's env plus
`CLAUDE_PROJECT_DIR`) with a JSON payload on stdin (`session_id`, `transcript_path`, `cwd`, `permission_mode`,
`hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`):

1. `PreToolUse` hooks (matcher `*`, empty or an anchored regex on the tool name): JSON `permissionDecision: "deny"` or exit 2 denies
   (tool result `PreToolUse:<Tool> hook error: <reason>` / `... hook error: [<command>]: <stderr>`, as in spike 5a/5b);
   `"allow"` marks the call allowed; anything else passes.
2. Unless allowed by PreToolUse, `--allowedTools`, or the permission mode, `PermissionRequest` hooks are consulted
   (`decision.behavior` allow/deny + `message`). If hooks are registered but none decides (no output, crash, timeout), the call is denied (fail closed, spike 5f).
3. A denied call is not applied, is added to `result.permission_denials` and emitted as `system/permission_denied`;
   the run still exits 0.
4. After an applied call, `PostToolUse` hooks run (observe only); `SessionStart` and `Stop` hooks run once (observe only).
   Hook `timeout` (seconds, default 60) is enforced with SIGKILL.

## Signals and transcript

SIGTERM (and SIGINT) append a `cost-state` line to `$AOS_FAKE_STATE/<session>.transcript.jsonl` with the cumulative usage of
the assistant turns started so far, then exit 143 (130 for SIGINT) with nothing more on stdout, as spike 7. Normal runs
also append that line at the end. Line shape:
`{"type":"cost-state","sessionId":...,"modelUsage":{"<model>":{"inputTokens","outputTokens","cacheReadInputTokens","cacheCreationInputTokens","costUSD"}},"totalCostUSD":n}`.

## Example scenarios (`scenarios/`)

`all-success-3-tasks.json` (planner plan with t1, t2, t3 + successes), `flaky-task-retry.json` (t1 wrong then right),
`escalation-needs-opus.json` (t1 fails twice, passes on attempt 3; drop the last step for the always-wrong cap test),
`rate-limit-midway.json` (85% five-hour warning, then a rejected call that retries), `denied-write-outside-worktree.json`
(needs the engine's policy hook in `--settings`). Keys starting with `_` (like `_comment`) are ignored.

## UNVERIFIED against the real CLI

- The exact stdout/stderr/exit code of a real plan-limit rejection (spike Q9, never observed): the `rate_limit` behavior
  is a best guess (`rate_limit_event` `rejected`, result `is_error:true`, `api_error_status:429`, text
  `5-hour limit reached ∙ resets 3pm`, exit 1). Text, status code and window values are configurable per step.
- `structured_output` as the field name for `--json-schema` results; the planner result text shape in general.
- The `cost-state` transcript record's exact field names (spike only names `modelUsage` and `totalCostUSD`).
- `--max-turns` semantics (spike 1e is UNCLEAR, so it is validated and ignored); `--resume` session id behavior.
- Error text of CLI validation failures (commander-style guesses; only the `--verbose` requirement is known to exist).
- Hook messages for PermissionRequest denial of "no decision" and `--disallowedTools` denial text; opus/sonnet model ids in `modelUsage` are synthetic (only `claude-haiku-5-5` was seen).
- Per-turn usage splitting and the position of `rate_limit_event` (the real stream emits it mid-run; exact placement not specified).
- Tool results text for non-hooked tools, `Edit` semantics (the fake writes/appends content; it does not do old/new string replacement).
