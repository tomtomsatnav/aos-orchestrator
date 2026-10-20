# aos-orchestrator

[![CI](https://github.com/tomtomsatnav/aos-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/tomtomsatnav/aos-orchestrator/actions/workflows/ci.yml)

An experimental engine that turns one human-written Goal into merge-ready work on a git branch, by planning tasks and dispatching headless Claude Code workers in git worktrees. It implements [AOS-1](https://github.com/tomtomsatnav/aos-1-spec) (schemas are vendored in `schemas/`, see `schemas/VERSION`). Zero npm dependencies, Node 18+, macOS first.

**Status: experimental. macOS only (acceptance checks run under `sandbox-exec`; the test suite does not pass on Linux). 8 small real runs so far: 7 achieved, 1 blocked by a test-setup error** (one real Opus planner run; the Haiku-to-Sonnet-to-Opus retry ladder was exercised once, by an environment failure, not a natural one). Everything else is tested against a scripted fake `claude`. Rate-limit handling is keyed on real error shapes captured from interactive transcripts, but a real `claude -p` limit result has never been observed.

## Safety

- Strict guardrails are enforced outside the model: a policy hook (deny rules, per-task grants, default deny), a per-task `path_scope` that fails any attempt touching other files, OS-sandboxed acceptance checks, and token / time / attempt budgets. By default the worker `claude` process itself is **not** OS-sandboxed: it is restricted by the policy hook and isolation flags only. An opt-in macOS OS sandbox for workers is available (`--sandbox-workers`): it limits file writes, not network or keychain reads (see `orchestrator/README.md`).
- Workers never commit or merge. The engine commits and merges onto its own `aos/<goal>/integration` branch, never touches your base branch, never pushes, and only deletes branches it created.
- It still launches real `claude` workers that can run commands in your repo. Run it against a **throwaway repo or clone** first, not a repo you care about, and read the plan before approving it.

## Run

```sh
git clone https://github.com/tomtomsatnav/aos-orchestrator && cd aos-orchestrator
npm test                                       # ~2 min, 531 tests, macOS only, uses a scripted fake claude: no tokens spent
node orchestrator/bin/aos-orch.mjs --help      # command list (`aos-orch` in the docs means this script; there is no installed binary)
node orchestrator/bin/aos-orch.mjs rules show  # what workers may do, and the default budgets
node orchestrator/bin/aos-orch.mjs doctor      # preflight: node, git, claude version/flags/login, sandbox, state dir, port (`--live` adds one tiny Haiku call); see orchestrator/README.md
```

Try the whole flow with no model calls, in a scratch directory (the "fake claude" is the test double the suite uses; needs a throwaway git repo with a `main` branch):

```sh
export AOS_ORCH_DIR=/tmp/aos-demo-state AOS_CLAUDE_BIN=$PWD/orchestrator/test/fake-claude.mjs
export AOS_FAKE_SCENARIO=/tmp/scen.json     # {"default":{"behavior":"success","edits":[{"path":"a.txt","content":"alpha\n"}]}}
node orchestrator/bin/aos-orch.mjs run goal.json   # goal.json: see "Goal file" in orchestrator/README.md (give it a "plan" and "approval_policy":{"plan":"auto"})
```

Unset `AOS_CLAUDE_BIN` and the same commands launch the real `claude` (needs it on your PATH and logged in). State is kept in `$AOS_ORCH_DIR`, by default inside the dashboard plugin's data folder under `~/.claude/plugins/data/`. If a worker "crashed", read `workers/<task>.<n>.stderr` in the goal's folder.

Engine design, state layout and CLI details: [orchestrator/README.md](orchestrator/README.md), [docs/orchestrator-design.md](docs/orchestrator-design.md), verified CLI facts in [orchestrator/spike/README.md](orchestrator/spike/README.md). The on-disk layout other tools can rely on: [docs/orch-state-contract.md](docs/orch-state-contract.md).

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

## Live view

The read-only live dashboard (goals, tasks, workers, cost) is in https://github.com/tomtomsatnav/agent-orchestration-standard. Its GOALS panel talks to this repo's control server (`aos-orch serve`, 127.0.0.1:4319).

[MIT License](LICENSE).
