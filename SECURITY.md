# Security policy

Report vulnerabilities privately through GitHub: Security tab, "Report a vulnerability" (private vulnerability reporting). Please do not open a public issue. This is a personal project, so expect a best-effort response.

## Threat model summary

This is experimental software that launches real `claude` workers able to run commands in your repo. Guardrails are enforced outside the model: a policy hook (deny rules, per-task grants, default deny), per-task `path_scope`, OS-sandboxed acceptance checks and token/time/attempt budgets. By default the worker `claude` process itself is **not** OS-sandboxed, only restricted by the policy hook and isolation flags. An opt-in macOS worker sandbox exists (`aos-orch run goal.json --sandbox-workers`, goal field `orch.sandbox_workers`): writes are limited to the task worktree, the goal's tmp dir, the approvals inbox and decision log, the Claude session/config files `claude -p` writes, and system temp; the main repo, other worktrees, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.claude/settings.json` and keychain directories are not writable. It does **not** restrict the network (`claude` needs `api.anthropic.com` and `sandbox-exec` cannot filter by host), keychain **reads** (needed for auth, so a worker shell can read the Claude credentials), or reads of `~/.claude`; other home files are unreadable. Details and verification: `orchestrator/README.md`, Security model 5. Workers never commit or merge; the engine works on its own `aos/<goal>/integration` branch and never pushes. The control server binds 127.0.0.1.

**Run it on throwaway repos or clones only.** Policy bypasses, path-scope escapes and control-server auth issues are in scope.
