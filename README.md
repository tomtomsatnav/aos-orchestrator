# aos-orchestrator

An experimental engine that turns one human-written Goal into merge-ready work on a git branch, by planning tasks and dispatching headless Claude Code workers in git worktrees. It implements [AOS-1](https://github.com/tomtomsatnav/aos-1-spec) (schemas are vendored in `schemas/`, see `schemas/VERSION`). Zero npm dependencies, Node 18+, macOS first.

**Status: experimental, 3 real Haiku runs so far.** Everything else is tested against a scripted fake `claude`. The rate-limit handling has never met a real limit. Known issue: `aos-orch serve` can hold a goal's lock without ticking it, so run a goal with either `run` or `serve`, not both.

## Safety

- Strict guardrails are enforced outside the model: a policy hook (deny rules, per-task grants, default deny), a per-task `path_scope` that fails any attempt touching other files, OS-sandboxed acceptance checks, and token / time / attempt budgets. The worker `claude` process itself is **not** OS-sandboxed: it is restricted by the policy hook and isolation flags only.
- Workers never commit or merge. The engine commits and merges onto its own `aos/<goal>/integration` branch, never touches your base branch, never pushes, and only deletes branches it created.
- It still launches real `claude` workers that can run commands in your repo. Run it against a **throwaway repo or clone** first, not a repo you care about, and read the plan before approving it.

## Run

```sh
node --test orchestrator/test/*.test.mjs        # or: npm test   (uses the fake claude; no tokens spent)
node orchestrator/bin/aos-orch.mjs --help
```

Engine design, state layout and CLI details: [orchestrator/README.md](orchestrator/README.md), [docs/orchestrator-design.md](docs/orchestrator-design.md), verified CLI facts in [orchestrator/spike/README.md](orchestrator/spike/README.md). The on-disk layout other tools can rely on: [docs/orch-state-contract.md](docs/orch-state-contract.md).

## Live view

The read-only live dashboard (goals, tasks, workers, cost) is in https://github.com/tomtomsatnav/agent-orchestration-standard. Its GOALS panel talks to this repo's control server (`aos-orch serve`, 127.0.0.1:4319).

[MIT License](LICENSE).
