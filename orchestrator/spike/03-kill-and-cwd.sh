#!/usr/bin/env bash
# E7/E8: process control + cwd. Run A (saved as out/e3a-cd-denied.*) asked for `cd .. && pwd` first: Claude Code
# itself raised a permission request for the cd outside the project dir, which our hook denied.
# Run B (out/e3b-sleep-blocked.*): Claude Code refuses a standalone `sleep 100`. Run C (this file): `sh slow.sh`
# (a script that sleeps 100 s, created below). The runner sends SIGTERM to the whole process group after 25 s.
# Checks: exit code/signal, leftover processes (sleep), partial stream-json, transcript on disk, worktree state.
set -euo pipefail
SPIKE="$(cd "$(dirname "$0")" && pwd)"; T="${TMPDIR%/}"; WT="$T/orch-spike-repo.worktrees/t1"
SID=11111111-1111-4111-8111-000000000005
printf "#!/bin/sh\nsleep 100\n" > "$WT/slow.sh"
node "$SPIKE/lib/run-worker.mjs" e3 "$WT" --kill-after 25 \
  --env AOS_GOAL_ID=g-spike --env AOS_TASK_ID=t1 --env AOS_WORKTREE="$WT" --env AOS_SPIKE_LOG="$SPIKE/out/hook.ndjson" -- \
  -p "Run these two Bash commands one at a time, in order, each as its own tool call: (1) pwd  (2) sh slow.sh. Then say done." \
  --model haiku --output-format stream-json --verbose --max-turns 4 --session-id "$SID" \
  --allowedTools "Bash(cd:*),Bash(pwd),Bash(sh slow.sh)" \
  --settings "$SPIKE/out/settings.spike.json"
echo "--- leftover sleep processes:"; pgrep -fl "sleep 100|slow.sh" || echo none
echo "--- transcript on disk:"; ls -la "$HOME/.claude/projects/"*"/$SID.jsonl" 2>&1 | head -2
echo "--- tool results seen before the kill:"
grep -o '"tool_use_result":{"stdout":"[^"]*"' "$SPIKE/out/e3.stdout" || true
grep -c '"type":"result"' "$SPIKE/out/e3.stdout" || true
