# aos-orchestrator

[![CI](https://github.com/tomtomsatnav/aos-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/tomtomsatnav/aos-orchestrator/actions/workflows/ci.yml)

Describe a change in a sentence. An Opus planner splits it into small tasks, you review the plan, and cheap headless Claude Code workers (Haiku first, Sonnet and Opus only on failure) do the work in isolated git worktrees. Every task is verified by real commands, and the results land on a branch for you to review and merge. Zero npm dependencies, Node 18+, macOS and Linux (bubblewrap); the worker sandbox is macOS-only.

## Quickstart

```sh
git clone https://github.com/tomtomsatnav/aos-orchestrator && cd aos-orchestrator && npm link   # installs `aos-orch`
```

Use a throwaway repo or clone first (`./demo` below), with `claude` on your PATH and logged in.

```sh
aos-orch draft "add a slugify CLI with tests" --repo ./demo   # 1. one small model call writes goal.json for you to review
aos-orch run goal.json                                         # 2. plans, shows the plan, and waits for you
aos-orch approve-plan <id>                                     # 3. from a second terminal, once you have read the plan
```

`run` prints the goal id and stays attached: the plan is shown, nothing runs until you approve it, and when every task is done it prints the report and exits. Your base branch is never touched; the work is on `aos/<goal>/integration` and the report gives the exact `git diff` and `git merge` commands. See [docs/first-run.md](docs/first-run.md) for real runs, including every number.

Run `aos-orch doctor` first if anything looks off: it checks node, git, the `claude` version and flags, login, the sandbox, the state dir and the port (`--live` adds one tiny Haiku call).

Without `npm link` use `node orchestrator/bin/aos-orch.mjs ...` (or `npm link` later). `aos-orch --help` lists every command.

## Safety

- Guardrails are enforced outside the model: a policy hook (deny rules, default deny), a per-task `path_scope` that fails any attempt touching other files, and token / time / attempt budgets.
- Workers never commit or merge. The engine commits onto its own `aos/<goal>/integration` branch, never touches your base branch, never pushes.
- Plans that contain commands always need your approval, and the approval is bound to a hash of exactly what you read.
- Acceptance checks run in a deny-default sandbox (macOS `sandbox-exec`, Linux bubblewrap) with no network. Repos that bring their own Claude hooks, MCP servers or permissions are refused.
- On macOS `aos-orch run goal.json` OS-sandboxes the worker `claude` process by default (`--no-sandbox-workers` opts out, with a warning; it limits writes only). On Linux it is not supported and stays off, with a notice. Run it on a throwaway repo or clone first.
- With `worker.self_check` (on in the `node-library` profile, off in `strict`) a worker can have the engine run its own task's approved checks, sandboxed, a few times per attempt, and read the output. It cannot run anything else. See [docs/security.md](docs/security.md), protection 6.

Details and residual risks: [docs/security.md](docs/security.md). Reporting a vulnerability: [SECURITY.md](SECURITY.md).

## Status

Experimental. Platforms: macOS and Linux (bubblewrap); the worker sandbox (`--sandbox-workers`, the default on macOS) is macOS-only and fails closed on Linux; Windows via WSL is untested. The test suite runs on both (sandbox tests skip where no sandbox works). 18 real goals so far (counted from the goal directories): 13 achieved, 5 blocked. The blocks: a plan rejected for starting above the allowed tier, a test-setup error, a stale-base bug and a server-test loopback issue (both since fixed), and an unsatisfiable test that the protected re-run correctly blocked. See [docs/first-run.md](docs/first-run.md). Repeatable real evals (prompt to graded result, Haiku workers; 4 small tasks and 2 harder ones, including a test-editing trap): 44 of 48 trials passed on 21 Oct 2026; see [evals/results/2026-10-21.md](evals/results/2026-10-21.md). Costs in reports are notional USD (list price, not money spent on a subscription). Everything else is tested against a scripted fake `claude`. A real `claude -p` plan-limit result has never been observed, so the rate-limit handling is keyed on error shapes from interactive transcripts.

## Try it without spending tokens

`npm test` runs the whole suite (about 2 minutes, 530+ tests) against a scripted fake `claude`; no tokens are spent. To drive the CLI the same way, point it at the fake in a scratch directory (needs a throwaway git repo with a `main` branch):

```sh
export AOS_ORCH_DIR=/tmp/aos-demo-state AOS_CLAUDE_BIN=$PWD/orchestrator/test/fake-claude.mjs
export AOS_FAKE_SCENARIO=/tmp/scen.json     # {"default":{"behavior":"success","edits":[{"path":"a.txt","content":"alpha\n"}]}}
aos-orch run goal.json   # goal.json: see "Goal file" in orchestrator/README.md (give it a "plan" and "approval_policy":{"plan":"auto"})
```

Unset `AOS_CLAUDE_BIN` and the same commands launch the real `claude`.

## More

- State is kept in `~/.aos/orch` (`$XDG_STATE_HOME/aos/orch`, or `$AOS_ORCH_DIR`). An existing dashboard-plugin folder from older versions is still used if the new one does not exist. If a worker crashed, `aos-orch status <id>` and the report show the end of its stderr.
- Guardrails added since: existing tests are protected from edits by workers (`checks.protect_existing_tests`), loopback network for checks is an explicit opt-in (`checks.allow_loopback`), and a goal blocked at planning can be retried with `aos-orch run <id> --replan` (the planner is told what was wrong). Details: [orchestrator/README.md](orchestrator/README.md).
- Optional advisory reviewer (`review.advisory`, off by default, never blocks) and untrusted-text fencing in prompts: [orchestrator/README.md](orchestrator/README.md). Model and worker-network notes: [docs/worker-network.md](docs/worker-network.md). How this lines up with Anthropic's agent guidance: [docs/best-practices-alignment.md](docs/best-practices-alignment.md). Scripted eval scaffold: `evals/`.
- Everything a worker may do, and the retry and budget behaviour, is one versioned rule set: `aos-orch rules show`, design in [docs/rules-design.md](docs/rules-design.md).
- Engine internals, state layout, goal file and control server: [orchestrator/README.md](orchestrator/README.md), [docs/orchestrator-design.md](docs/orchestrator-design.md). The on-disk layout other tools can rely on: [docs/orch-state-contract.md](docs/orch-state-contract.md).
- It implements [AOS-1](https://github.com/tomtomsatnav/aos-1-spec); schemas are vendored in `schemas/`.
- Tidy up: `aos-orch archive <goal-id>... | --blocked | --achieved | --older-than <days> [--dry-run]` moves finished goals to `<state>/archive/goals/` (never deletes; refuses live or active goals), `aos-orch unarchive <goal-id>` moves one back, `aos-orch goals --all` lists archived ones; the dashboard no longer shows archived goals.
- Read-only live dashboard (goals, tasks, workers, cost): https://github.com/tomtomsatnav/agent-orchestration-standard. Its GOALS panel talks to this repo's control server (`aos-orch serve`, 127.0.0.1:4319).

## How it stops cheating

A worker is rewarded when the engine's checks pass, so the engine makes sure a pass is honest (`orchestrator/lib/anticheat.mjs`, `lib/harness-guard.mjs`). Each rule is tested against a fake-claude worker that cheats (`orchestrator/test/redteam.test.mjs` holds the end-to-end exploits that once reached `achieved`).

**Enforced** (a failing attempt, or a goal that cannot be achieved):

| Rule | Failure reason |
|---|---|
| Every engine-run `node --test` check (task checks, criteria, baseline, protected and acceptance re-runs) runs with an engine-owned preload from a read-only directory outside the worktree. It freezes `node:assert`, `node:assert/strict` and `node:test` (and their exported functions), re-verifies every function by identity at the end of the tests, at `process.exit` and at `process.reallyExit`, and writes a marker carrying a per-run random nonce (removed from `process.env` at preload time). A missing, forged (wrong nonce), or not-ok marker fails the check. `checks.harness_tamper: warn` only records it | `harness_tamper` |
| New non-test source lines that mention `node:assert`, `node:test`, `syncBuiltinESMExports`, `process.exit`, `process.reallyExit`, `Module._load`, `require.cache` or `globalThis.process` (`checks.harness_tamper: warn` makes it advisory) | `harness_tamper` |
| The same preload (round 2, `test/redteam2.test.mjs`) also records, sticky, and fails the check when: a module loader hook is registered (`module.register`, `registerHooks`: it could rewrite test files or helpers at load time); one of the fs read functions (`readFileSync`, `readFile`, `fs.promises.readFile`, `readSync`, `openSync`, `createReadStream`, `readdirSync`, `existsSync`, `statSync` ...) is replaced; a `node` child started with `spawnSync` whose result is never read, or an async `spawn`/`execFile`/`fork` of `node` with no `exit`/`close` listener or callback (its assertions run outside the guard and its verdict is lost) | `harness_tamper` |
| Test counts the verdict uses (total, pass, skipped, todo) come from the engine's own reporter channel (`harness-reporter.mjs`), not from stdout, so TAP-looking lines or a fake `# tests 99` printed by the code under test change nothing; `npm test`/other runners without that channel still use the output text. Baselines are recorded twice and the larger total and per-file count is enforced (a test file whose count varies by clock or randomness cannot record a low baseline by luck; a differing pair raises an `orch.anticheat.warning` `baseline_unstable`). New trivial test files cannot compensate for a shrunk existing file: per-file counts are enforced, a trivial file next to intact baseline files is legitimate | `tests_reduced` |
| A `node --test` check must run >= 1 test with >= 1 passing; skipped/todo-only, or a test file that declares nothing (or exits early, a "file-only" entry), is a fail | `vacuous_pass` |
| The check must count at least as many tests as the base commit, in total AND per file (counts recorded by running the check, the protected files and each acceptance task's files before they could be changed; static `test(` count as fallback for the total). A baseline file that runs fewer tests or becomes a file-only entry fails, also in the task-level judge | `tests_reduced` |
| Skips: added `.skip(` `.only(` `{ skip` `{ todo` `xit(` ... in a test file, and (runtime truth) a skipped+todo count above the baseline run (catches `const o = {skip: 1}; test('x', o, f)`, multi-line `skip:`, `t["skip"]()`). `allow_skip: [reason]` on a task lifts it, shown at approval | `tests_skipped` |
| Changed `package.json` `scripts`/`exports`/`type`/runner keys, runner config (`.mocharc*`, `jest.config*`, `vitest.config*`, `.c8rc*`, `.npmrc`, `.taprc`, `tsconfig*.json`, `jsconfig*.json` ...), a script/Makefile a check runs, or a file a check loads with `--import`/`--require`/`--loader`/`--env-file` (unless `path_scope` names that exact file) | `check_config_changed` |
| A test file deleted or renamed | `tests_deleted` |
| A modified test file or test helper (anything under `test/`, `tests/`, `__tests__/` or named `*test*`/`*spec*`) that drops assertion calls or value comparisons, unless `path_scope` names that exact file (approved with the plan) | `tests_weakened` |
| `checks.protect_existing_tests` (ON by default since this release; the original tests of the base commit are re-run at verify, with per-file counts) | goal blocked |
| `checks.acceptance_first: true` (on in `node-library`): an `acceptance` task writes the tests first; other tasks cannot reach them; they are re-run from the committed version at verify with per-file counts | `acceptance_modified`, `acceptance_empty`, goal blocked |

**Advisory:** values the tests expect pasted into new source lines (`if (x === 'Hello World!') return 'hello-world'`): `literal_copy`, `checks.literal_copy: fail` enforces it. It is a regex heuristic over added lines: it misses computed or split literals (`'Hello' + ' World!'`), encoded values, lookup tables and logic that special-cases inputs without quoting them, and it can flag legitimate constants. Outcomes are in `report.md` ("Anti-cheat"), `aos-orch status` (`anticheat`), events `orch.anticheat.*` and `attempt_log[].anticheat` ([docs/orch-state-contract.md](docs/orch-state-contract.md)).

**Self-check is never trusted:** `worker.self_check` output is only shown to the worker; the verdict is always the engine's own re-run after the attempt (a test that passes only inside a self-check fails the attempt: `redteam2.test.mjs` case 7), and files written after or during a run are caught by `worktree_mutated_during_checks`.

**Known limits.** (0) Round 2: the child-process rule is observational. A test that spawns `node` and reads `.status` once, or attaches an empty `exit` listener, passes it; a `Worker` whose `error` event a test swallows is not detected (`todo` test in `redteam2.test.mjs`); `sh -c "node ..."` is not recognised; the original `child_process` can be reached through internals. Replaced fs functions are only seen if still replaced when the test process ends, and a baseline whose count depends on the check's environment (not clock/randomness) is not detected. Honest false positives: a test that replaces an fs read function and never restores it (`mock.method(fs, 'readFileSync')` without `restore()`), a test that registers a loader hook on purpose (loader tooling), and a test that spawns a `node` child purely for side effects and never looks at it. (1) The preload runs in the same process as the code under test: that code could read the nonce from `/proc/self/environ` (Linux) or attack things we do not snapshot (the test runner's internals, `Function.prototype`, a native addon); the freeze + marker design blocks the known assert/node:test tampering, it is not a proof. (2) Weakening that keeps the number of assertion calls (changing an expected value in place) is invisible to `tests_weakened`; with `protect_existing_tests` on the original tests are re-run at verify, which catches it for existing tests, but a weak NEW test passes honestly. (3) Per-file counts rely on the runner's events; a non-`node --test` command (`make test`, `npm test`) is only judged when its output carries a node test summary, and is not wrapped by the preload. Tests in other languages are not counted. (4) Node < 21 does not expand globs; the engine expands them itself for `node --test` checks. The preload needs Node >= 18.18 (`--import`). (5) `checks.allow_loopback: true` is host-wide localhost on macOS (sandbox-exec cannot restrict ports); a check could reach local services such as the AOS dashboard. Linux gives each check a private network namespace. The rules summary says so. (6) `checks.acceptance_first` only applies to goals with at least one criterion that has a check; plan approval now warns when it is on and no criterion has one. (7) The Linux bubblewrap path of the guard (read-only bind of the preload dir) is covered by argv tests and by the Linux CI job, which runs the bubblewrap tests green on ubuntu with Node 18 and 22.

[MIT License](LICENSE).
