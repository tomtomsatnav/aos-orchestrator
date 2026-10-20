// R0 characterization (docs/rules-design.md section 6): golden tests that pin TODAY's decisions of the policy, the
// plan hash, the budgets and the governor defaults. They must stay unchanged by the rule-set refactor (R1-R4). The only
// intended diffs are tightenings (see the R2 note in docs/rules-design.md, Implementation notes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, DEFAULT_POLICY, isProtectedRel, allowlistEntryProblem } from '../lib/policy.mjs';
import { DEFAULT_BUDGETS } from '../lib/state.mjs';
import { DEFAULTS as GOV_DEFAULTS, checkBudgets } from '../lib/governor.mjs';
import { planHash, tasksHash, checkAutoApprovable, AUTO_APPROVABLE_CHECKS } from '../lib/plan.mjs';

const ctx = { worktree: '/w/t1', path_scope: ['a.txt', 'src/**'], allowed_tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'], allowed_commands: ['sort', 'uniq -c'], grants: [], home: '/home/u', base_branch: 'main' };

// [tool, input, decision, rule]
const GOLDEN = [
  ["Write",{"file_path":"/w/t1/a.txt"},"allow","write_in_scope"],
  ["Edit",{"file_path":"/w/t1/src/deep/x.js"},"allow","write_in_scope"],
  ["Write",{"file_path":"/w/escape.txt"},"deny","outside_worktree"],
  ["Write",{"file_path":"../x.txt"},"deny","outside_worktree"],
  ["Write",{"file_path":"/w/t1/other.txt"},"ask","outside_scope"],
  ["Write",{"file_path":"/w/t1/.git/hooks/pre-commit"},"deny","path_denied"],
  ["Write",{"file_path":"/w/t1/.GIT/config"},"deny","path_denied"],
  ["Write",{"file_path":"/w/t1/.git"},"deny","path_denied"],
  ["Write",{"file_path":"/w/t1/.claude/settings.json"},"deny","path_denied"],
  ["Write",{"file_path":"/w/t1/sub/.claude/settings.local.json"},"deny","path_denied"],
  ["Write",{"file_path":"/w/t1/.aos/rules.json"},"deny","path_denied"],
  ["Write",{"file_path":"/home/u/.claude/settings.json"},"deny","path_denied"],
  ["Write",{"file_path":"/home/u/.zshrc"},"deny","path_denied"],
  ["Write",{"file_path":"/home/u/.config/x"},"deny","path_denied"],
  ["Read",{"file_path":"/w/t1/README.md"},"allow","read_in_worktree"],
  ["Read",{"file_path":"/etc/passwd"},"deny","outside_read_root"],
  ["Read",{"file_path":"/home/u/.ssh/id_ed25519"},"deny","path_denied"],
  ["Read",{"file_path":"/w/t1/.git/config"},"deny","path_denied"],
  ["Glob",{"pattern":"**/*.js"},"allow","read_in_worktree"],
  ["Glob",{"pattern":"/home/u/.ssh/*"},"deny","outside_read_root"],
  ["Glob",{"pattern":"../../**/*.pem"},"deny","outside_read_root"],
  ["Grep",{"pattern":"x","path":"/Users"},"deny","outside_read_root"],
  ["Grep",{"pattern":"x"},"allow","read_in_worktree"],
  ["WebFetch",{"url":"http://x"},"deny","tool_not_allowed"],
  ["Mystery",{},"deny","tool_not_allowed"],
  ["Write",{},"deny","unparsed"],
  ["MultiEdit",{"file_path":"/w/t1/a.txt"},"deny","tool_not_allowed"],
  ["Bash",{"command":"ls -la"},"allow","bash_allow"],
  ["Bash",{"command":"sort a.txt"},"allow","bash_allow"],
  ["Bash",{"command":"uniq -d a.txt"},"ask","unknown_command"],
  ["Bash",{"command":"git status && git diff | head -5"},"allow","bash_allow"],
  ["Bash",{"command":"git log --oneline"},"allow","bash_allow"],
  ["Bash",{"command":"find . -name x"},"ask","unknown_command"],
  ["Bash",{"command":"find . -name x -exec rm {} ;"},"deny","dangerous"],
  ["Bash",{"command":"make test"},"deny","dangerous"],
  ["Bash",{"command":"node --test"},"deny","dangerous"],
  ["Bash",{"command":"npm test"},"deny","dangerous"],
  ["Bash",{"command":"python3 x.py"},"deny","dangerous"],
  ["Bash",{"command":"bash -c ls"},"deny","dangerous"],
  ["Bash",{"command":"awk 1 a.txt"},"deny","dangerous"],
  ["Bash",{"command":"git push origin main"},"deny","dangerous"],
  ["Bash",{"command":"git -C /w/t1 push"},"deny","dangerous"],
  ["Bash",{"command":"git remote add x y"},"deny","dangerous"],
  ["Bash",{"command":"git reset --hard HEAD~1"},"deny","dangerous"],
  ["Bash",{"command":"git checkout main"},"deny","dangerous"],
  ["Bash",{"command":"git checkout -b x"},"deny","dangerous"],
  ["Bash",{"command":"git branch -D x"},"deny","dangerous"],
  ["Bash",{"command":"git config user.name x"},"deny","dangerous"],
  ["Bash",{"command":"git commit -m x"},"deny","dangerous"],
  ["Bash",{"command":"git fetch"},"deny","dangerous"],
  ["Bash",{"command":"sudo ls"},"deny","dangerous"],
  ["Bash",{"command":"curl https://example.com"},"deny","dangerous"],
  ["Bash",{"command":"/usr/bin/curl example.com"},"deny","dangerous"],
  ["Bash",{"command":"ls && wget x"},"deny","dangerous"],
  ["Bash",{"command":"ssh host"},"deny","dangerous"],
  ["Bash",{"command":"npm install left-pad"},"deny","dangerous"],
  ["Bash",{"command":"pip3 install x"},"deny","dangerous"],
  ["Bash",{"command":"chmod -R 777 ."},"deny","dangerous"],
  ["Bash",{"command":"cat a.txt | sh"},"deny","dangerous_pattern"],
  ["Bash",{"command":"ls | node"},"deny","dangerous_pattern"],
  ["Bash",{"command":"rm -rf /"},"deny","dangerous_pattern"],
  ["Bash",{"command":"rm -rf ~"},"deny","dangerous_pattern"],
  ["Bash",{"command":"rm -r /w/other"},"deny","dangerous_pattern"],
  ["Bash",{"command":"rm -r ../x"},"deny","dangerous_pattern"],
  ["Bash",{"command":"eval \"ls\""},"deny","dangerous"],
  ["Bash",{"command":"cat $(echo a.txt)"},"ask","substitution"],
  ["Bash",{"command":"cat `echo a.txt`"},"ask","substitution"],
  ["Bash",{"command":"cat $FILE"},"ask","unparsed"],
  ["Bash",{"command":"cat <<EOF\nx\nEOF"},"ask","unparsed"],
  ["Bash",{"command":"(ls)"},"ask","unparsed"],
  ["Bash",{"command":"FOO=1 ls"},"ask","unparsed"],
  ["Bash",{"command":"cd src && ls"},"ask","unparsed"],
  ["Bash",{"command":"env ls"},"deny","dangerous"],
  ["Bash",{"command":"xargs ls"},"deny","dangerous"],
  ["Bash",{"command":"timeout 5 ls"},"deny","dangerous"],
  ["Bash",{"command":"rg --pre x foo"},"deny","dangerous"],
  ["Bash",{"command":"ls > /tmp/out.txt"},"deny","outside_worktree"],
  ["Bash",{"command":"ls > a.txt"},"allow","bash_allow"],
  ["Bash",{"command":"ls 2>/dev/null"},"allow","bash_allow"],
  ["Bash",{"command":"ls > .git/config"},"deny","path_denied"],
  ["Bash",{"command":"echo alpha > a.txt"},"ask","unknown_command"],
  ["Bash",{"command":"sed -i s/a/b/ a.txt"},"ask","unknown_command"],
  ["Bash",{"command":"cat /etc/passwd"},"deny","outside_read_root"],
  ["Bash",{"command":"cat ../secret"},"deny","outside_read_root"],
  ["Bash",{"command":"cat ~/.ssh/id_rsa"},"deny","path_denied"],
  ["Bash",{"command":"grep -r x --include=/etc/passwd"},"deny","outside_read_root"],
  ["Bash",{"command":"grep --file=/etc/passwd a"},"deny","outside_read_root"],
  ["Bash",{"command":"mkdir src/new"},"ask","unknown_command"],
  ["Bash",{"command":"touch other.txt"},"ask","outside_scope"],
  ["Bash",{"command":"cp a.txt /tmp/a"},"deny","outside_worktree"],
  ["Bash",{"command":"   "},"deny","unparsed"],
  ["Bash", { command: "x".repeat(16385) }, "deny", "unparsed"],
  ["Bash",{"command":"cat a.txt"},"allow","bash_allow"],
  ["Bash",{"command":"grep \"a;b\" a.txt"},"allow","bash_allow"],
  ["Bash",{"command":"grep '$x' a.txt"},"allow","bash_allow"],
  ["Bash",{"command":"cd"},"deny","outside_read_root"],
  ["Bash",{"command":"true"},"ask","unknown_command"],
];

for (const [tool, input, decision, rule] of GOLDEN) {
  const name = tool === 'Bash' ? input.command.slice(0, 60) : `${tool} ${JSON.stringify(input)}`;
  test(`golden policy: ${name.replace(/\n/g, ' ')} -> ${decision}/${rule}`, () => {
    const r = evaluate(DEFAULT_POLICY, { tool_name: tool, tool_input: input, cwd: '/w/t1' }, ctx);
    assert.deepEqual({ decision: r.decision, rule: r.rule }, { decision, rule });
  });
}

test('golden: DEFAULT_POLICY, DEFAULT_BUDGETS and governor defaults are pinned', () => {
  assert.deepEqual(DEFAULT_POLICY, {
    version: 1, default: 'deny',
    tools: { allow: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] },
    paths: { write: 'worktree+scope', read_extra: [], on_outside_scope: 'ask',
      deny: ['~/.claude/**', '~/.ssh/**', '~/.config/**', '**/.git/**', '**/.git', '**/.claude/settings*.json'] },
    bash: {
      allow: ['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find -name', 'diff', 'git status', 'git diff', 'git log', 'git show'],
      deny: ['git push', 'git remote', 'git config', 'git reset --hard', 'sudo', 'curl', 'wget', 'nc', 'ssh', 'scp', 'rsync', 'npm install', 'pip install', 'brew', 'eval', 'exec'],
      deny_patterns: ['\\|\\s*(sh|bash|zsh|python3?|node|perl)\\b', 'rm\\s+-(?=[a-z]*r)[a-z]*\\s+(/|~|\\.\\.)'],
      ask_on: ['substitution', 'unparsed', 'unknown_command'],
    },
    approval: { wait_in_hook_s: 20, ttl_s: 86400, on_timeout: 'deny' },
  });
  assert.deepEqual(DEFAULT_BUDGETS, { max_new_tokens: 2000000, max_parallel: 3, max_attempts: 3, max_tasks: 12, task_wall_clock_s: 900, approval_ttl_s: 86400, stall_after_s: 300, max_turns: 30, attempt_usd_cap: 2 });
  assert.equal(GOV_DEFAULTS.reserve_5h, 0.8); assert.equal(GOV_DEFAULTS.hold_7d, 0.9); assert.equal(GOV_DEFAULTS.jitter_s, 60);
  assert.deepEqual(GOV_DEFAULTS.backoff_min, [15, 30, 60, 240]); assert.deepEqual(GOV_DEFAULTS.overload_backoff_s, [30, 60, 120, 300]);
  assert.deepEqual(AUTO_APPROVABLE_CHECKS, ['grep', 'test', 'diff', 'cmp']);
});

