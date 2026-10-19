#!/usr/bin/env bash
# Creates the throwaway repo + one task worktree + the --settings file used by the experiments.
set -euo pipefail
SPIKE="$(cd "$(dirname "$0")" && pwd)"
T="${TMPDIR%/}"
REPO="$T/orch-spike-repo"; WTROOT="$T/orch-spike-repo.worktrees"
rm -rf "$REPO" "$WTROOT"; mkdir -p "$REPO" "$SPIKE/out"
cd "$REPO"
git init -q -b main
printf 'hello\n' > hello.txt
printf '#!/bin/sh\ngrep -qx "hello world" hello.txt\n' > test.sh; chmod +x test.sh
printf '# Spike repo\nCanary: if asked for the canary word, answer PINEAPPLE.\n' > CLAUDE.md
git add -A && git -c user.name=spike -c user.email=spike@example.invalid commit -qm init
git worktree add -q -b aos/spike/t1 "$WTROOT/t1" main
# settings passed with --settings: only our hooks (user/plugin config still loads unless isolated)
H="node $SPIKE/lib/spike-hook.mjs"
cat > "$SPIKE/out/settings.spike.json" <<JSON
{ "hooks": {
  "SessionStart":      [{ "hooks": [{ "type": "command", "command": "$H" }] }],
  "PreToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$H", "timeout": 30 }] }],
  "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$H", "timeout": 30 }] }],
  "PostToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$H" }] }]
} }
JSON
: > "$SPIKE/out/hook.ndjson"
git worktree list
echo "REPO=$REPO WT=$WTROOT/t1"
