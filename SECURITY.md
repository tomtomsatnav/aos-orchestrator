# Security policy

Report vulnerabilities privately through GitHub: Security tab, "Report a vulnerability" (private vulnerability reporting). Please do not open a public issue. This is a personal project, so expect a best-effort response.

## Threat model summary

This is experimental software that launches real `claude` workers able to run commands in your repo. Guardrails are enforced outside the model: a policy hook (deny rules, per-task grants, default deny), per-task `path_scope`, OS-sandboxed acceptance checks and token/time/attempt budgets. The worker `claude` process itself is **not** OS-sandboxed, only restricted by the policy hook and isolation flags. Workers never commit or merge; the engine works on its own `aos/<goal>/integration` branch and never pushes. The control server binds 127.0.0.1.

**Run it on throwaway repos or clones only.** Policy bypasses, path-scope escapes and control-server auth issues are in scope.
