# What a real run looks like

Real goals, run with the real `claude` binary against throwaway repos. Nothing here is mocked. Numbers come straight from each goal's `report.md`, `tasks.json` and `events.ndjson`. Costs are notional USD (list price), not money spent on a subscription. Paths are shown with `~`.

1. [Slugify](#1-add-a-slugify-cli-4-tasks-all-haiku): small, planner plus four Haiku workers.
2. [tinymd](#2-tinymd-fenced-code-nested-blockquotes-escaping-a-bigger-run): a bigger goal in an existing library, mixed Haiku and Sonnet.
3. [Later runs](#3-later-runs-same-night-real-claude-worker-sandbox-on-self-check-on): two more all-Haiku goals, the comparison, and what blocked.

## 1. Add a slugify CLI (4 tasks, all Haiku)

The goal, in one sentence, was: add `slugify.mjs` (a stdin-to-stdout slug CLI) with tests and a README section, leave `greet.mjs` and its tests alone. The repo was a throwaway (`~/aos-throwaway-repo`, base `main`), run with the `node-library` profile and limited to the Haiku tier. The goal file had four success criteria: `node --check slugify.mjs`, `node --test slugify.test.mjs`, the full `node --test`, and one human-verified ("the README documents piped stdin with an example").

### The plan the human reviewed

One Opus planner call (10,349 new tokens, about 43 s, read-only tools) proposed four tasks. This is what `aos-orch plan <id>` shows before anything runs (descriptions shortened here; the real screen prints them in full):

```
task t1-slugify  tier=haiku  scope=slugify.mjs, slugify.test.mjs
  check (sandboxed, 30s): node --check slugify.mjs
  check (sandboxed, 60s): node --test slugify.test.mjs
task t2-readme  tier=haiku  scope=README.md  after=t1-slugify
  check (sandboxed, 60s): node --test slugify.test.mjs
task t3-isoweek-impl  tier=haiku  scope=isoweek.mjs
  BEYOND THE PROMPT (heuristic, informational): scope isoweek.mjs is not mentioned in the goal text; check it is intended
  check (sandboxed, 60s): node --test isoweek.test.mjs
task t4-integration-check  tier=haiku  scope=slugify.mjs, slugify.test.mjs  after=t1-slugify,t2-readme,t3-isoweek-impl
  check (sandboxed, 120s): node --test
rules 062b4179b3d0  profile=node-library
  limits: $1, 150000 tokens, 1200s, 3 attempts/task, 1 parallel
```

The planner also listed its own risks. The important one: `isoweek.test.mjs` already existed in the repo but `isoweek.mjs` did not, so the "existing tests still pass" criterion could never pass without a task the prompt had not asked for. It added t3 for that, the review screen flagged it as beyond the prompt, and the human approved the plan knowing why. That is the point of the gate: nothing ran until a person had read it.

### What happened

| task | tier | attempts | new tokens | result |
|---|---|---|---|---|
| t1-slugify | haiku | 1 | 9,515 | checks passed, merged |
| t2-readme | haiku | 1 | 5,309 | checks passed, merged |
| t3-isoweek-impl | haiku | 1 | 5,956 | checks passed, merged |
| t4-integration-check | haiku | 1 | 8,177 | no edits needed, checks passed |

Timeline from `events.ndjson` (UTC, one session):

```
20:28:31  goal.created                      4 criteria
20:28:31  planner started (opus)            read-only tools
20:29:14  plan created, awaiting approval   4 tasks
20:30:20  plan approved by the human        t1 starts (one worker at a time)
20:30:30  t1 worker exited -> checks passed -> merged into aos/<goal>/integration
20:30:40  t2 checks passed -> merged
20:30:49  t3 checks passed -> merged
20:31:03  t4 checks passed; 3 criteria met by the engine
20:31:04  goal blocked: awaiting human confirmation: readme-section
20:32:19  human ran `aos-orch confirm`      goal achieved
```

The engine ran one worker at a time here (`max_parallel` 1). After the plan was approved the four tasks took 43 seconds of wall clock. The goal waited a further 75 seconds for the human to confirm the README criterion.

Totals: 39,306 new tokens (10,349 planner plus 28,957 workers), 145,367 cache-read tokens, 5 workers started, notional cost $0.1455 against a $1 limit and a 150,000-token cap. No approvals were requested and no policy denials occurred.

### The result

The engine's own diffstat for the integration branch (`git diff --stat main..aos/<goal>/integration` in `~/aos-throwaway-repo`):

```
 README.md        | 11 +++++++++++
 isoweek.mjs      | 20 ++++++++++++++++++++
 slugify.mjs      | 19 +++++++++++++++++++
 slugify.test.mjs | 35 +++++++++++++++++++++++++++++++++++
 4 files changed, 85 insertions(+)
```

Six commits on the integration branch (an `aos: <task> attempt 1 (haiku)` commit and an `aos: merge <task>` commit for each of the first three tasks); `main` was untouched. The final report that the engine wrote (`report.md`):

```
# Goal report: Add slugify.mjs CLI with tests and README section

- status: **achieved**
- repo: ~/aos-throwaway-repo  base: main @ a3b400adcf  integration: aos/g-20261020-add-slugify-mjs-cli-with/integration
- new tokens: 39306  cache-read tokens: 145367  workers started: 5
- notional cost (list price, NOT money spent on a subscription): $0.1455

- [x] syntax            (node --check slugify.mjs)             PASS exit=0
- [x] tests-pass        (node --test slugify.test.mjs)         PASS exit=0   6 tests, 6 pass
- [x] existing-tests-still-pass  (node --test)                 PASS exit=0   9 tests, 9 pass
- [x] readme-section    (human-verified, confirmed via CLI)

| task | status | tier | attempts | new tokens | outcomes |
| t1-slugify | done | haiku | 1/3 | 9515 | 1:haiku:success |
| t2-readme | done | haiku | 1/3 | 5309 | 1:haiku:success |
| t3-isoweek-impl | done | haiku | 1/3 | 5956 | 1:haiku:success |
| t4-integration-check | done | haiku | 1/3 | 8177 | 1:haiku:success |

Approvals: none.   Policy denials: none.
```

The report ends with the three `git` commands to review and merge. The engine never merges into your base branch; that step is yours.

## 2. tinymd: fenced code, nested blockquotes, escaping (a bigger run)

A zero-dependency Node markdown converter with 10 existing tests. The goal: add fenced code blocks (with an optional language), nested blockquotes with inner markdown parsed, and HTML escaping by implementing an `escapeHtml` stub, with the 10 existing tests unchanged and new tests added. It had a 600,000-token cap and up to 3 parallel workers; the planner made the four tasks a serial chain, each depending on the one before.

| task | tier | scope | attempts | new tokens |
|---|---|---|---|---|
| t1-escape | haiku | `src/util.mjs`, `src/render.mjs`, `test/escape.test.mjs` | 1 | 12,937 |
| t2-fenced (after t1) | sonnet | lexer, parser, renderer, `test/fenced.test.mjs` | 1 | 11,839 |
| t3-blockquote (after t2) | sonnet | lexer, parser, renderer, `test/blockquote.test.mjs` | 1 | 10,980 |
| t4-readme (after t3) | haiku | `README.md` | 1 | 17,476 |

- Every task passed on its first attempt; no escalation, no retries, no approvals.
- Planner 14,568 plus workers 53,232 = 67,800 new tokens of the 600,000 cap (205k cache-read tokens), notional cost $0.3315.
- Timing (one session, UTC): goal created 21:45:10, plan ready 21:46:13 (about a minute of planning), plan approved 21:47:02, all four tasks done by 21:48:53 (1 min 52 s of execution), then the goal waited for two human-verified criteria until they were confirmed at 21:53:34.
- Result: the full suite, `npm test`, passes with 33 of 33 tests; the 10 original tests are byte-identical to the base commit.
- Integration diffstat: 8 files, 199 insertions, 7 deletions (`README.md` +51, `src/lexer.mjs`, `src/parser.mjs`, `src/render.mjs`, `src/util.mjs`, and three new test files of 35 to 37 lines each).

## 3. Later runs, same night (real `claude`, worker sandbox on, self-check on)

Condensed; numbers from each goal's report and events.

| goal | outcome | tasks | new tokens | wall time | tests |
|---|---|---|---|---|---|
| e2e2 A: fix clamp bug, add words and groupBy, README | achieved | 5, all haiku, all first attempt | 47.5k | about 305 s | 25/25, original tests untouched |
| e2e2 B: shopkit, fix formatCents padding, add parseCents and removeItem, README | achieved | 5, all haiku, all first attempt | 53.1k | about 230 s | 29/29 |
| tinymd (section 2) | achieved | 4 (haiku, sonnet, sonnet, haiku) | 67.8k | | 33/33 |
| dashboard dogfood, `aos-dash --json` | achieved | | 61.5k | | mergeable patch |

- e2e2 A: 8 self-checks ran; anti-cheat clean (5 passes, 2 acceptance re-runs ok).
- e2e2 B: anti-cheat clean.
- Plain `claude` vs the orchestrator on the same goal: both passed the test-editing trap. Plain was faster. The orchestrator isolates the work on a branch. Running the comparison exposed reliability issues in the orchestrator, which were then fixed.

Runs that blocked that night, and why:

- Ordering and stale base (2 goals): a task ran the whole test suite before other tasks' work was merged, and retries reused the first attempt's out-of-date base. Both are fixed: every attempt now branches fresh from the integration tip, and a task with a whole-suite check automatically waits for every task that changes code.
- Unsatisfiable test: the protected re-run of the original tests failed, so the goal correctly blocked instead of passing.
- Server test: an existing test that starts a local server cannot pass in the check sandbox (loopback issue, since fixed with `checks.allow_loopback`).

## What to take from this

- Cost: runs 1 (slugify, 39.3k new tokens, $0.15) and 2 (tinymd, 67.8k, $0.33) together used about 107k new tokens (notional $0.48); the later runs in section 3 are not included. The planner is the single largest line item because it runs on Opus; workers start on the cheapest tier that the plan allows.
- The gate is real: the plan review is where the human catches scope growth (the slugify plan added a file the prompt never mentioned) before any worker runs.
- Checks, not the worker's say-so, decide whether a task is done. In the slugify run the Haiku workers were not allowed to run commands, and said so in their summaries; the engine ran the real `node --test` commands in the sandbox and merged only what passed.
- These are small goals on small repos. They show the mechanism works end to end; they are not evidence about large refactors or flaky test suites.
