# Security model

What the orchestrator enforces, what it does not, and the residual risks. The short version is in the [README](../README.md#safety); how to report a vulnerability is in [SECURITY.md](../SECURITY.md).

**Run it on throwaway repos or clones first.** The orchestrator launches real `claude` workers that can edit files in your repo, and its guardrails are defense in depth, not a proof. Platforms: macOS (`sandbox-exec`) and Linux (bubblewrap) for acceptance checks; the worker sandbox (default on macOS for `aos-orch run goal.json`) is macOS-only. See "Platform sandbox notes" at the end.

## The five protections in one paragraph

Workers get only read-only shell commands plus Edit/Write inside their task's `path_scope`; the policy hook denies everything else. Repos that carry their own Claude Code hooks, MCP servers or permissions are refused. Plans that contain commands always need your approval, and the approval is bound to a hash of the exact plan. Acceptance checks run in a deny-default OS sandbox with no network. On macOS `aos-orch run goal.json` also OS-sandboxes the worker `claude` process by default (`--no-sandbox-workers` opts out). With `worker.self_check` a worker may have the engine run its own approved checks in the check sandbox.

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
   network is denied (loopback only for `orch.check_localhost_ports`, or any loopback port with `checks.allow_loopback`); reads of `~/.ssh ~/.aws ~/.config ~/.claude ~/.gnupg`, keychains,
   shell history, other worktrees and the engine's goal/approvals/policy directories are denied. Paths reach the profile only as `-D`
   parameters through `execFile` (the profile text is static). If `sandbox-exec` is missing or fails its probe, checks are refused and
   the goal blocks before dispatch unless `orch.unsandboxed_checks` is set (recorded, warned, event-logged). Linux uses bubblewrap instead
   (see "Platform sandbox notes").
5. **Worker sandbox** (`orch.sandbox_workers: true`). `aos-orch run goal.json` sets it by DEFAULT on macOS and prints that it did;
   `--no-sandbox-workers` (or `orch.sandbox_workers: false` in the goal file) turns it off with a WARNING on stderr. On Linux and elsewhere
   it stays off with a notice (checks and self-checks are still bwrap-sandboxed); `--sandbox-workers` there fails closed. Goals created
   another way (dashboard/`serve`, the engine API) keep whatever their spec says (default off). The planner and every task worker are launched as `sandbox-exec -f <goal>/sandbox/worker-<hash>.sb -D ... claude -p ...`
   (`wrapWorkerCommand` in `lib/sandbox.mjs`; static deny-default profile, paths only as `-D` parameters). If `sandbox-exec` is missing
   or fails its probe, no worker starts (the dispatch fails and the goal halts); it never falls back to unsandboxed.
   **Linux: not supported.** `--sandbox-workers` / `orch.sandbox_workers` FAIL CLOSED there (the CLI exits with an error, no worker starts).
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
     its goal tmp dir, the approvals dir, its policy and settings files, the macOS developer directory (git/xcrun toolchain, read-only). Other home files (`~/Documents`, other repos) are not readable.
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

6. **Worker self-check** (rules `worker.self_check`, default OFF in the `strict` default rules, ON in the `node-library` profile;
   `worker.self_checks_max`, default 5 runs per attempt, a cap that only tightens; a repo layer can never turn it on). Workers still
   cannot run code. What they can do is ask the ENGINE to run one of their own task's approved checks (`lib/selfcheck.mjs`):
   - The policy hook recognises a Bash call whose command is EXACTLY one approved check argv of this task: one plain command, no
     shell syntax at all (`; & | < > ( ) $ \` ` \ { } # ~ !` and newlines are refused outright), token-for-token equal (no extra
     arguments, no env prefix, no other spelling of the binary), run from the worktree root. Anything else falls through to the
     normal policy, which hard-denies it as before.
   - The hook DENIES that call (the worker's command never runs, in or outside a worker sandbox) and drops `{id, index}` into the
     attempt's inbox (`<goal>/tmp/<task>/.aos-selfcheck/`, cleared per attempt). The engine process (outside every worker
     sandbox, so no nested `sandbox-exec`) takes the argv from ITS OWN copy of the approved plan, never from the request,
     counts it, and runs it through `runChecks`: the same deny-default check sandbox (sandbox-exec / bwrap: no network, writes
     only in the worktree and a private TMPDIR outside the worker's tmp dir), env, allowlist, 64 KB output cap. Its timeout is
     `min(check timeout, 300 s, the attempt's remaining wall clock)`, so the run counts against the task wall clock. If the
     goal's checks are not sandboxed (`checks.sandbox: off`), self-checks are refused.
   - The hook returns the result as the deny reason: status line plus the last 6000 characters of output, fenced as UNTRUSTED
     (`lib/untrusted.mjs`). Probed with a real `claude -p --model haiku` (2.1.304): the model reads the reason text.
   - Every run is an `orch.check.self_run` event (argv, ok, exit code, sandboxed, duration, output bytes); refusals past the cap
     are `orch.check.self_capped`; the attempt record gets `self_checks {runs, capped, ms, output_bytes, max}`. These denials are
     not counted as policy denials. The hook's PreToolUse timeout is 360 s so it can wait for a run; approval waits stay at 25 s.
   - Informational only: after the attempt the engine runs the integrity, scope, anti-cheat and authoritative checks exactly as
     before. A self-check result never decides anything.
   - Strict stays off because the strict default is the measurement-pending, nothing-new baseline and has no check allowlist
     of its own; node-library turns it on because its checks are `node --test`-style and blind writing costs a whole attempt there.
   The rules summary at plan approval shows `worker self-check: ON ... at most N per attempt` or `off`.

Residual risks (honest list):

- **Self-check (protection 6):** a self-check executes worker-written code in the check sandbox while the worker is still running,
  i.e. BEFORE the anti-cheat diff and the scope check (both still run afterwards on everything in the worktree, so a write the run
  makes outside `path_scope` fails the attempt; a check that leaves untracked build output that is not git-ignored now fails the
  attempt as a scope violation). Channels: requests go into an inbox in the worker's writable tmp dir; responses come back through
  an ENGINE-owned directory (`tmp/selfcheck-res-<task>`, beside the worker's tmp dir) that the macOS worker sandbox may read but not
  write, so a worker that swaps the inbox for a symlink cannot make the (unsandboxed) engine create files anywhere, and cannot forge a
  response. The engine only ever reads the inbox: each request is opened `O_NOFOLLOW|O_NONBLOCK`, must be a regular file of at most
  4 KB (a FIFO, a symlink to `/dev/zero` or an oversized file is deleted unread), at most 64 names are examined per 150 ms scan, and an
  attempt that files more than `self_checks_max + 16` bad or surplus requests is no longer serviced (`orch.check.self_flooded`). Without
  the worker sandbox (Linux, opted out) the worker can write anywhere its user can, so this is hygiene there, not a boundary. A
  self-check's timeout is capped at `min(check timeout, stall_after_s - 30, remaining wall clock)`, waiting on it counts as activity for
  the stall detector, and an in-flight self-check is killed (process group) and awaited before the attempt is collected. After the
  authoritative checks the worktree must still equal the commit the engine made (a detached process left behind by a check that
  writes later fails the attempt as `worktree_mutated_during_checks`). Stale responses and the `selfcheck-<task>` check tmp dir are
  removed between attempts. Workers re-adopted after an engine restart get no self-check service (the hook times out and says so). It gives a
  worker an execution oracle for its approved checks: output (up to 6000 chars per run, 5 runs) of code it wrote, from inside
  the check sandbox.

- **Workers (`claude` itself) are OS-sandboxed by default on macOS** (opt out with `--no-sandbox-workers` / `orch.sandbox_workers: false`,
  both warned loudly; protection 5); on Linux and elsewhere they are not (the flag fails closed there). An existing goal keeps the
  value it was created with (`aos-orch run goal.json` reports the stored value and warns when a flag differs). Unsandboxed, they are
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

## Guard mode (`aos-orch verify`): what it does and does not protect

`verify` judges a finished tree against a base commit; it does not supervise the agent while it works.
- **Enforced:** the tree is copied into a private scratch repository (the agent's `.git` config and hooks are not used; symlinks out of the tree are refused; size-bounded). The ORIGINAL test files of the base commit are written over the tree and re-run, and the checks run, in the check sandbox (fails closed without one unless `--unsandboxed-checks`). The diff is analysed for edited, weakened, skipped, deleted or reduced tests and config tampering.
- **Pass a base the agent cannot move.** If the agent can commit onto the base branch, a diff against it is empty and passes. Use a commit sha recorded before the session (the dashboard's opt-in hook records HEAD at session start for this reason).
- **Not covered:** it cannot see hidden tests, so an honest but wrong implementation passes; it rejects legitimate behaviour changes whose old behaviour an existing test asserts (a human must approve the test change); it runs the repository's own tests, so only verify repositories whose tests you are willing to run in the sandbox.

## Platform sandbox notes

- **macOS:** acceptance checks run under `sandbox-exec` (deny-default profile); workers too by default for `aos-orch run goal.json` (`--no-sandbox-workers` opts out).
  Both profiles may READ the active developer directory (`DEVELOPER_DIR` or `xcode-select -p`, as given and resolved; e.g.
  `/Applications/Xcode_<v>.app/Contents/Developer` on GitHub's macOS runners), because the `/usr/bin/git` shim runs the toolchain from there.
- **Linux:** acceptance checks run under bubblewrap (`bwrap`, install `bubblewrap`). Instead of a deny-default profile it builds a fresh mount
  namespace containing only read-only `/usr /bin /sbin /lib*` and a short `/etc` allow-list, the node prefix, `~/.npm` (read-only), the
  worktree and the private TMPDIR (read-write) and a tmpfs `/tmp`; the root is remounted read-only. HOME, secrets, other worktrees and engine
  state do not exist inside it. `--unshare-all` (including network), `--die-with-parent`, `--new-session`, `--clearenv` plus the caller's
  minimal env.
  - **Loopback:** the check gets a private network namespace with only its own loopback up. `checks.allow_loopback` is therefore satisfied by
    construction (a check can start a server and talk to it), with no access to the host's loopback or anything else. Unlike macOS,
    `orch.check_localhost_ports` cannot open specific HOST ports (bwrap shares the whole host network or none; we choose none), so named ports are ignored.
  - Writes to `/tmp` and to parent directories of the binds succeed but land in a private tmpfs and vanish.
  - The startup probe runs the real flags once, so hosts that forbid unprivileged user namespaces (some containers, Ubuntu 24.04 with
    `kernel.apparmor_restrict_unprivileged_userns=1`) count as "sandbox unavailable".
  - `--sandbox-workers` is **not supported on Linux and fails closed** (a bwrap equivalent was not validated against a real `claude`).
  - Verified with the full test suite in Docker (Node 18 and 22, privileged container because bwrap needs user namespaces); CI runs it on ubuntu-latest.
- **No sandbox available** (neither tool works): checks are refused and the goal blocks. Only an explicit `--unsandboxed-checks` /
  `orch.unsandboxed_checks` runs worker-written code unsandboxed, with a loud warning and an `orch.sandbox.disabled` event.
- Windows is untested (WSL2 with bubblewrap should behave like Linux, unverified).
