# Relay spike: stopping a leg at a context budget

Probes run on 7 Nov 2026 before building the relay (one agent across a chain of fresh sessions, see the relay PR). They check the facts the
relay's design depends on against the installed CLI.

- **CLI:** Claude Code 2.1.319, Linux (cloud container), Node 22, `--model claude-haiku-5-5`, each run with its own empty `CLAUDE_CONFIG_DIR`.
- **Budget used:** about $0.95 notional (list price) across 13 headless calls. $0.65 of it was one botched run (P4, first attempt, below).
- **Repo:** a throwaway git repo of ten 75 KB filler files (`f1.txt` to `f10.txt`, random words). Nothing outside the scratch dir was touched.
- Raw transcripts and outputs were not kept (local paths); the numbers below are copied from them.

## Files

| File | What it does |
|---|---|
| `ctx.mjs` | Prints the context size of each main-chain assistant record in a transcript (`input + cache_creation + cache_read`) and every compaction record |
| `budget-hook.mjs` | The P1 hook (PostToolUse and PostToolUseFailure): reads the last 256 KB of `transcript_path`, takes the latest assistant usage, adds the tool response size / 3.5, and past `AOS_RELAY_THRESHOLD` injects the handoff instruction once (marker file) |
| `kill-resume.mjs` | The P4 run: a leg spawned `detached`, SIGKILL to its process group after 3 steps, exit confirmed, then `--resume <session> --tools Write --max-turns 3` writes the note |

## Results

| # | Question | Observed | Verdict |
|---|---|---|---|
| P0 | Does a nested `claude -p` log in with its own `CLAUDE_CONFIG_DIR`? | Yes. `PONG` for $0.0035. `modelUsage` reports `contextWindow: 1000000` for Haiku 5.5. | VERIFIED |
| P0b | Starting context | 42k tokens with this container's default tools and MCP servers; 41k with `--strict-mcp-config`; 33k with `--safe-mode`; **8.2k** with `--strict-mcp-config --tools "Bash,Edit,Write,Read,Glob,Grep"`. `--allowedTools` only permits, `--tools` removes the rest from the context. | VERIFIED |
| P3a | Does `--autocompact 100000` compact near 100k? | It compacts at about **80k** (`preTokens` 80,435 / 81,750 / 82,453 over three cycles), down to about 10k. Each compaction writes a `type:"system", subtype:"compact_boundary"` record with `compactMetadata.{trigger, preTokens, postTokens}`, followed by a `user` record with `isCompactSummary: true`. | VERIFIED |
| P3b | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50` with `--autocompact 100000` | Compacts at 44–56k. | VERIFIED |
| P3c | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=5`, default window (1M) | Compacts at 56–58k (and once at 89k). So the override is a percentage of the window, and a single session can be made to compact near a relay threshold. This container sets the variable to 92 by default; relay legs must unset it. | VERIFIED |
| P3d | (side observation) | After each compaction Haiku lost its place and re-read files it had already read: 23 tool calls to read 4 files in P3b. One run, not measured; the eval should. | OBSERVED once |
| P1 | Does a PostToolUse `additionalContext` instruction make the agent write a handoff note and stop? | Yes. Threshold 30k; the hook fired after a Bash call at an estimated 30.3k. The agent made **one more tool call** (a Read) and then wrote `HANDOFF.md` with every requested section, accurate down to the half-finished step ("f5 read, its line not yet appended"), and ended its turn. $0.009. | VERIFIED (n=1); a hard backstop is still needed |
| P1b | Hook payload keys (PostToolUse) | `session_id, transcript_path, cwd, scratchpad_dir, prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, tool_response, tool_use_id, duration_ms`. When the hook runs, the latest assistant record's usage does not yet include the tool result just returned, so the hook adds its size. | VERIFIED |
| P4 | After killing a leg, can `--resume <id>` (headless, `--tools Write`, `--max-turns 3`) make the agent write its own note? | Yes. 2 turns, $0.001, 14 s or less; the note was exact (3 steps done, nothing in progress, next steps right). `--max-turns` is accepted though not in `--help`. | VERIFIED |
| P4-fail-1 | First attempt | The kill condition never fired, and Haiku read all ten files in parallel batches: context reached 571k in 3 turns and the leg **finished on its own for $0.65**. Lesson: every leg needs `--max-budget-usd`, and the hook cannot stop a single turn that adds hundreds of thousands of tokens. | — |
| P4-fail-2 | Second attempt | `kill -KILL -- -$PID` on a `setsid claude …` started from bash **did not stop the leg**: `setsid` forked, so the signal went to an empty group. The leg kept working while the resumed session wrote its note, both appending to the same transcript, and the note was out of date at once. Lesson: spawn legs from Node with `detached: true`, kill the group, and wait for the `exit` event before resuming. | — |

## What this changes in the relay design

- Legs run with `--strict-mcp-config --tools <list>` (8k starting context) and `--max-budget-usd`, with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` unset and `--autocompact` above the threshold.
- The hook alone is enough on Haiku in this probe; the backstop is the relay watching the transcript, killing the process group at a hard cap, confirming the exit, then resuming for the note.
- The single-session comparison arm can compact near the same size: `--autocompact 100000` with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` set (P3b), or the percentage alone on the 1M window (P3c).
- Compaction is detected from `compact_boundary` records, for every leg in every arm.
