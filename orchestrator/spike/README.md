# Orchestrator spike: headless Claude Code workers

Throwaway experiments that check, against the installed CLI, the facts the orchestrator design
([docs/orchestrator-design.md](../../docs/orchestrator-design.md)) depends on.

- **CLI:** Claude Code 2.1.303 on macOS, subscription (OAuth) auth, Node 22. Full `claude --help` is in [claude-help.txt](claude-help.txt).
- **Budget used:** 8 headless calls, all `--model haiku` (resolved to `claude-haiku-5-5`), `--max-turns` ≤ 4,
  120 s hard timeout from the runner. Notional list-price cost was about $0.005 per call.
- **Repo:** a temp git repo with `hello.txt`, `test.sh` (`grep -qx "hello world" hello.txt`) and a `CLAUDE.md` holding a canary
  word. It and all its worktrees were deleted afterwards.
- **Rate limits:** no real limit error happened, so its exact text was **not** observed (see Q9).
- **Side effects outside the spike:** the CLI wrote transcripts for the spike sessions under `~/.claude/projects/-private-var-folders-…-orch-spike-repo*`
  and the installed aos-dashboard plugin logged the non-isolated runs (`sid` `11111111`) to its `hook-events.ndjson`. Neither was touched here.

## Files

| File | What it does |
|---|---|
| `lib/run-worker.mjs` | The launcher the engine will copy: detached process group, env injection, 120 s timeout (SIGTERM, then SIGKILL 5 s later), captures stdout/stderr/exit, refuses to run after a real rate-limit error (`out/STOP`) |
| `lib/spike-hook.mjs` | Prototype policy hook: logs inherited `AOS_*` env; PreToolUse denies writes outside `$AOS_WORKTREE` (JSON) and `git push` (exit 2); PermissionRequest allows `touch <inside>` and denies everything else |
| `lib/approval-hook.mjs` | PreToolUse hook that blocks 8 s then allows, or outlives its 10 s timeout |
| `00-setup.sh` | Temp repo + task worktree `aos/spike/t1` + `out/settings.spike.json` |
| `01-worker-json.sh` | E1: worker in the worktree, `--output-format json`, env, hooks, CLAUDE.md |
| `02-policy-hooks.sh` | E2: six tool calls against the hooks, `stream-json` |
| `03-kill-and-cwd.sh` | E3: `cd ..`, then SIGTERM to the process group mid tool call (three runs, see header) |
| `04-isolation.sh` | E4: `--setting-sources project`, `--strict-mcp-config`, `--tools`, `--permission-prompts none` |
| `05-budget.sh` | E5: `--max-budget-usd` below one turn's cost |
| `06-approval-wait.sh` | E6: a hook that holds the worker, and hook timeout behaviour |
| `07-worktree-flow.sh` | E7 (no model): commit on task branch, merge into an integration branch, remove worktrees |
| `08-hook-unit.sh` | E8 (no model): the policy hook driven by synthetic payloads, incl. `../` and symlink escapes |

