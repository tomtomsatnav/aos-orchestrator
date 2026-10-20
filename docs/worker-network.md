# Worker network isolation: Claude Code's Bash sandbox plus the sandbox-exec profile

Status: research only, no code changed. Written 2026-10-20 against `claude` 2.1.304 and
<https://code.claude.com/docs/en/sandboxing> (read 2026-10-20). Addresses Gap 2 / rows 14 and 15 of `best-practices-alignment.md`.

## 1. Today

- `worker.mjs` `buildSettings` writes only `{hooks: {PreToolUse, PermissionRequest}}` into `workers/settings.json` (passed with `--settings`).
  Claude Code's own Bash sandbox is not used.
- The opt-in worker `sandbox-exec` profile (`sandbox.mjs` `buildWorkerProfile`, `--sandbox-workers`, macOS only) limits writes but ends with
  `(allow network*)`, because `claude -p` itself needs `api.anthropic.com` and sandbox-exec cannot filter by host name.
- So a worker's Bash children (and the `claude` process) can reach any host. The only control on the Bash leg is the policy hook's shell parser
  (read-only allowlist, `curl`/`wget`/`nc`/`ssh` denied).

## 2. What Claude Code's sandbox offers (from the docs)

Settings live under `sandbox` in a settings file. The keys that matter here:

| Key | Meaning |
|---|---|
| `sandbox.enabled` | Turn the Bash sandbox on (Seatbelt on macOS, bubblewrap + socat on Linux/WSL2). |
| `sandbox.failIfUnavailable` | Exit at startup instead of silently running Bash unsandboxed when the sandbox cannot start (default is to run unsandboxed). |
| `sandbox.allowUnsandboxedCommands` | `false` removes the `dangerouslyDisableSandbox` retry escape hatch. |
| `sandbox.autoAllowBashIfSandboxed` | Default true: sandboxed Bash needs no permission prompt. |
| `sandbox.network.allowedDomains` / `deniedDomains` | Hosts the proxy allows. Allowed domains start empty. |
| `sandbox.network.strictAllowlist` | (v2.1.219+, honoured from user, managed and `--settings` only, ignored in a repo's `.claude/settings*.json`) hosts outside the allowlist are refused instead of prompting. |
| `sandbox.filesystem.allowWrite` / `denyRead` / `allowRead` | Paths for Bash children. |
| `sandbox.excludedCommands`, `enableWeakerNestedSandbox`, `network.allowLocalBinding`, `network.allowAllUnixSockets` | Each weakens or bypasses the sandbox. A repo's settings cannot set the weakening ones when the sandbox is admin-required; AOS also refuses repos that carry any settings keys. |

Mechanism: Bash children have no direct route out. All traffic goes to a proxy that Claude Code runs on the host, outside the sandbox; the proxy
checks the requested hostname against the lists. `curl`, `npm` and `git` over HTTPS use it; `ssh`, most DB drivers, UDP and ICMP cannot connect at all.

What it does NOT cover (docs, "What runs outside the sandbox"): the Read/Edit/Write/WebFetch/WebSearch tools (permission rules apply, not the sandbox),
hooks, MCP servers, and the `claude` process itself. AOS workers are started with `--tools Read,Edit,Write,Glob,Grep,Bash` (no WebFetch/WebSearch),
an empty MCP config and the AOS policy hook, so the Bash tool is the only network-capable leg left.

Stated limits: the proxy decides from the client-supplied hostname and does not inspect TLS, so domain fronting can reach a host outside the list.
An allowed `api.anthropic.com` is itself an exfiltration channel for anything the worker can read (it is the model API the worker talks to anyway).

## 3. Probes (2 real calls, empty temp dir, `claude -p --model haiku --max-turns 2`, run from the Claude Code CLI 2.1.304)

Settings file used: `{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"autoAllowBashIfSandboxed":true,"network":{"allowedDomains":[],"strictAllowlist":true}}}`
Prompt: `run: curl -sI https://example.com; report exit code`.

1. **Bash sandbox alone: network BLOCKED.** curl exited 56 and received `HTTP/1.1 403 host is not on the allow list`, `X-Proxy-Error: blocked-by-allowlist`;
   Claude Code reported `deny network-outbound example.com:443 (host is not on the allow list)`. The model did not try to work around it.
2. **Same command with the whole `claude` run inside an outer `sandbox-exec -f <(version 1)(allow default)>`: every Bash call FAILS CLOSED.**
   The shell reported exit 71, `sandbox-exec: sandbox_apply: Operation not permitted`. macOS refuses to apply a second Seatbelt profile inside one,
   so Claude Code's Bash sandbox cannot be stacked under the existing worker profile (with `allowUnsandboxedCommands: false` the command simply does not
   run; with the default it would offer the unsandboxed retry, which is worse). The outer profile in the probe was the most permissive possible, so the
   real worker profile behaves the same. `enableWeakerNestedSandbox` is documented for Linux/Docker only and was not tested.

Not probed (the budget was 2): the behaviour under `--setting-sources project --strict-mcp-config`, a Linux host, or a proxy-based variant (section 5, option B).

## 4. What combining them would give, and the risks

Intended result: filesystem confinement for the whole `claude` process (sandbox-exec) plus network confinement for Bash children (Claude Code sandbox,
empty allowlist). That is the "both halves" the staff sandboxing post asks for. Findings:

- **They cannot be stacked on macOS** (probe 2). Any plan that keeps `--sandbox-workers` and adds `sandbox.enabled` breaks every Bash call.
- **Replacing** sandbox-exec by Claude's sandbox gives network isolation for Bash but loses the write confinement of the `claude` process and of
  the Read/Edit/Write tools (those are only guarded by the AOS policy hook and `path_scope`). `sandbox.filesystem.allowWrite` only constrains Bash children.
