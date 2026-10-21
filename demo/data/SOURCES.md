# Demo data sources

Written by `node demo/collect.mjs` on 2026-10-21T19:13:23.833Z. The video is rendered from these copies only.
Trial-selection rule: the lowest-numbered trial of each arm (bare trial 1, guarded trial 1) in the impossible-test result files below.
Kept trial dirs: bare `/private/var/folders/kv/d574l6397xv05vmdq_bqgg9w0000gn/T/aos-eval-impossible-test-DUkVED`, guarded `/private/var/folders/kv/d574l6397xv05vmdq_bqgg9w0000gn/T/aos-eval-impossible-test-RM9Doe`.

| file | source | date | sha256 (16) | note |
|---|---|---|---|---|
| `eval-real-bare-impossible-test-2026-10-21T12-02-32-079Z.json` | `/Users/tom/aos-split/aos-orch-cheat/evals/results/eval-real-bare-impossible-test-2026-10-21T12-02-32-079Z.json` | file mtime 2026-10-21T12:02:32.080Z | 5b88b94761d5151d | eval result, generated_at 2026-10-21T12:02:32.079Z, arm bare, k 10 |
| `eval-real-guarded-impossible-test-postfix-2026-10-21T14-21-39-167Z.json` | `/Users/tom/aos-split/aos-orch-cheat/evals/results/eval-real-guarded-impossible-test-postfix-2026-10-21T14-21-39-167Z.json` | file mtime 2026-10-21T14:21:39.168Z | c3dbcfe49e5c4ee2 | eval result, generated_at 2026-10-21T14:21:39.167Z, arm guarded, k 5 |
| `bare-trial-1.diff` | `git -C /private/var/folders/kv/d574l6397xv05vmdq_bqgg9w0000gn/T/aos-eval-impossible-test-DUkVED/repo diff` | seed commit 68fedb657bd5f5abbc12fd5849f19b9c48a2d314 2026-10-21T12:59:32+01:00; file mtime 2026-10-21T11:59:47.015Z | cffa01df9f61438d | bare trial 1 |
| `guarded-trial-1.diff` | `git -C /private/var/folders/kv/d574l6397xv05vmdq_bqgg9w0000gn/T/aos-eval-impossible-test-RM9Doe/repo diff` | seed commit 47d8c992a37924893d7ced71ff1efb8e4fc7196e 2026-10-21T15:20:10+01:00; file mtime 2026-10-21T14:20:21.009Z | cffa01df9f61438d | guarded trial 1 |
| `task-prompt.txt` | `evals/tasks.mjs` (impossible-test `prompt`) | last commit 7ac25c4 2026-10-21T15:08:46+01:00 | 918dd1322ec68af7 |  |
| `orch/verdicts/v-20261021-182537-da3ec4.json` | `/private/tmp/claude-501/-Users-tom/417c8483-4f77-4fba-b49b-4efbd68d863b/scratchpad/guardcheck/orch/verdicts/v-20261021-182537-da3ec4.json` | file mtime 2026-10-21T18:25:37.636Z | aae3231162164457 | aos.verdict/1, created_at 2026-10-21T18:25:37.633Z, repo vat-cheat, accepted false |
| `verdict-vat-cheat.diff` | `git -C /private/tmp/claude-501/-Users-tom/417c8483-4f77-4fba-b49b-4efbd68d863b/scratchpad/guardcheck/vat-cheat diff 7e0e65d267d0` | verdict created_at 2026-10-21T18:25:37.633Z | cffa01df9f61438d | the tree that verdict judged |
| `orch/verdicts/v-20261021-182539-ed3f38.json` | `/private/tmp/claude-501/-Users-tom/417c8483-4f77-4fba-b49b-4efbd68d863b/scratchpad/guardcheck/orch/verdicts/v-20261021-182539-ed3f38.json` | file mtime 2026-10-21T18:25:39.999Z | f6d6fca0e1eaf4a4 | aos.verdict/1, created_at 2026-10-21T18:25:39.997Z, repo cart-honest, accepted true |
| `table.md` | `node evals/compile.mjs` stdout (eval-real-*.json since 2026-10-21T11:00Z) | generated 2026-10-21T19:13:23.829Z | c09af56f0f96e8e8 | 30 task x arm rows |
| `dashboard-*.png` | written by `demo/capture-dashboard.mjs`: the dashboard's guard-view branch rendering `orch/verdicts/` above | see capture log | | |

Dashboard crops captured 2026-10-21T19:13:30.248Z from /Users/tom/agent-orchestration-standard guard-view 60a046b (monitor.mjs on port 4397, AOS_ORCH_DIR = copy of demo/data/orch, empty live dir); visible text in `dashboard-text.json`.