Run order: `./00-setup.sh && ./01-worker-json.sh && … && ./08-hook-unit.sh`. Raw output goes to `out/` (git-ignored: it holds local paths and the author's MCP/plugin list).

## Results

| # | Question | Command (abridged) | Observed | Verdict |
|---|---|---|---|---|
| 1a | Flags in the installed CLI | `claude --help` | All requested flags exist: `--model`, `--output-format text\|json\|stream-json`, `--allowedTools`, `--disallowedTools`, `--tools`, `--permission-mode` (`acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`), `--max-turns` (not listed in help but accepted), `--add-dir`, `--append-system-prompt`, `--mcp-config`, `--strict-mcp-config`, `--settings`, `--setting-sources`, `--plugin-dir`, `--max-budget-usd`, `--session-id`, `--no-session-persistence`, `--json-schema`, `--fallback-model`, `--permission-prompts host\|none`, `--include-hook-events`, `--bare`, `--safe-mode`, `--restricted`, `-w/--worktree`. `--permission-prompt-tool` is referenced only inside the `--permission-prompts` text; not exercised. | VERIFIED (presence) |
| 1b | `--output-format json` result object | E1 | One object: `type:"result"`, `subtype` (`success`, `error_max_budget_usd`), `is_error`, `terminal_reason` (`completed`, `budget_exhausted`), `num_turns`, `session_id`, `result`, `total_cost_usd`, `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens_details.thinking_tokens`), `modelUsage[model]` (same counts + `costUSD`, `costBasis:"list"`), `permission_denials[]` (`tool_name`, `tool_use_id`, `tool_input`), `api_error_status`, `errors[]` on failure, `subagent_stats`, `duration_ms`. | VERIFIED |
| 1c | `stream-json` | E2–E4 (needs `--verbose`) | Lines: `system/hook_started`, `system/hook_response`, `system/init` (cwd, model, permissionMode, tools, mcp_servers, plugins, memory_paths, apiKeySource), `assistant` (per-message `usage`), `user` (tool results + `tool_use_result`), `system/permission_denied` (`decision_reason_type:"hook"`, `message`), **`rate_limit_event`**, `result` (same as json). | VERIFIED |
| 1d | `--model haiku`, `--session-id`, `--append-system-prompt`, `--settings <file>`, `--allowedTools` headless | E1 | All accepted. `--session-id` fixes the transcript name, so the engine knows the session id before launch. | VERIFIED |
| 1e | `--max-turns` as a hard cap | E2 | `--max-turns 4` but `num_turns: 7`, `subtype: success`. Parallel tool calls appear to count separately in `num_turns`, or the cap is not what we think. | UNCLEAR: do not rely on it; cap by wall clock and tokens in the engine |
| 1f | `--max-budget-usd` | E5 (`0.0005`) | Exit code **1**, `is_error:true`, `subtype:"error_max_budget_usd"`, `terminal_reason:"budget_exhausted"`, `errors:["Reached maximum budget ($0.0005)"]`. Checked after the turn (spent $0.00088 > cap). Cost is notional list price on a subscription. | VERIFIED (soft, post-turn) |
| 1g | `--bare` for isolation | help text | Requires `ANTHROPIC_API_KEY` or `apiKeyHelper`; "OAuth and keychain are never read". Not usable on a subscription. | NOT AVAILABLE (for plan users) |
| 2 | Worktree flow | E1, E2, E7 | Worker with cwd = worktree edited only the worktree (`main` checkout still `hello`). Commit on `aos/spike/t1`, `--no-ff` merge into `aos/spike/integration` in its own worktree, `test.sh` passes there, `main` untouched, `git worktree remove` works; a dirty worktree is refused without `--force`. | VERIFIED |
| 3a | How a denial is reported | E1, E2 | Process exit **0**, `is_error:false`, `subtype:"success"`. Each denial is listed in `permission_denials[]`; stream-json adds `system/permission_denied` with the reason. The model receives the reason as a tool error and (haiku) stopped and reported it rather than retrying. | VERIFIED: success ≠ task done; the engine must read `permission_denials` and run its own checks |
| 3b | Default permission mode, headless, tool not allowlisted | E1, E2, E6 | `Write` and compound Bash not in `--allowedTools` raised a **PermissionRequest** (hook decided). With no hook decision the call is auto-denied: "touch in '…/b.txt' needs approval … Claude Code asks before a shell command creates, changes or removes files there." Read-only commands (`ls -la`, `pwd`) ran **without** any PermissionRequest; `cd ..` (leaving the project dir) needed approval. | VERIFIED: `--allowedTools` is not a complete allowlist; read-only commands bypass it |
| 4a | Installed plugin hooks fire inside `claude -p` | E1 | 7 aos-dashboard records with the worker session (`SessionStart` … `Stop`), `cwdp` = the worktree **realpath** (`/private/var/…`), and `tp` = transcript path. | VERIFIED |
| 4b | Hook subprocess inherits launcher env | E1–E4 | Our `--settings` hook saw `AOS_GOAL_ID=g-spike`, `AOS_TASK_ID=t1` on every event; also `CLAUDE_PROJECT_DIR` = worktree. The plugin hook was not instrumented to print env; same spawn path, so expected but not shown. | VERIFIED (settings hooks); plugin hooks UNCLEAR |
| 5a | PreToolUse JSON `permissionDecision:"deny"` | E2 | Write outside the worktree blocked; model sees `PreToolUse:Write hook error: <reason>`; file not created. | VERIFIED |
| 5b | PreToolUse exit code 2 | E2 | `git push origin main` blocked; model sees `PreToolUse:Bash hook error: [<hook command>]: <stderr>` (the hook command line leaks into the message). | VERIFIED |
| 5c | PermissionRequest `decision.behavior` allow/deny | E2 | `touch inside.txt` allowed and ran; `touch ../escape.txt` denied ("Error: <message>"), file not created. | VERIFIED |
| 5d | PreToolUse `permissionDecision:"allow"` for a non-allowlisted command | E6 | `touch a.txt` (not in `--allowedTools`) ran after the hook allowed it. | VERIFIED |
| 5e | Hook holds the worker (human approval wait) | E6 | Hook slept 8 s (timeout 10 s) then allowed: worker waited and continued. | VERIFIED (within the hook `timeout`) |
| 5f | Hook timeout | E6 | Hook sleeping 30 s with `timeout: 10` was killed (its post-sleep log line never appeared); Claude Code fell back to the normal permission flow, which headless auto-denied. Fail-closed in this configuration. | VERIFIED |
| 5g | PermissionRequest hook under `--permission-prompts none` | E4 | Hook still consulted (its deny was applied). The allow path under `none` was not exercised. | UNCLEAR (allow path) |
| 6 | Token usage per worker | E1, E3, E5 | Normal exit: `usage` + `modelUsage` in the result object. Killed worker: no result object, but stream-json `assistant` messages carry per-message `usage`, and the transcript `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` ends with a `cost-state` record (`modelUsage`, `totalCostUSD`) even after SIGTERM. | VERIFIED |
| 7 | Stopping a worker | E3 run C | SIGTERM to the process group mid tool call (`sh slow.sh` sleeping 100 s): `claude` exited **143** within the 25 s mark, its tool child was killed (tool result "Exit code 137"), nothing left in the process group, transcript and `cost-state` written, worktree left as-is (dirty files remain). No `result` line on stdout. | VERIFIED |
| 8a | Model cd's out of the worktree | E3 run A | `cd .. && pwd` raised a permission request (denied by our hook). Bash cwd stays in the worktree across calls (`pwd` → worktree). | VERIFIED |
| 8b | Standalone `sleep` | E3 run B | Claude Code itself blocks `sleep 100` ("Blocked: standalone sleep 100 …"). | VERIFIED (surprise) |
| 8c | CLAUDE.md inside a worktree | E1, E4 | Worktree `CLAUDE.md` loaded (canary answered) both with and without isolation flags. | VERIFIED |
| 8d | Worker inherits user config by default | E2 init | Yes: all user plugins, their hooks, 30+ MCP servers (incl. Gmail, Slack, Drive connectors), `model: opusplan` overridden by `--model`. | VERIFIED |
| 8e | Isolating a worker but keeping OAuth | E4 | `--setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools "Read,Edit,Bash"`: init shows tools `[Bash, Edit, Read]`, `mcp_servers: []`, only built-in plugins, no aos-dashboard records, `apiKeySource:"none"` and the call still authenticated. `--settings` hooks still fire. Model said no instruction mentions "graphify" (user `~/.claude/CLAUDE.md`), suggesting user memory is skipped. | VERIFIED (tools/MCP/plugins/hooks); user CLAUDE.md UNCLEAR (model self-report only) |
| 8f | Auto memory with worktrees | E4 init | `memory_paths.auto` points at the **main repo's** project slug, not the worktree's, even when isolated: workers share auto memory. Transcripts use the worktree slug. | VERIFIED (surprise) |
| 9 | Rate-limit / plan-limit signal | E2–E4 | No error occurred. stream-json emits `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":<epoch s>,"rateLimitType":"seven_day","utilization":0.84,"surpassedThreshold":0.75,"unifiedWindows":{"five_hour":{"utilization":0.14,"resetsAt":…},"seven_day":{…}},…}}`. The json format does not include it. Exact text/format of a *rejected* call: not observed. | VERIFIED (proactive signal); limit-error format UNCLEAR |

