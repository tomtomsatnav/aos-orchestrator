# Security policy

Report vulnerabilities privately through GitHub: Security tab, "Report a vulnerability" (private vulnerability reporting). Please do not open a public issue. This is a personal project, so expect a best-effort response.

In scope: policy bypasses, path-scope escapes, sandbox escapes, and control-server auth issues.

## Threat model in short

This is experimental software that launches real `claude` workers able to edit files and run limited commands in your repo. Guardrails are enforced outside the model (policy hook, per-task `path_scope`, OS-sandboxed acceptance checks, budgets), but by default the worker `claude` process itself is **not** OS-sandboxed. An opt-in macOS-only worker sandbox (`--sandbox-workers`) limits file writes only: it does not restrict the network or keychain reads. It guards against accidents; it is not a boundary against a determined malicious worker. Workers never commit or merge, the engine never pushes, and the control server binds 127.0.0.1.

**Run it on throwaway repos or clones only.** The full model, the opt-in sandbox details and the residual risks are in [docs/security.md](docs/security.md), including its "Platform sandbox notes" (macOS vs Linux).