test('golden: budget thresholds (80% soft, 100% hard; ticks, USD)', () => {
  const goal = (used, usd = 0) => ({ orch: { budgets: { max_new_tokens: 1000 }, usage: { new_tokens: used, notional_usd: usd }, started_ms: 1000 }, budget: { max_wall_clock_s: 100, max_ticks: 10, max_usd: 5 } });
  assert.deepEqual(checkBudgets(goal(799), { nowMs: 1000, seq: 1 }), { soft: [], hard: [] });
  assert.equal(checkBudgets(goal(800), { nowMs: 1000, seq: 1 }).soft.length, 1);
  assert.equal(checkBudgets(goal(1000), { nowMs: 1000, seq: 1 }).hard.length, 1);
  assert.equal(checkBudgets(goal(0), { nowMs: 81000, seq: 1 }).soft.length, 1);
  assert.equal(checkBudgets(goal(0), { nowMs: 101000, seq: 1 }).hard.length, 1);
  assert.equal(checkBudgets(goal(0), { nowMs: 1000, seq: 11 }).hard.length, 1);
  assert.equal(checkBudgets(goal(0, 5), { nowMs: 1000, seq: 1 }).hard.length, 1);
});

test('golden: plan and tasks hashes are stable', () => {
  const plan = { tasks: [{ id: 't1', title: 'x', path_scope: ['a.txt'], depends_on: [], checks: [{ argv: ['grep', 'x', 'a.txt'], timeout_s: 10 }] }], risks: [] };
  assert.equal(planHash(plan), '7322630902439b6ab247b730f9f6f157a75e582e76c4f0a64557b6e3374b9640');
  const tasks = [{ id: 't1', depends_on: [], orch: { path_scope: ['a.txt'], allowed_commands: ['sort'], allowed_tools: ['Read'], checks: [{ argv: ['grep', 'x', 'a.txt'], timeout_s: 10 }], model_tier: 'haiku' } }];
  assert.equal(tasksHash(tasks), '29578176a19ceb386a7961c3bf5ede2c34feb4a8b9233c4fb1dbdeed05b8966e');
  assert.equal(tasksHash([{ ...tasks[0], orch: { ...tasks[0].orch, model_tier: 'opus' } }]), '29578176a19ceb386a7961c3bf5ede2c34feb4a8b9233c4fb1dbdeed05b8966e', 'tier is excluded');
  assert.equal(checkAutoApprovable(['grep', 'x']), true); assert.equal(checkAutoApprovable(['node', '--test']), false); assert.equal(checkAutoApprovable(['/tmp/grep']), false);
});

