# aos-orchestrator

[![CI](https://github.com/tomtomsatnav/aos-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/tomtomsatnav/aos-orchestrator/actions/workflows/ci.yml)

An experimental engine that turns one human-written Goal into merge-ready work on a git branch, by planning tasks and dispatching headless Claude Code workers in git worktrees. It implements [AOS-1](https://github.com/tomtomsatnav/aos-1-spec) (schemas are vendored in `schemas/`, see `schemas/VERSION`). Zero npm dependencies, Node 18+, macOS first.

**Status: experimental. Platforms: macOS (`sandbox-exec`) and Linux (bubblewrap `bwrap`; checks only, see SECURITY.md); Windows via WSL untested. The opt-in worker sandbox (`--sandbox-workers`) is macOS-only and fails closed on Linux. 8 small real runs so far: 7 achieved, 1 blocked by a test-setup error** (one real Opus planner run; the Haiku-to-Sonnet-to-Opus retry ladder was exercised once, by an environment failure, not a natural one). Everything else is tested against a scripted fake `claude`. Rate-limit handling is keyed on real error shapes captured from interactive transcripts, but a real `claude -p` limit result has never been observed.

## Safety

- Strict guardrails are enforced outside the model: a policy hook (deny rules, per-task grants, default deny), a per-task `path_scope` that fails any attempt touching other files, OS-sandboxed acceptance checks, and token / time / attempt budgets. By default the worker `claude` process itself is **not** OS-sandboxed: it is restricted by the policy hook and isolation flags only. An opt-in macOS OS sandbox for workers is available (`--sandbox-workers`): it limits file writes, not network or keychain reads (see `orchestrator/README.md`).
- Workers never commit or merge. The engine commits and merges onto its own `aos/<goal>/integration` branch, never touches your base branch, never pushes, and only deletes branches it created.
- It still launches real `claude` workers that can run commands in your repo. Run it against a **throwaway repo or clone** first, not a repo you care about, and read the plan before approving it.

## Run

```sh
git clone https://github.com/tomtomsatnav/aos-orchestrator && cd aos-orchestrator
npm test                                       # ~2 min, ~540 tests, macOS or Linux (sandbox tests skip where no sandbox works), uses a scripted fake claude: no tokens spent
node orchestrator/bin/aos-orch.mjs --help      # command list (`aos-orch` in the docs means this script; there is no installed binary)
node orchestrator/bin/aos-orch.mjs rules show  # what workers may do, and the default budgets
```

Try the whole flow with no model calls, in a scratch directory (the "fake claude" is the test double the suite uses; needs a throwaway git repo with a `main` branch):

```sh
export AOS_ORCH_DIR=/tmp/aos-demo-state AOS_CLAUDE_BIN=$PWD/orchestrator/test/fake-claude.mjs
export AOS_FAKE_SCENARIO=/tmp/scen.json     # {"default":{"behavior":"success","edits":[{"path":"a.txt","content":"alpha\n"}]}}
node orchestrator/bin/aos-orch.mjs run goal.json   # goal.json: see "Goal file" in orchestrator/README.md (give it a "plan" and "approval_policy":{"plan":"auto"})
```

Unset `AOS_CLAUDE_BIN` and the same commands launch the real `claude` (needs it on your PATH and logged in). State is kept in `$AOS_ORCH_DIR`, by default inside the dashboard plugin's data folder under `~/.claude/plugins/data/`. If a worker "crashed", read `workers/<task>.<n>.stderr` in the goal's folder.

Engine design, state layout and CLI details: [orchestrator/README.md](orchestrator/README.md), [docs/orchestrator-design.md](docs/orchestrator-design.md), verified CLI facts in [orchestrator/spike/README.md](orchestrator/spike/README.md). The on-disk layout other tools can rely on: [docs/orch-state-contract.md](docs/orch-state-contract.md).

## Live view

The read-only live dashboard (goals, tasks, workers, cost) is in https://github.com/tomtomsatnav/agent-orchestration-standard. Its GOALS panel talks to this repo's control server (`aos-orch serve`, 127.0.0.1:4319).

[MIT License](LICENSE).
