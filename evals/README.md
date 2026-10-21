# Model-behaviour evals (opt-in)

Not part of `npm test`: `npm test` only globs `orchestrator/test/*.test.mjs` and never touches this folder.

```sh
node evals/run.mjs --fake --k 1                     # harness check against orchestrator/test/fake-claude.mjs (no model calls)
node evals/run.mjs --k 3 --tier haiku               # REAL: 4 tasks x 3 trials, calls the real claude CLI and uses plan quota
node evals/run.mjs --k 3 --task fix-add,add-slugify --timeout-s 900 --out evals/results
```

Each trial builds a fresh seed repo and orch dir, then runs `aos-orch draft` (profile and `--tier` from the task / flag) and
`aos-orch run --no-wait --auto-approve --sandbox-workers`. If the plan has commands (never auto-approved) the harness runs `approve-plan` as the human
stand-in and records `plan_needed_approval`. If the goal parks on `verify:"human"` criteria the harness runs the grader first and, only if it passes,
`aos-orch confirm`s each pending criterion and resumes the run, recording them in `human_confirm`. Token usage is read from the goal even when a trial times out. The integration branch is exported with `git archive` and a deterministic grader (`tasks.mjs`) reads the
files. A trial passes when the grader passes, whatever the goal status says. `--tier` is the worker start tier; the planner uses the rules' `plan.planner_tier`.

Output: a markdown table on stdout and `evals/results/eval-<mode>-<time>.{json,md}` (git-ignored): per task passes/k, pass^k (all k trials passed),
mean new tokens (planner + workers, from `goal.orch.usage`; the draft call is not counted) and mean wall time, plus every trial with its failure reason.
Graders of code tasks load model-written modules in a `vm` context with a 1 s timeout: that is not a security boundary, so run real evals on a machine where
that is acceptable. Add a task by appending to `TASKS` (seed, prompt, grader, and a `fake` draft/plan/edits for `--fake`).
