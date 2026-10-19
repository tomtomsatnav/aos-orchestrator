#!/usr/bin/env bash
# E1/E2/E4/E6: a worker in the task worktree, JSON output, AOS_* env, our hooks via --settings.
# Checks: result JSON fields, edit lands only in the worktree, hooks (ours + installed plugin) see the env,
# CLAUDE.md in the worktree is loaded, --append-system-prompt / --max-turns / --session-id accepted.
set -euo pipefail
SPIKE="$(cd "$(dirname "$0")" && pwd)"; T="${TMPDIR%/}"; WT="$T/orch-spike-repo.worktrees/t1"
SID=11111111-1111-4111-8111-000000000001
node "$SPIKE/lib/run-worker.mjs" e1 "$WT" \
  --env AOS_GOAL_ID=g-spike --env AOS_TASK_ID=t1 --env AOS_WORKTREE="$WT" --env AOS_SPIKE_LOG="$SPIKE/out/hook.ndjson" -- \
  -p "Edit hello.txt so its only line is exactly: hello world. Then run: sh test.sh && echo PASS. Finally reply with one line: the canary word from CLAUDE.md (or NONE)." \
  --model haiku --output-format json --max-turns 4 --session-id "$SID" \
  --allowedTools "Read,Edit,Bash(sh test.sh:*),Bash(echo:*)" \
  --append-system-prompt "You are an AOS worker. Stay inside the current directory." \
  --settings "$SPIKE/out/settings.spike.json"
echo "--- main checkout (must be unchanged):"; cat "$T/orch-spike-repo/hello.txt"
echo "--- worktree:"; cat "$WT/hello.txt"; git -C "$WT" status --short
echo "--- plugin hook log lines for this session:"
grep -c '"sid":"11111111"' "$HOME/.claude/plugins/data/aos-dashboard-aos-local/live/hook-events.ndjson" || true
grep '"sid":"11111111"' "$HOME/.claude/plugins/data/aos-dashboard-aos-local/live/hook-events.ndjson" | head -3 || true
