# aos-orchestrator

[![CI](https://github.com/tomtomsatnav/aos-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/tomtomsatnav/aos-orchestrator/actions/workflows/ci.yml)

Describe a change in a sentence. An Opus planner splits it into small tasks, you review the plan, and cheap headless Claude Code workers (Haiku first, Sonnet and Opus only on failure) do the work in isolated git worktrees. Every task is verified by real commands, and the results land on a branch for you to review and merge. Zero npm dependencies, Node 18+, macOS only.

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

Without `npm link` use `node orchestrator/bin/aos-orch.mjs ...` (or `npm link` later). `aos-orch --help` lists every command.

## Safety

- Guardrails are enforced outside the model: a policy hook (deny rules, default deny), a per-task `path_scope` that fails any attempt touching other files, and token / time / attempt budgets.
- Workers never commit or merge. The engine commits onto its own `aos/<goal>/integration` branch, never touches your base branch, never pushes.
- Plans that contain commands always need your approval, and the approval is bound to a hash of exactly what you read.
- Acceptance checks run in a deny-default macOS sandbox with no network. Repos that bring their own Claude hooks, MCP servers or permissions are refused.
- The worker `claude` process itself is **not** OS-sandboxed by default (opt in with `--sandbox-workers`; it limits writes only). Run it on a throwaway repo or clone first.

Details and residual risks: [docs/security.md](docs/security.md). Reporting a vulnerability: [SECURITY.md](SECURITY.md).

## Status

Experimental, macOS only (checks use `sandbox-exec`; the test suite does not pass on Linux). 10 real goals so far: 9 achieved, 1 blocked by a test-setup error. Costs in reports are notional USD (list price, not money spent on a subscription). Everything else is tested against a scripted fake `claude`. A real `claude -p` plan-limit result has never been observed, so the rate-limit handling is keyed on error shapes from interactive transcripts.

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
- Everything a worker may do, and the retry and budget behaviour, is one versioned rule set: `aos-orch rules show`, design in [docs/rules-design.md](docs/rules-design.md).
- Engine internals, state layout, goal file and control server: [orchestrator/README.md](orchestrator/README.md), [docs/orchestrator-design.md](docs/orchestrator-design.md). The on-disk layout other tools can rely on: [docs/orch-state-contract.md](docs/orch-state-contract.md).
- It implements [AOS-1](https://github.com/tomtomsatnav/aos-1-spec); schemas are vendored in `schemas/`.
- Read-only live dashboard (goals, tasks, workers, cost): https://github.com/tomtomsatnav/agent-orchestration-standard. Its GOALS panel talks to this repo's control server (`aos-orch serve`, 127.0.0.1:4319).

[MIT License](LICENSE).
