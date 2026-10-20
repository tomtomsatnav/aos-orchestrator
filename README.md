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

`run` prints the goal id and stays attached: the plan is shown, nothing runs until you approve it, and when every task is done it prints the report and exits. Your base branch is never touched; the work is on `aos/<goal>/integration` and the report gives the exact `git diff` and `git merge` commands. See [docs/first-run.md](docs/first-run.md) for two real runs, including every number.

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

Experimental. Platforms: macOS and Linux (bubblewrap); the worker sandbox (`--sandbox-workers`, the default on macOS) is macOS-only and fails closed on Linux; Windows via WSL is untested. The test suite runs on both (sandbox tests skip where no sandbox works). 10 real goals so far: 9 achieved, 1 blocked by a test-setup error. Costs in reports are notional USD (list price, not money spent on a subscription). Everything else is tested against a scripted fake `claude`. A real `claude -p` plan-limit result has never been observed, so the rate-limit handling is keyed on error shapes from interactive transcripts.

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
- Read-only live dashboard (goals, tasks, workers, cost): https://github.com/tomtomsatnav/agent-orchestration-standard. Its GOALS panel talks to this repo's control server (`aos-orch serve`, 127.0.0.1:4319).

## How it stops cheating

A worker is rewarded when the engine's checks pass, so the engine makes sure a pass is honest (`orchestrator/lib/anticheat.mjs`). Each rule is tested against a fake-claude worker that cheats.

| Rule | Failure reason | Status |
|---|---|---|
| A `node --test` check runs with the TAP reporter and must run >= 1 test, with >= 1 passing; skipped/todo-only or a test file that declares nothing is a fail | `vacuous_pass` | enforced |
| The check must count at least as many tests as the base commit (recorded by running the check on the base commit before the first dispatch; static `test(` count as fallback) | `tests_reduced` | enforced |
| Added `.skip(` `.only(` `{ skip` `{ todo` `test.todo` `xit(` `xdescribe(` ... in a test file (unless the plan task has `allow_skip: [reason]`, shown at approval) | `tests_skipped` | enforced |
| Changed `package.json` scripts, runner config (`.mocharc*`, `jest.config*`, `vitest.config*`, `.c8rc*`, `.npmrc` ...), or a script/Makefile a check runs (unless `path_scope` names that exact file; approval highlights it) | `check_config_changed` | enforced |
| A test file deleted or renamed | `tests_deleted` | enforced |
| `checks.acceptance_first: true` (on in `node-library` for goals with code criteria): the plan needs an `acceptance` task that writes the tests first; every other task depends on it, cannot reach its files, and the engine re-runs them from the committed version at verify | `acceptance_modified`, `acceptance_empty`, goal blocked | enforced |
| Values the tests expect pasted into new source lines (`if (x === 'Hello World!') return 'hello-world'`) | `literal_copy` | advisory (`checks.literal_copy: fail` enforces it); shown in `report.md` and given to the advisory reviewer |

Outcomes are in `report.md` ("Anti-cheat"), `aos-orch status` (`anticheat`), events `orch.anticheat.*` and `attempt_log[].anticheat` (see [docs/orch-state-contract.md](docs/orch-state-contract.md)). Limits: these are heuristics on a diff, not proof of honesty. A command that is not `node --test` (for example `make test`) is only judged when its output carries a node test summary; tests in other languages are not counted; a determined worker can still write a weak test that passes honestly.

[MIT License](LICENSE).
