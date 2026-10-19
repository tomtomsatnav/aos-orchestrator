#!/usr/bin/env bash
# E5b/E7b: approvals. A PreToolUse hook that blocks for 8 s then allows (timeout 10 s), and one that outlives
# its timeout. Also: does a PreToolUse "allow" let a command outside --allowedTools run in headless mode?
set -euo pipefail
SPIKE="$(cd "$(dirname "$0")" && pwd)"; T="${TMPDIR%/}"; WT="$T/orch-spike-repo.worktrees/t1"
cat > "$SPIKE/out/settings.approval.json" <<JSON
{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node $SPIKE/lib/approval-hook.mjs", "timeout": 10 }] }] } }
JSON
: > "$SPIKE/out/approval.ndjson"
node "$SPIKE/lib/run-worker.mjs" e6 "$WT" --env AOS_SPIKE_LOG="$SPIKE/out/approval.ndjson" -- \
  -p "Run two Bash commands, one at a time, exactly as written: first 'touch a.txt', then 'touch b.txt'. Then report each result and any error text verbatim." \
  --model haiku --output-format json --max-turns 4 \
  --setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools "Bash" --allowedTools "Read" \
  --settings "$SPIKE/out/settings.approval.json"
ls -la "$WT/a.txt" "$WT/b.txt" 2>&1 || true
