# SWE-bench Verified mini-benchmark (opt-in, real models)

Compares, on real GitHub issues graded by the projects' own hidden tests (the official `swebench` Docker harness):

| arm | what runs |
|---|---|
| `bare-haiku` | one `claude -p --model haiku` session |
| `bare-sonnet` | one `claude -p --model sonnet` session |
| `guarded` | one haiku session, then the guard (`pyguard.mjs`); a rejected tree ships nothing |
| `guarded-cascade` | haiku, then sonnet, then opus on a *capability* rejection, each in the same tree with the guard's report (`escalationPrompt` from `evals/run.mjs`); an integrity rejection stops at once |
| `guarded-best-of-3` | three independent haiku sessions in separate copies, in parallel, each asked to write a reproduction test first; each is guarded as it finishes; then a repro cross-check matrix. Reported as TWO arms from the same three attempts (no extra model calls): `guarded-best-of-3-first` (first guard-accepted attempt in completion order) and `guarded-best-of-3-repro` (repro-based selection, below). All three attempts are graded |

Session command line, `claude.claimedSuccess`, `escalationPrompt` and the cascade ladder are imported from `evals/run.mjs`; the static guard is
`orchestrator/lib/guard.mjs` `verifyTree`. Nothing in `evals/run.mjs`, `evals/tasks*.mjs` or `orchestrator/` is modified.

## Setup (done once)

```sh
uv venv --python 3.12 ~/aos-split/.swebench-venv            # system python is 3.15; Homebrew 3.12 via uv, nothing installed globally
VIRTUAL_ENV=~/aos-split/.swebench-venv uv pip install swebench datasets   # swebench 5.0.2 at setup time
~/aos-split/.swebench-venv/bin/python -I evals/swebench/prepare.py        # writes evals/swebench/subset.json (needs network: HF + Docker Hub)
```

**Docker engine.** Every Docker and harness command must use Docker Desktop (10 CPUs, 8 GB), not the shell's default Colima engine (2 CPU, 2 GB):
`DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`. The runner sets this itself for the guard and for grading (override with
`SWEBENCH_DOCKER_HOST`); it does not change the global Docker context or the shell profile. For manual commands:

```sh
export DOCKER_HOST=unix://$HOME/.docker/run/docker.sock
docker pull --platform linux/amd64 swebench/sweb.eval.x86_64.psf_1776_requests-1142:latest   # the harness pulls missing images itself too
```

Images are the published x86_64 SWE-bench eval images, run under emulation on this arm64 Mac (works; requests tests take seconds).

Data and caches live outside the repo in `~/aos-split/.swebench-data/` (`mirrors/` bare git mirrors, `work/` harness logs and reports).

## Subset rule (`prepare.py`, revision 2, 2026-10-21)

Chosen mechanically, without looking at any model's results (before revision 2 only the two pilot instances had been run, under revision 1,
which took 12 easy/medium requests+pytest instances; it was replaced to add harder issues).

0. Feasibility: published x86_64 eval image < 1.5 GB compressed (Docker Hub `full_size`; excludes xarray, scikit-learn) and a pytest-based eval
   test command (`pytest ...` or `tox ... -- ...`), because the guard's Python stage runs and parses pytest `-rA` output (excludes django's
   `runtests.py` and sympy's `bin/test`).
1. EASY half (6): difficulty `<15 min fix` or `15 min - 1 hour`, psf/requests and pytest-dev/pytest, 3 per repo, ascending issue number.
2. HARD half (6): difficulty `1-4 hours`, requests + pytest in ascending issue number; they have only 3 (requests has none), so the other 3 come
   from ONE third repo: the other Verified repo with the most feasible `1-4 hours` instances, ascending issue number. Result: **sphinx-doc/sphinx**
   (4 feasible, ahead of astropy 3 and pylint 2).

Chosen ids (also in `subset.json` with the rule text and date):

| half | instances |
|---|---|
| easy | psf__requests-1142, psf__requests-1724, psf__requests-1766, pytest-dev__pytest-5262, pytest-dev__pytest-5631, pytest-dev__pytest-5809 |
| hard | pytest-dev__pytest-5787, pytest-dev__pytest-6197, pytest-dev__pytest-10356, sphinx-doc__sphinx-8548, sphinx-doc__sphinx-9229, sphinx-doc__sphinx-9461 |

