# Security model

What the orchestrator enforces, what it does not, and the residual risks. The short version is in the [README](../README.md#safety); how to report a vulnerability is in [SECURITY.md](../SECURITY.md).

**Run it on throwaway repos or clones first.** The orchestrator launches real `claude` workers that can edit files in your repo, and its guardrails are defense in depth, not a proof. All of this applies to macOS only (checks run under `sandbox-exec`).

## The five protections in one paragraph

Workers get only read-only shell commands plus Edit/Write inside their task's `path_scope`; the policy hook denies everything else. Repos that carry their own Claude Code hooks, MCP servers or permissions are refused. Plans that contain commands always need your approval, and the approval is bound to a hash of the exact plan. Acceptance checks run in a deny-default OS sandbox with no network. The worker `claude` process itself is OS-sandboxed only if you opt in with `--sandbox-workers`.

## What is enforced, and what is not

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
