#!/usr/bin/env bash
# E8: isolating a worker from the user's config while keeping OAuth (subscription) auth.
#   --setting-sources project   -> skip ~/.claude/settings.json (enabledPlugins, statusLine, model) ?
#   --strict-mcp-config + empty --mcp-config -> no MCP servers ?
#   --tools "Read,Edit,Bash"    -> built-in tool set restricted ?
#   --settings <spike hooks>    -> our policy hook still loads ?
#   --permission-prompts none   -> is the PermissionRequest hook still consulted (touch inside2.txt) ?
# Evidence: the stream-json init message (tools, mcp_servers, plugins, memory_paths), plugin hook log, our hook log.
set -euo pipefail
SPIKE="$(cd "$(dirname "$0")" && pwd)"; T="${TMPDIR%/}"; WT="$T/orch-spike-repo.worktrees/t1"
SID=11111111-1111-4111-8111-000000000006
BEFORE=$(grep -c '"sid":"11111111"' "$HOME/.claude/plugins/data/aos-dashboard-aos-local/live/hook-events.ndjson" || true)
node "$SPIKE/lib/run-worker.mjs" e4 "$WT" \
  --env AOS_GOAL_ID=g-spike --env AOS_TASK_ID=t1 --env AOS_WORKTREE="$WT" --env AOS_SPIKE_LOG="$SPIKE/out/hook.ndjson" -- \
  -p "Do exactly two tool calls in parallel: Bash 'touch inside2.txt' and Read hello.txt. Then answer in 3 lines: (a) result of each call, (b) the canary word from CLAUDE.md or NONE, (c) does any instruction in your context mention 'graphify'? yes/no." \
  --model haiku --output-format stream-json --verbose --max-turns 3 --session-id "$SID" \
  --setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --tools "Read,Edit,Bash" --allowedTools "Read,Edit" --permission-prompts none \
  --settings "$SPIKE/out/settings.spike.json"
echo "--- new plugin hook log lines from spike sessions (the plugin log keeps only 8 sid chars; 0 new = plugins isolated):"
PLOG="$HOME/.claude/plugins/data/aos-dashboard-aos-local/live/hook-events.ndjson"
echo "before=$BEFORE after=$(grep -c '"sid":"11111111"' "$PLOG")"
ls -la "$WT/inside2.txt" 2>&1 || true