Disk: each image shows as ~3.8 GB uncompressed but shares a ~2.5 GB base; with `--prune` the runner keeps only the current instance's image
(pull before, `docker image rm` after), so the high-water mark is ~4-5 GB. The runner stops if free host disk drops below 10 GB.
Docker Hub limits anonymous registry pulls to 100 manifest requests per hour per IP; the runner retries a rate-limited pull every 5 min.

`subset.json` holds only what the agent and the guard may see: problem statement, base commit, image, the install command and the test-runner
prefix (`pytest -rA`). The hidden tests (test_patch, FAIL_TO_PASS, PASS_TO_PASS) are not in it; grading loads them inside the harness.

## How an agent works on an instance

A fresh temp repo with ONE commit holding the base commit's tree (no history, so the upstream fix cannot be read from git log). Prompt =
`problem_statement` + `\n\nFix this issue in the repository. Do not modify existing tests.` (identical for every arm). The session runs on the
host (macOS) with Edit/Bash; it does NOT have the project's Python env (the agent may build one itself; on 21 Oct sessions installed uv Pythons 3.8/3.9 and ran the
tests on the host, where forked test processes died with macOS "Python quit unexpectedly" dialogs; since then the session env sets
`no_proxy=*` and `OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES`, prompt unchanged). The model patch is the working tree's
binary diff against the base commit, untracked files included (computed with a temporary index, so the agent's own index is not touched).

## The guard on Python repos (`pyguard.mjs`)

1. `verifyTree` (orchestrator/lib/guard.mjs) with no checks: the static anti-cheat diff analysis (deleted / skipped / weakened tests, config tamper
   incl. `setup.cfg`/`tox.ini`/`conftest.py`/`pytest.ini`, literal copy). Its executable stages are JS-only (`node --test` and the
   original-JS-tests re-run), so in these repos they find nothing to run (`no_checks` warning).
2. A Python stage inside the instance's own SWE-bench image (same env as grading), `--network none`, one container per guard:
   - test files = pytest's default pattern (`test_*.py` / `*_test.py`); other new files under test dirs (e.g. sphinx `tests/roots/` fixtures)
     are not run as tests;
   - the install command made offline (`pip install --no-build-isolation --no-deps --no-index ...`);
   - **baseline**: the ORIGINAL test files related to the changed source files, on the base commit. Related = base-commit test files whose name
     contains a changed module's name, else up to 3 test files that mention it, else all test files when the repo has <= 3; at most 6 files;
   - patch applied, reinstalled, `py_compile` of changed `.py` files, the agent's own added/modified test files run (a failure that was not
     already failing at baseline = `check_failed`);
   - the original related test files restored over the tree and re-run: any test that PASSED at baseline and does not pass now =
     `protected_tests_failed` (a capability rejection, so the cascade escalates).
   The guard never sees the hidden tests: it reads the base commit, the agent's diff, the install command and `pytest -rA`.

Limits, honestly: (a) this is a regression guard plus the agent's own tests; it cannot know whether the issue is fixed, so it mostly catches
patches that break existing behaviour, don't compile/install, or tamper with tests. A patch that changes nothing relevant but breaks nothing is
accepted. (b) Tests that fail at baseline (offline, or broken in the env) are ignored: for requests-1142 only 5 of 26 tests in `test_requests.py`
pass at baseline (the same 5 are its PASS_TO_PASS), so the regression check there is thin. (c) "Related tests" is a filename/mention heuristic; it can miss the right file. (d) Overlap with grading: the
original test files the guard runs usually include the file the hidden test patch later edits, so the guard's regression check correlates with
PASS_TO_PASS (by design: both are "existing tests"), never with FAIL_TO_PASS.

## Best-of-3 with reproduction tests

A guard that cannot see the hidden tests cannot tell which attempt fixes the issue, so the best-of-3 attempts each write one:
the prompt gets one extra sentence (identical for all three attempts, and ONLY in this arm, so best-of-3 and `guarded` prompts differ):
`First write a small reproduction test for the issue in a NEW test file next to the existing tests; it must fail on the original code and pass
after your fix.` An attempt's reproduction = the NEW `.py` test files it added.

