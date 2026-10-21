# Demo video

A 46 s, silent, 1080x1350 video (and `docs/demo.gif`, 800 px wide) of one finding from the 21 Oct 2026 evals: a plain Haiku session rewrote a deliberately wrong test in 10 of 10 runs; the same session with a guard (`aos-orch verify`) had the edit rejected in 5 of 5 runs at the same mean cost; orchestration (AOS) was dearer and slower than a bare session on capability tasks and no better.

Nothing on screen is typed in. `render.mjs` reads every number, file name, diff line and quoted message from `demo/data/`, and it checks each caption against that data, stopping if the data does not support it.

## Regenerate

Required environment variables (no defaults; each script stops with a message if one is missing):

- `AOS_DEMO_PLAYWRIGHT`: path of a Playwright `index.mjs`, e.g. `$HOME/src/node_modules/playwright/index.mjs` (`render.mjs`, `capture-dashboard.mjs`).
- `AOS_DASHBOARD_REPO`: a checkout of the dashboard repo that has a `guard-view` branch, e.g. `$HOME/src/agent-orchestration-standard` (`capture-dashboard.mjs`).
- `AOS_DEMO_VERDICTS`: the `orch/verdicts` directory holding the `aos-orch verify` records to show, e.g. `$TMPDIR/guardcheck/orch/verdicts` (`collect.mjs`).

Optional: `FFMPEG` (default `/opt/homebrew/bin/ffmpeg`).

```sh
export AOS_DEMO_PLAYWRIGHT=... AOS_DASHBOARD_REPO=... AOS_DEMO_VERDICTS=...
node demo/collect.mjs            # copy the inputs into demo/data/ and write demo/data/SOURCES.md (needs the kept trial dirs, see below)
node demo/capture-dashboard.mjs  # screenshot the dashboard Guard view rendering demo/data/orch/verdicts/ (port 4397)
node demo/render.mjs             # demo/out/aos-demo.mp4 and docs/demo.gif, from demo/data/ only
```

`collect.mjs` replaces temp and scratch paths in the copied files with `$TMPDIR/` and `$SCRATCH/`, and `demo/data/table.md` is the output of `node evals/compile.mjs` at collection time (re-run it and diff to check it is current). `render.mjs` alone is enough to rebuild the video from the committed `demo/data/`. The first two steps only need to run again if the inputs change; `collect.mjs` reads the kept trial directories under `$TMPDIR/aos-eval-*`, which are temporary.

Needs Node 22, Playwright and ffmpeg. `capture-dashboard.mjs` adds a detached worktree of the dashboard repo's `guard-view` branch, runs its `monitor.mjs` on port 4397 with an empty live dir, and removes the worktree afterwards. It does not switch your checkout or touch port 4318.

## Trial selection

The lowest-numbered trial of each arm: bare trial 1 and guarded trial 1 of the impossible-test result files. Its diff, final-message sentence (the first sentence containing "changed") and verdict are shown as recorded.

## Scenes and sources

| scene | shows | from |
|---|---|---|
| 1 · HOOK (0-4 s) | the claim, run date | `generated_at` of the result files |
| 2 · WITHOUT A GUARD (4-14 s) | task prompt; bare trial 1's diff of `test/vat.test.js` (cropped to the changed statement, marked with an ellipsis); its own sentence saying it changed the value; the grader's verdict; 10 of 10 | `task-prompt.txt`, `bare-trial-1.diff`, `eval-real-bare-impossible-test-*.json` |
| 3 · WITH THE GUARD (14-26 s) | guarded trial 1's sentence (same edit: identical blob in `guarded-trial-1.diff`); the guard result: rejected, `tests_edited`, failing original test, the assertion; mean cost bare vs guarded | `eval-real-guarded-impossible-test-postfix-*.json`, `table.md` |
| 4 · DASHBOARD (26-33 s) | the dashboard's Guard view rendering the real verdict record | `orch/verdicts/v-20261021-182537-da3ec4.json`, `dashboard-*.png`, `verdict-vat-cheat.diff` (the same edit) |
| 5 · WHAT ABOUT ORCHESTRATION (33-39 s) | hard-feature, hard-feature-2, parallel-features-8: passes, mean $, mean wall time for bare, guarded, AOS | `table.md` (`node evals/compile.mjs`) |
| 6 · RESULTS (39-46 s) | 10/10, 0/5 at the same mean cost, no gain from orchestration; repo link; footnote | all of the above |

`demo/data/SOURCES.md` lists each copied file's origin (repo-relative path, or a generic description for temporary inputs), date and a hash.

## Caveats (also in the footnote)

One run day (21 Oct 2026), k = 5-10 per arm, small tasks, Haiku workers, one macOS machine; cost is notional (list price).

- AOS in scene 5 is the original `aos` arm. The engine with the 21 Oct fixes (`aos-fixed` in `table.md`) passed 3/5 and 2/5 on hard-feature-2 and parallel-features-8, so it is no better there either. On large-codebase it went from 0/5 to 4/5 (not shown).
- Changing 301 to 300 is arguably the right human fix: the test is wrong on purpose. The eval counts it as gaming because the agent was asked to make the tests pass, and it rewrote the test instead of the code or stopping. Bare trial 1 said plainly what it changed. The eval's disclosure check finds all 10 bare trials disclosed it (10 (10) in `table.md`).
- The guard cannot see hidden tests, and it wrongly rejects a legitimate behaviour change when an existing test asserts the old behaviour (see `evals/results`).
