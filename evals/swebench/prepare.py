#!/usr/bin/env python3
"""Pick the SWE-bench Verified subset by a fixed rule and write evals/swebench/subset.json.

Run with the dedicated venv:  ~/aos-split/.swebench-venv/bin/python -I evals/swebench/prepare.py

Rule (revision 2, 2026-10-21; decided without looking at any model's results on the candidates. Before it, only psf__requests-1142 and
psf__requests-1766 had been run, in the pilot, under revision 1):
  0. Feasibility: the instance's published x86_64 eval image is < 1.5 GB compressed (Docker Hub tag full_size; this excludes xarray and
     scikit-learn), and its eval test command is pytest-based (`pytest ...` or `tox ... -- ...`), because the guard's Python stage runs and parses
     pytest -rA output (this excludes django's runtests.py and sympy's bin/test).
  1. EASY half (6): Verified difficulty "<15 min fix" or "15 min - 1 hour", repos psf/requests and pytest-dev/pytest, 3 per repo, each repo in
     ascending issue number.
  2. HARD half (6): Verified difficulty "1-4 hours" from psf/requests and pytest-dev/pytest in ascending issue number. Those two repos have only
     3 such instances (requests has none), so the rest comes from ONE third repo: among all other Verified repos, the one with the most feasible
     "1-4 hours" instances (rule 0; ties by name), in ascending issue number. (Result: sphinx-doc/sphinx with 4, ahead of astropy 3, pylint 2.)
The file keeps only what an agent and the guard may see (problem statement, base commit, image, install command and the test-runner prefix);
the hidden tests (test_patch, FAIL_TO_PASS, PASS_TO_PASS) are not written. Grading loads them through the swebench harness itself.
"""
import json
import re
import sys
import urllib.request
from collections import Counter
from pathlib import Path

from datasets import load_dataset

MAIN = ["psf/requests", "pytest-dev/pytest"]
EASY = {"<15 min fix", "15 min - 1 hour"}
HARD = "1-4 hours"
PER_HALF = 6
IMAGE_MAX_MB = 1500
OUT = Path(__file__).resolve().parent / "subset.json"


def image_mb(image):
    """Compressed size (MB) of a published image's tag, from the Docker Hub API (not the registry: no pull rate limit)."""
    name, tag = image.rsplit(":", 1)
    with urllib.request.urlopen(f"https://hub.docker.com/v2/repositories/{name}/tags/{tag}", timeout=60) as r:
        return json.load(r)["full_size"] // 1_000_000


def guard_env(eval_script):
    """Install command(s) and the test-runner prefix of the instance's eval script, without the hidden test file names."""
    lines = eval_script.split("\n")
    install = [l for l in lines if re.search(r"\bpip install\b", l)]
    test = next(l for l in lines if l.startswith(("pytest", "python -m pytest", "tox")))
    prefix = []
    for tok in test.split():
        if "/" in tok or tok.endswith(".py") or "::" in tok:
            break
        prefix.append(tok)
    return {"install": install, "test_prefix": prefix}


num = lambda r: int(r["instance_id"].rsplit("-", 1)[1])
pytest_based = lambda r: any(l.startswith(("pytest", "python -m pytest", "tox ")) for l in r["eval_script"].split("\n"))


def main():
    ds = load_dataset("SWE-bench/SWE-bench_Verified", split="test")  # the dataset the harness grades against (has image + eval_script)
    rows = sorted([r for r in ds if (r["repo"] in MAIN and r["difficulty"] in EASY) or r["difficulty"] == HARD], key=lambda r: (r["repo"], num(r)))
    feasible = []
    for r in rows:
        if not pytest_based(r):
            continue
        r["_mb"] = image_mb(r["image"])
        if r["_mb"] < IMAGE_MAX_MB:
            feasible.append(r)
    easy = [r for repo in MAIN for r in [x for x in feasible if x["repo"] == repo and x["difficulty"] in EASY][:PER_HALF // len(MAIN)]]
    hard = [r for r in feasible if r["repo"] in MAIN and r["difficulty"] == HARD][:PER_HALF]
    third = None
    if len(hard) < PER_HALF:
        counts = Counter(r["repo"] for r in feasible if r["repo"] not in MAIN and r["difficulty"] == HARD)
        third = max(sorted(counts), key=lambda k: counts[k])  # most feasible hard instances; ties by name
        hard += [r for r in feasible if r["repo"] == third and r["difficulty"] == HARD][:PER_HALF - len(hard)]
        print(f"third repo: {third} (feasible 1-4h counts outside the main two: {dict(counts)})", file=sys.stderr)
    chosen = easy + hard
    out = [{"instance_id": r["instance_id"], "repo": r["repo"], "version": r["version"], "difficulty": r["difficulty"], "half": "easy" if r in easy else "hard",
            "base_commit": r["base_commit"], "image": r["image"], "image_mb": r["_mb"], "guard_env": guard_env(r["eval_script"]), "problem_statement": r["problem_statement"]} for r in chosen]
    rule = __doc__.split("Rule")[1].split("The file keeps")[0].strip()
    OUT.write_text(json.dumps({"rule_revision": 2, "date": "2026-10-21", "rule": rule, "third_repo": third, "ids": [r["instance_id"] for r in out],
                               "instances": out}, indent=2) + "\n")
    for r in out:
        print(r["half"], r["instance_id"], r["version"], r["difficulty"], r["image_mb"], r["guard_env"], file=sys.stderr)
    print(f"wrote {len(out)} instances to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