## What this means for the design

1. **Exit code 0 means nothing.** The engine must read `subtype`, `is_error`, `permission_denials` and then run its own acceptance checks.
2. **Policy belongs in PreToolUse**, which sees every call; `--allowedTools` and PermissionRequest miss read-only commands.
3. **Run workers with `--output-format stream-json`.** It is the only source of `rate_limit_event` (plan utilisation and reset time) and of per-message usage when a worker is killed.
4. **Isolate by default** with `--setting-sources project --strict-mcp-config --tools …`. The orchestrator then adds its own hooks (policy + telemetry) via `--settings`, so dashboard visibility no longer depends on the user's plugin install.
5. **Approval waits must fit inside the hook `timeout`.** On timeout the call is denied, which is safe: the engine re-dispatches after a human decision instead of holding a worker for minutes.
6. Exit-2 denials echo the hook command line to the model: keep it short and free of secrets, or use JSON deny.

## Not verified (follow-ups before phase 2)

- Exact stdout/stderr and exit code of a real plan-limit rejection (needs a limit to be hit; never force one).
- `--setting-sources ""` (fully exclude project settings, so a repo's own `.claude/settings.json` hooks cannot run in a worker).
- `--permission-prompt-tool` and `--permission-prompts none` allow path.
- Maximum allowed hook `timeout` value, and whether long-blocking hooks hold API state (prompt cache expiry).
- Whether the plugin's own hook process gets `AOS_*` env (expected; instrument `aos-hook.mjs` in phase 2).
