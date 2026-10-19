#!/usr/bin/env bash
# E2 (no model call): integrate the worker's edits. Commit on the task branch inside the worktree, confirm main
# is untouched, merge into an integration branch, then remove the worktree and branch.
set -euo pipefail
T="${TMPDIR%/}"; REPO="$T/orch-spike-repo"; WT="$REPO.worktrees/t1"
G="git -c user.name=aos-engine -c user.email=aos@example.invalid"
echo "--- worktree status before commit:"; git -C "$WT" status --short
rm -f "$WT/a.txt" "$WT/inside.txt" "$WT/slow.sh"            # spike leftovers; a real engine commits only in-scope paths
(cd "$WT" && sh test.sh && echo "acceptance check: PASS")
$G -C "$WT" add -A && $G -C "$WT" commit -qm "t1: hello world" && git -C "$WT" log --oneline -1
echo "--- main checkout still says:"; cat "$REPO/hello.txt"
$G -C "$REPO" branch aos/spike/integration main
$G -C "$REPO" worktree add -q "$REPO.worktrees/integration" aos/spike/integration
$G -C "$REPO.worktrees/integration" merge -q --no-ff -m "integrate t1" aos/spike/t1
(cd "$REPO.worktrees/integration" && sh test.sh && echo "integration check: PASS")
echo "--- main untouched (never auto-merged):"; git -C "$REPO" log --oneline main
git -C "$REPO" worktree remove "$WT"
git -C "$REPO" worktree remove "$REPO.worktrees/integration"
git -C "$REPO" branch -D aos/spike/t1 >/dev/null
git -C "$REPO" worktree list; git -C "$REPO" branch --list
echo "--- worktree remove refuses a dirty tree (needs --force):"
git -C "$REPO" worktree add -q -b aos/spike/dirty "$REPO.worktrees/dirty" main
echo x > "$REPO.worktrees/dirty/untracked.txt"
git -C "$REPO" worktree remove "$REPO.worktrees/dirty" 2>&1 || echo "(refused, as expected)"
git -C "$REPO" worktree remove --force "$REPO.worktrees/dirty"; git -C "$REPO" branch -D aos/spike/dirty >/dev/null