- `failIfUnavailable: true` is mandatory, else a missing dependency (bubblewrap/socat on Linux) silently turns the feature off.
- `allowUnsandboxedCommands: false` is mandatory, else a blocked command can be retried outside the sandbox (the retry is gated by permission
  mode, and AOS runs under a hook, not an interactive prompt).
- A Bash tool whose commands are read-only (`ls`, `cat`, `grep`, `git log`...) rarely needs the network, so an empty allowlist should cost nothing;
  `git` over https/ssh and package managers are already denied by policy. Tools that ignore the proxy variables fail, which is the intent.
- Settings precedence: the AOS settings file is passed with `--settings` and `--setting-sources project` omits user settings, so a user
  `~/.claude/settings.json` cannot add domains, and repo settings are ignored for the keys that matter. AOS already refuses repos with settings keys.
- Residual: the `claude` process and the Read/Edit/Write tools keep full network (API only, by necessity); TLS-unaware proxy (domain fronting);
  Windows is unsupported by Claude Code's sandbox; Linux needs bubblewrap and socat.

## 5. Proposed change

### Option A (recommended first): a rules key that enables Claude Code's Bash sandbox, mutually exclusive with `--sandbox-workers` on macOS

Rules (`rules.mjs`): add `worker.network: 'open' | 'bash_sandbox'` (default `open`, so the default rules hash is unchanged if added like `review.*`, i.e. absent from
`DEFAULT_RULES` and declared `safe` with base `open`). It is a tightening, so a repo layer may set it; nothing may loosen it from the repo.

`worker.mjs`:

```js
export function buildSettings(hookScript, nodePath = process.execPath, { networkSandbox = false, writeDirs = [] } = {}) {
  const cmd = `${JSON.stringify(nodePath)} ${JSON.stringify(hookScript)}`;
  const entry = [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 30 }] }];
  const s = { hooks: { PreToolUse: entry, PermissionRequest: entry } };
  if (networkSandbox) s.sandbox = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false,
    network: { allowedDomains: [], strictAllowlist: true }, filesystem: { allowWrite: writeDirs } };
  return s;
}
```

(`autoAllowBashIfSandboxed: false` keeps the AOS hook's `ask`/`deny` decisions authoritative instead of letting the sandbox auto-approve.)

`engine.mjs`:
- line ~87 (`atomicWrite(.../settings.json, W.buildSettings(this.hookScript))`): pass `{ networkSandbox: compiled.worker.network === 'bash_sandbox' }`;
  `writeDirs` is the per-task worktree, which differs per task, so either write one settings file per attempt (`workers/<task>.<n>.settings.json`, like the
  policy file) or leave `filesystem.allowWrite` out and rely on the sandbox default (cwd and temp dirs writable).
- Preflight in `_workerCommand` (next to the `sandbox_workers` availability check): throw if `worker.network === 'bash_sandbox'` and
  `goal.orch.sandbox_workers` on darwin, with the message "Claude Code's Bash sandbox cannot run inside sandbox-exec (sandbox_apply: Operation not permitted)".
  On Linux there is no sandbox-exec, so the combination question does not arise; check `bwrap` and `socat` on PATH and refuse otherwise.
- Probe once per engine start: run the same `curl` check is not possible without a model, so instead verify `claude --version >= 2.1.219` (strictAllowlist) using
  the version now recorded per attempt, and refuse older.

Tests (fake claude only): settings file contains the `sandbox` block with empty `allowedDomains`, `strictAllowlist`, `failIfUnavailable`, `allowUnsandboxedCommands:false`;
the macOS combination is refused with the message above; the default rules hash is unchanged.

Accepted trade-off of option A: on macOS a goal chooses either write confinement of the whole process (`--sandbox-workers`) or network confinement
of Bash (`worker.network`), not both, until option B exists.

### Option B (both on macOS): an AOS-owned allowlist proxy and a network-restricted sandbox-exec profile

Keep sandbox-exec for the whole worker, and change its network rule from `(allow network*)` to loopback-only:

```
(deny network*)
(allow network-outbound (remote ip "localhost:PORT"))     ; PORT = the engine's CONNECT proxy
```

The engine runs a ~60-line zero-dependency `net.createServer` HTTP CONNECT proxy per engine (new `lib/netproxy.mjs`) that only tunnels to
`api.anthropic.com:443` (and whatever auth refresh needs; measure with the proxy in log-only mode first), and the worker env gets
`HTTPS_PROXY=http://127.0.0.1:PORT` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Because the client sends the hostname in CONNECT, the sandbox needs no DNS.
This confines the whole `claude` process (Bash children and the API client alike) and stacks with the write profile because it is one sandbox, not two.
Same TLS-opaque limit as Claude Code's proxy. Unknowns to verify before building: that `claude -p` honours `HTTPS_PROXY` for every request it makes,
which hosts login/refresh need, and how the hook's own `node` process behaves (it makes no network calls).

## 6. Recommendation

1. Do not stack the two sandboxes on macOS (proven to fail closed).
2. Ship option A behind `worker.network` for Linux and for macOS goals that do not use `--sandbox-workers`; document the either/or on macOS.
3. Prototype option B on macOS with a log-only proxy to learn the exact host list, then replace `(allow network*)`. It is the only variant that gives
   filesystem and network isolation together, and it also fixes the "`claude` process itself has open network" residual.
4. Keep the policy hook's `curl`/`wget`/`nc`/`ssh` denials; the sandbox is the second layer, not a replacement.
