# Changelog

## Unreleased
- Opt-in macOS OS sandbox for worker `claude` processes: `aos-orch run goal.json --sandbox-workers` / `orch.sandbox_workers`. Limits writes (worktree, goal tmp, approvals, Claude session files, system temp); network and keychain reads stay open. Default unchanged.

## 0.1.0 (experimental)
- Engine that plans a Goal into tasks and dispatches headless Claude Code workers in git worktrees; policy hook, path scopes, budgets, control server and supervisor.
- Status: experimental. Exercised by 3 real Haiku runs; everything else is tested against a scripted fake `claude`. Rate-limit handling has never met a real limit.
- Known issue: `aos-orch serve` can hold a goal's lock without ticking it; use `run` or `serve`, not both.
