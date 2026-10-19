#!/usr/bin/env bash
# E1 (budget flag): --max-budget-usd with a cap far below one turn's notional cost. How is it reported?
# Isolated flags (as in 04) keep the call small. On a subscription, total_cost_usd is a notional list-price figure.
set -euo pipefail
SPIKE="$(cd "$(dirname "$0")" && pwd)"; T="${TMPDIR%/}"; WT="$T/orch-spike-repo.worktrees/t1"
node "$SPIKE/lib/run-worker.mjs" e5 "$WT" -- \
  -p "Read hello.txt, then CLAUDE.md, then test.sh, one per turn, then summarise them in one line." \
  --model haiku --output-format json --max-turns 4 --max-budget-usd 0.0005 \
  --setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools "Read" --allowedTools "Read"