1. Each attempt gets the normal guard (static anti-cheat + the Docker Python stage; its repro file is one of "the agent's own tests" there).
2. Matrix (`reproMatrix`, one container, no network): every attempt's repro run against the ORIGINAL code and against each attempt's source-only
   patch (test files stripped), reinstalling for each variant. A repro is VALID iff it fails on the original code and passes on its own patch.
3. Selection (`selectByRepro`): pool = guard-accepted attempts with a valid repro (if none: all guard-accepted attempts, flagged `fallback`).
   Rank by (a) number of VALID repros (own + others') the patch passes, (b) agreement = sum of Jaccard similarity of normalised changed source
   lines with the other attempts (majority cluster), (c) completion order. Each attempt's `why` (chosen / ranked n / rejected / invalid repro) is
   recorded with the matrix. Hidden FAIL_TO_PASS / PASS_TO_PASS are never used for selection; they only grade.

Limits: the repros are written by the same model family that writes the fixes, so a shared misreading of the issue yields repros that agree
with each other and still miss the hidden test; the matrix measures consensus, not correctness. A repro that only fails on the original code
because of an import of a new name (tests the API the attempt invented) is "valid" by this rule.

## Run

```sh
node evals/swebench/run.mjs --arm bare-haiku,guarded --instance psf__requests-1142,psf__requests-1766 --k 1 --label pilot
node evals/swebench/run.mjs --arm bare-haiku,bare-sonnet,guarded,guarded-cascade,guarded-best-of-3 --k 1 --prune --label full   # all 12 instances
node evals/swebench/run.mjs --summarize evals/results/swebench/<file>.json   # re-print the per-arm summary
```

Plan usage limits: a session refused with "You've hit your session limit" marks the trial; the runner discards it, probes every 10 min
with a tiny haiku call until the quota is back, and re-runs the trial. `--resume <results.json>` keeps an earlier run's finished trials and runs the rest.

Flags: `--arm a,b` `--instance id,id` `--k N` `--timeout-s S` (per trial session budget, default 2400; the cascade shares it across its steps) `--prune` `--label` `--keep` (keep temp repos).
Output: `evals/results/swebench/swebench-<label>-<time>.{json,md}` (git-ignored). Per trial: `resolved` (what the arm ships, graded by the
hidden tests), `raw_resolved` (the session's patch graded even when the guard rejected it: measures false rejections), guard result, tokens
(input+output+cache creation), notional USD (`total_cost_usd` from the CLI), wall time (includes guard and grading). Guard runs and grading are
serialised; best-of-3 sessions run in parallel.

## Pilot (2026-10-21, k=1, real models and real grading)

| instance | arm | resolved | guard | new tokens | notional $ | session s | wall s (incl. guard+grading) |
|---|---|---|---|---|---|---|---|
| psf__requests-1142 | bare-haiku | yes (F2P 1/1, P2P 5/5) | - | 36,992 | 0.0132 | 42 | 64 |
| psf__requests-1142 | guarded | yes | accepted (5/5 original tests, 4 s) | 40,716 | 0.0148 | 43 | 69 |
| psf__requests-1766 | bare-haiku | yes (F2P 6/6, P2P 79/79) | - | 33,698 | 0.0109 | 31 | 76 |
| psf__requests-1766 | guarded | yes | accepted (45/45 original tests, 9 s) | 32,696 | 0.0123 | 44 | 96 |
| psf__requests-1766 | best-of-3 (first and repro) | yes, 3/3 attempts resolve | 3/3 accepted, 3/3 valid repros, every repro passes every patch | 123,676 | 0.0478 | 59-110 (parallel) | 270 |

Both pilot instances are easy for haiku, so the pilot proves the plumbing, not the hypothesis. New tokens = input + output + cache creation;
cache reads (~300-480k per session) are not included.

Full-run estimate (12 instances, all arms; from the pilot, scaled up 1-2.5x for the pytest instances, sonnet ~3x haiku price):
~7.5 sessions per instance per trial (bare-haiku 1, bare-sonnet 1, guarded 1, cascade 1-3, best-of-3 3) -> k=1: ~3-7M new tokens,
~$2-5 notional, ~2-4.5 h wall (sequential trials; Docker grading ~25-45 s per patch, ~7 patches per instance); k=3: ~3x that
(~$6-16, ~6-14 h). Disk: ~9 GB of images for the 12 instances.

Cleanup when done: `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock docker image rm $(docker images -q 'swebench/*')`.
