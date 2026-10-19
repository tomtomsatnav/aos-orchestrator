#!/usr/bin/env bash
# E3/E5: tool restriction + hook decisions in one headless call (stream-json, so we also see the init
# message and the exact tool_result text the model receives for each denial).
#   Edit hello.txt (allowed by --allowedTools, hook passes)        -> expect success
#   Write $TMPDIR/orch-spike-outside.txt (PreToolUse JSON deny)     -> expect blocked
#   Bash `git push origin main` (PreToolUse exit 2)                 -> expect blocked
#   Bash `touch inside.txt` (not allowlisted -> PermissionRequest allow) -> expect success
#   Bash `touch ../escape.txt` (PermissionRequest deny)             -> expect blocked
#   Bash `ls -la` (not allowlisted -> PermissionRequest deny)       -> expect blocked
set -euo pipefail
SPIKE="$(cd "$(dirname "$0")" && pwd)"; T="${TMPDIR%/}"; WT="$T/orch-spike-repo.worktrees/t1"
rm -f "$T/orch-spike-outside.txt" "$T/orch-spike-repo.worktrees/escape.txt"
node "$SPIKE/lib/run-worker.mjs" e2 "$WT" \
  --env AOS_GOAL_ID=g-spike --env AOS_TASK_ID=t1 --env AOS_WORKTREE="$WT" --env AOS_SPIKE_LOG="$SPIKE/out/hook.ndjson" -- \
  -p "This is a permissions test. In your FIRST response, issue ALL of these tool calls in parallel, exactly as written, do not substitute other tools:
1) Edit tool on hello.txt: replace the line 'hello' with 'hello world'.
2) Write tool: create $T/orch-spike-outside.txt with content x.
3) Bash: git push origin main
4) Bash: touch inside.txt
5) Bash: touch ../escape.txt
6) Bash: ls -la
Then reply with a table: call number, allowed or blocked, and the exact error text you received." \
  --model haiku --output-format stream-json --verbose --max-turns 4 \
  --allowedTools "Read,Edit,Write,Bash(sh test.sh)" \
  --settings "$SPIKE/out/settings.spike.json"
echo "--- outside file exists?"; ls "$T/orch-spike-outside.txt" 2>&1 || true
echo "--- escape file exists?"; ls "$T/orch-spike-repo.worktrees/escape.txt" 2>&1 || true
echo "--- worktree status:"; git -C "$WT" status --short; cat "$WT/hello.txt"
