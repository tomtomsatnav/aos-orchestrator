#!/usr/bin/env bash
# No model call: drive the policy hook directly with synthetic payloads (the pattern the real test suite will use).
# Includes a symlink escape: worktree/link -> outside dir; a Write to link/x must be denied.
set -euo pipefail
SPIKE="$(cd "$(dirname "$0")" && pwd)"; T="${TMPDIR%/}"; WT="$T/orch-spike-unit-wt"; OUTSIDE="$T/orch-spike-unit-outside"
rm -rf "$WT" "$OUTSIDE"; mkdir -p "$WT" "$OUTSIDE"; ln -s "$OUTSIDE" "$WT/link"
run() { printf '%s' "$2" | AOS_WORKTREE="$WT" AOS_SPIKE_LOG=/dev/null node "$SPIKE/lib/spike-hook.mjs" >"$O" 2>"$E"; rc=$?; \
  printf '%-34s exit=%s stdout=%s stderr=%s\n' "$1" "$rc" "$(grep -oE "\"(permissionDecision|behavior)\":\"[a-z]+\"" "$O")" "$(cat "$E")"; }
TMPD="$(mktemp -d)"; O="$TMPD/o"; E="$TMPD/e"
set +e
run "write inside"        '{"hook_event_name":"PreToolUse","cwd":"'$WT'","tool_name":"Write","tool_input":{"file_path":"a.txt"}}'
run "write ../ traversal" '{"hook_event_name":"PreToolUse","cwd":"'$WT'","tool_name":"Write","tool_input":{"file_path":"../x.txt"}}'
run "write via symlink"   '{"hook_event_name":"PreToolUse","cwd":"'$WT'","tool_name":"Write","tool_input":{"file_path":"link/x.txt"}}'
run "write ~/.claude"     '{"hook_event_name":"PreToolUse","cwd":"'$WT'","tool_name":"Edit","tool_input":{"file_path":"'$HOME'/.claude/settings.json"}}'
run "bash git push"       '{"hook_event_name":"PreToolUse","cwd":"'$WT'","tool_name":"Bash","tool_input":{"command":"git push -f origin main"}}'
run "perm touch inside"   '{"hook_event_name":"PermissionRequest","cwd":"'$WT'","tool_name":"Bash","tool_input":{"command":"touch ok.txt"}}'
run "perm touch symlink"  '{"hook_event_name":"PermissionRequest","cwd":"'$WT'","tool_name":"Bash","tool_input":{"command":"touch link/x"}}'
rm -rf "$WT" "$OUTSIDE" "$TMPD"
