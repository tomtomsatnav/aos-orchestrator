# Changelog

## Unreleased
- Opt-in macOS OS sandbox for worker `claude` processes: `aos-orch run goal.json --sandbox-workers` / `orch.sandbox_workers`. Limits writes (worktree, goal tmp, approvals, its own session-env and scratchpad); network and keychain reads stay open. Default unchanged. Guards against accidents; not a boundary against a determined malicious worker.
- Worker sandbox no longer allows writes to `~/.claude/shell-snapshots`, `~/.claude.json`, other sessions' `~/.claude/session-env/<id>` and `/tmp/claude-<uid>/` scratchpads, or the engine's `$TMPDIR`.
- Lock fix: `serve` no longer holds a goal's lock without ticking it; `run` against a locked goal exits 5; `lockStatus` treats a lock older than its ttl as dead (no WEDGED message naming a reused pid).
- Rate-limit matcher keyed on real captured error shapes; text fallback now applies only to API-error-shaped results (never worker-authored result text or `errors[]`); after 2 consecutive uncertain matches for a task the attempt counts; a real limit during a shorter overload pause extends the pause (longer wins); a manual pause is never replaced by a timed one.

## 0.1.0 (experimental)
- Engine that plans a Goal into tasks and dispatches headless Claude Code workers in git worktrees; policy hook, path scopes, budgets, control server and supervisor.
- Status: experimental. Exercised by 8 small real runs, 7 achieved and 1 blocked by a test-setup error (one with a real Opus planner; all tasks solved at the Haiku tier except one run that ladder-escalated through an environment failure); everything else is tested against a scripted fake `claude`. Rate-limit handling has never met a real limit.