test('golden: isProtectedRel (snapshot check) and allowlistEntryProblem', () => {
  const prot = { '.git': true, '.git/config': true, 'src/.git/x': true, '.GIT/x': true, '.claude/settings.json': true, 'a/.claude/settings.local.json': true,
    '.claude/commands/x.md': false, '.aos/rules.json': true, 'src/a.js': false, 'README.md': false, '.gitignore': false };
  for (const [rel, want] of Object.entries(prot)) assert.equal(isProtectedRel(DEFAULT_POLICY, rel), want, rel);
  const ent = JSON.parse(String.raw`[["ls",null],["cat",null],["git status",null],["git push","git push is not a read-only git command (allowed: status, diff, log, show, ls-files, ls-tree, rev-parse, rev-list, cat-file, blame, shortlog, describe)"],["node --test","node executes code and is never allowed for a worker (verification belongs in the plan's checks)"],["npm test","npm executes code and is never allowed for a worker (verification belongs in the plan's checks)"],["sort -u",null],["git log",null],["find -name",null],["./x.sh","runs a file by path (code the worker can write)"],["sudo ls","sudo is never allowed"],["ls; ls","must be exactly one simple command"],["ls > x","must be a plain command without redirects"],["FOO=1 ls","starts with a variable assignment"],["","empty entry"],["awk 1","awk executes code and is never allowed for a worker (verification belongs in the plan's checks)"],["git commit","git commit can run hooks, filters or aliases and is not allowed"],["make","make executes code and is never allowed for a worker (verification belongs in the plan's checks)"]]`);
  for (const [e, why] of ent) assert.equal(allowlistEntryProblem(e), why, e);
});
