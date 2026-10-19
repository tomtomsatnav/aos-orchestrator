// git helpers: execFile only (no shell), never touches the base branch, never pushes, never deletes branches it did
// not create. Worktree layout: <repo>-aos-worktrees/<goal>/<task>, branches aos/<goal>/<task>.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const IDENT = ['-c', 'user.name=aos-engine', '-c', 'user.email=aos-engine@localhost', '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null', '-c', 'merge.ff=false'];

export function gitEnv(base = process.env) {
  const env = { PATH: base.PATH || '/usr/bin:/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', LANG: base.LANG || 'C' };
  if (base.HOME) env.HOME = base.HOME;
  return env;
}

export function git(cwd, args, { allowFail = false, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', [...IDENT, ...args], { cwd, env: gitEnv(), timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const r = { code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) };
      if (err && !allowFail) { const e = new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || err.message}`); e.result = r; reject(e); } else resolve(r);
    });
  });
}

export const realpath = (p) => fs.realpathSync(p);

export async function repoInfo(repo, baseBranch) {
  const root = realpath((await git(repo, ['rev-parse', '--show-toplevel'])).stdout.trim());
  const sha = (await git(root, ['rev-parse', '--verify', `${baseBranch}^{commit}`])).stdout.trim();
  return { root, base_commit: sha };
}

export const branchNames = (goalId, taskId) => ({ task: `aos/${goalId}/${taskId}`, integration: `aos/${goalId}/integration` });
export const worktreeRootFor = (repoRoot, goalId) => path.join(`${repoRoot}-aos-worktrees`, goalId);

/** True when p lies strictly inside <repo>-aos-worktrees/ (lexically, after normalisation). Guards every recursive delete. */
export function isUnderWorktreeRoot(repo, p) {
  const root = `${path.resolve(`${repo}-aos-worktrees`)}${path.sep}`;
  const abs = path.resolve(p);
  return abs.startsWith(root) && abs.length > root.length;
}

/**
 * Before the engine runs git in a task worktree, make sure the worktree still belongs to this repo and branch.
 * The worker can rewrite <wt>/.git (a one-line "gitdir:" file); a forged one would make the engine's
 * `git add -A && git commit` land on another branch (e.g. the base branch via the main .git), or run a forged
 * config's core.fsmonitor / filter drivers. Pure fs reads: no git process touches the untrusted worktree first.
 */
export async function assertWorktreeIntegrity(repo, wt, branch) {
  const commonOut = (await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
  const common = fs.realpathSync(commonOut);
  const dotgit = path.join(wt, '.git');
  const st = fs.lstatSync(dotgit);
  if (!st.isFile()) throw new Error(`worktree ${wt}: .git is not a gitdir file`);
  const m = /^gitdir: (.+)\n?$/.exec(fs.readFileSync(dotgit, 'utf8'));
  if (!m) throw new Error(`worktree ${wt}: malformed .git file`);
  const gitdir = fs.realpathSync(path.resolve(wt, m[1]));
  if (path.dirname(gitdir) !== path.join(common, 'worktrees')) throw new Error(`worktree ${wt}: .git points outside ${common}/worktrees`);
  const back = fs.readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim(); // written by git, lives outside the worktree
  if (fs.realpathSync(path.dirname(back)) !== fs.realpathSync(wt)) throw new Error(`worktree ${wt}: gitdir ${gitdir} belongs to another worktree`);
  const headRef = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
  if (headRef !== `ref: refs/heads/${branch}`) throw new Error(`worktree ${wt}: HEAD is "${headRef}", expected ${branch}`);
  return true;
}

function assertOwnBranch(goalId, branch) {
  if (!branch.startsWith(`aos/${goalId}/`)) throw new Error(`refusing to touch branch ${branch}: not an aos/${goalId}/ branch`);
}

export async function branchExists(repo, branch) {
  return (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code === 0;
}

/** Create worktree at wtPath on a NEW branch from startPoint. Idempotent when the worktree already exists. */
export async function worktreeAdd(repo, goalId, wtPath, branch, startPoint) {
  assertOwnBranch(goalId, branch);
  if (fs.existsSync(path.join(wtPath, '.git'))) return { created: false };
  fs.mkdirSync(path.dirname(wtPath), { recursive: true, mode: 0o700 });
  const exists = await branchExists(repo, branch);
  await git(repo, exists ? ['worktree', 'add', wtPath, branch] : ['worktree', 'add', '-b', branch, wtPath, startPoint]);
  return { created: true, branch_created: !exists };
}

/** Remove one of OUR worktrees (force: dirty trees are ours to discard). */
export async function worktreeRemove(repo, wtPath) {
  if (!fs.existsSync(wtPath)) { await git(repo, ['worktree', 'prune'], { allowFail: true }); return false; }
  if (!isUnderWorktreeRoot(repo, wtPath)) throw new Error(`refusing to remove ${wtPath}: not under ${repo}-aos-worktrees/`);
  const r = await git(repo, ['worktree', 'remove', '--force', wtPath], { allowFail: true });
  if (r.code !== 0) { fs.rmSync(wtPath, { recursive: true, force: true }); await git(repo, ['worktree', 'prune'], { allowFail: true }); }
  return true;
}

export async function deleteOwnBranch(repo, goalId, branch) {
  assertOwnBranch(goalId, branch);
  return (await git(repo, ['branch', '-D', branch], { allowFail: true })).code === 0;
}

export async function head(wt) { return (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim(); }

/** Changed paths in the working tree vs HEAD (including untracked), relative to the worktree root. */
export async function changedPaths(wt) {
  const r = await git(wt, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const out = [];
  const parts = r.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]; const code = entry.slice(0, 2); const p = entry.slice(3);
    out.push(p);
    if (code[0] === 'R' || code[0] === 'C') i++; // rename: next field is the origin path
  }
  return out;
}

/** git add -A + commit as aos-engine. Returns the new sha, or null when there was nothing to commit. */
export async function commitAll(wt, message) {
  await git(wt, ['add', '-A']);
  const st = await git(wt, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (st.code === 0) return null;
  await git(wt, ['commit', '-q', '-m', message]);
  return head(wt);
}

export async function discardChanges(wt) {
  await git(wt, ['reset', '--hard', 'HEAD']);
  await git(wt, ['clean', '-fdq']);
}

/** Merge a task branch into the integration worktree with --no-ff. Aborts and reports on conflict. */
export async function mergeNoFf(integrationWt, branch, message) {
  const r = await git(integrationWt, ['merge', '--no-ff', '-m', message, branch], { allowFail: true });
  if (r.code === 0) return { ok: true, sha: await head(integrationWt) };
  const files = (await git(integrationWt, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).stdout.split('\n').filter(Boolean);
  await git(integrationWt, ['merge', '--abort'], { allowFail: true });
  return { ok: false, conflict: files.length > 0, files, error: r.stderr.trim() || r.stdout.trim() };
}

export async function diffStat(repo, from, to) {
  return (await git(repo, ['diff', '--stat', `${from}..${to}`], { allowFail: true })).stdout.trim();
}
export async function currentBranch(repo) {
  return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })).stdout.trim();
}
export async function listWorktrees(repo) {
  const r = await git(repo, ['worktree', 'list', '--porcelain']);
  return r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
}

/** Raw bytes of <ref>:<rel> (null when absent). Used to hash the committed CLAUDE.md a worktree will contain. */
export function showBlob(repo, ref, rel) {
  return new Promise((resolve) => {
    execFile('git', [...IDENT, 'show', `${ref}:${rel}`], { cwd: repo, env: gitEnv(), encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}
