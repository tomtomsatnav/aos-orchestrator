// Policy as code (design section 6). evaluate() is a PURE function: no fs, no clock, no env. Anything that needs the
// file system (symlink resolution) is injected as ctx.realpath. Result: {decision:'allow'|'deny'|'ask', reason, rule}.
// Order: deny rules -> per-task grants -> allow rules -> ask -> default deny (fail closed).
import path from 'node:path';
import vm from 'node:vm';
import { parseShell, tokenize, WRITE_REDIRECTS } from './shell.mjs';
import { matchAny, matchGlob, globToRegex } from './glob.mjs';

export const DEFAULT_POLICY = {
  version: 1, default: 'deny',
  tools: { allow: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] },
  paths: { write: 'worktree+scope', read_extra: [], on_outside_scope: 'ask',
    deny: ['~/.claude/**', '~/.ssh/**', '~/.config/**', '**/.git/**', '**/.git', '**/.claude/settings*.json'] },
  bash: {
    // READ-ONLY inspection only. Nothing here may execute code the worker can write (node, npm, make, python, shells, ...):
    // running tests is the engine's job (sandboxed acceptance checks), never the worker's.
    allow: ['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find -name', 'diff', 'git status', 'git diff', 'git log', 'git show'],
    deny: ['git push', 'git remote', 'git config', 'git reset --hard', 'sudo', 'curl', 'wget', 'nc', 'ssh', 'scp', 'rsync',
      'npm install', 'pip install', 'brew', 'eval', 'exec'],
    deny_patterns: ['\\|\\s*(sh|bash|zsh|python3?|node|perl)\\b', 'rm\\s+-(?=[a-z]*r)[a-z]*\\s+(/|~|\\.\\.)'],
    ask_on: ['substitution', 'unparsed', 'unknown_command'],
  },
  approval: { wait_in_hook_s: 20, ttl_s: 86400, on_timeout: 'deny' },
};

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
// always denied regardless of policy file content (design: "Dangerous (always deny, no approval)")
const ALWAYS_DENY_CMDS = new Set(['sudo', 'su', 'doas', 'curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'rsync', 'ftp', 'sftp', 'telnet', 'eval', 'exec', 'source', '.', 'chown', 'brew']);
const PKG_MGRS = new Set(['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'brew', 'apt', 'apt-get', 'gem', 'cargo', 'go']);
const PKG_VERBS = new Set(['install', 'i', 'add', 'update', 'upgrade', 'ci', 'get']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'python', 'python3', 'node', 'perl', 'ruby']);
// Commands that execute code a worker can write (interpreters, shells, build/test runners, package-script runners) or run
// another command: never allowed for a worker, not even with an approval (condition 1 of the security review).
const EXEC_NAMES = new Set([
  'node', 'nodejs', 'deno', 'bun', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'corepack', 'tsx', 'ts-node', 'vitest', 'jest', 'mocha', 'ava', 'tap',
  'make', 'gmake', 'cmake', 'ninja', 'bazel', 'rake', 'bundle', 'bundler', 'gradle', 'mvn', 'ant', 'cargo', 'rustc', 'go', 'gcc', 'g++', 'cc', 'c++', 'clang', 'clang++',
  'swift', 'swiftc', 'java', 'javac', 'dotnet', 'pytest', 'tox', 'nox', 'poetry', 'pipenv', 'uv', 'irb', 'pry', 'lua', 'luajit', 'tclsh', 'wish', 'expect', 'osascript', 'jshell',
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'ash', 'busybox', 'eval', 'source', '.', 'exec',
  'env', 'xargs', 'nohup', 'timeout', 'gtimeout', 'nice', 'time', 'command', 'builtin', 'caffeinate', 'script', 'watch', 'parallel', 'stdbuf', 'unbuffer', 'sudo', 'doas', 'su', 'chroot', 'setsid', 'arch',
  'awk', 'gawk', 'mawk', 'nawk', 'vi', 'vim', 'nvim', 'ex', 'ed', 'emacs', 'nano', 'less', 'more', 'man', 'sqlite3', 'sandbox-exec', 'launchctl', 'open', 'at', 'crontab', 'docker', 'podman', 'gh',
]);
const EXEC_PATTERNS = [/^python[\d.]*$/, /^pypy[\d.]*$/, /^ruby[\d.]*$/, /^perl[\d.]*$/, /^php[\d.]*$/, /^node[\d.]+$/, /^pip[\d.]*$/];
// git subcommands that run hooks, aliases or filter/textconv drivers (or are not read-only at all)
const GIT_EXEC_SUB = new Set(['add', 'commit', 'checkout', 'switch', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'apply', 'stash', 'restore', 'archive', 'difftool', 'mergetool',
  'bisect', 'maintenance', 'daemon', 'instaweb', 'send-email', 'hook', 'lfs', 'annex', 'clean', 'rm', 'mv', 'tag', 'bundle', 'fast-import', 'init']);
export const GIT_READONLY_SUB = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'cat-file', 'blame', 'shortlog', 'describe']);
// The FLOOR (docs/rules-design.md 2.2, R2): protected paths that no policy file, goal override or rule layer can remove.
// DEFAULT_POLICY.paths.deny lists the same entries for display; mergePolicy can empty that list but never this one.
export const FLOOR_DENY_GLOBS = ['~/.claude/**', '~/.ssh/**', '~/.config/**', '**/.git/**', '**/.git', '**/.claude/settings*.json', '**/.aos/**', '**/.aos'];
const BUILTIN_DENY_GLOBS = ['~/.zshrc', '~/.bashrc', '~/.bash_profile', '~/.profile', '~/.zprofile', '~/.zshenv', ...FLOOR_DENY_GLOBS];
const GIT_DENY_SUB = new Set(['push', 'remote', 'config', 'filter-branch', 'update-ref', 'worktree', 'clone', 'fetch', 'pull', 'submodule', 'gc', 'prune', 'reflog']);
const WRITE_CMDS = new Set(['mkdir', 'touch', 'mv', 'cp', 'rm', 'rmdir', 'tee', 'ln', 'truncate', 'chmod', 'install', 'dd']);
// commands that run another command given as arguments: the policy cannot see what they run
const WRAPPERS = new Set(['env', 'xargs', 'nohup', 'timeout', 'gtimeout', 'nice', 'time', 'command', 'builtin', 'exec', 'caffeinate', 'script', 'watch', 'parallel', 'sudo', 'doas', 'stdbuf', 'unbuffer']);
// flags that make an otherwise allowlisted command run code or write files (always ask, even when allowlisted)
const EXEC_FLAGS = {
  node: /^(-e|--eval|-p|--print|-r|--require|--import|--loader|--experimental-loader|-i|--interactive|--test-reporter-destination)(=|$)/,
  rg: /^--pre(-glob)?(=|$)/,
  git: /^--(output|ext-diff|exec|upload-pack|receive-pack)(=|$)/,
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
};
const EXEC_ARG = {
  find: /^-(exec|execdir|ok|okdir)$/,
  rg: /^--pre(=|$)/,
  git: /^--(ext-diff|exec-path|upload-pack|receive-pack|open-files-in-pager|textconv)(=|$)|^-O/,
  grep: /^--(pre)(=|$)/,
};
const INLINE_CODE = /^-(c|e|E|-eval|-command|-exec)$/;
const MAX_COMMAND = 16384;
/** Deny patterns only ever see this many characters; a longer command asks (it is not scanned by user regexes, but every other check still runs). */
export const MAX_REGEX_INPUT = 4096;
const BUILTIN_PATTERNS = new Set(DEFAULT_POLICY.bash.deny_patterns);
const reCtx = vm.createContext({});
/** All non-built-in deny patterns of ONE evaluate() call share this much time; past it the call is denied (`floor:regex_budget`). */
export const REGEX_BUDGET_MS = 1000;
const makeBudget = (ctx) => ({ now: typeof ctx?.now === 'function' ? ctx.now : () => performance.now(), limit: Number(ctx?.regex_budget_ms) || REGEX_BUDGET_MS, spent: 0 });
/** true / false, 'error' (does not compile, or ran longer than 100 ms: fail closed) or 'budget' (the call's total regex time is used up). Non-built-in patterns run under a vm timeout (ReDoS backstop). */
function regexTest(src, s, B) {
  let re; try { re = new RegExp(src); } catch { return 'error'; }
  if (BUILTIN_PATTERNS.has(src)) return re.test(s);
  if (B.spent >= B.limit) return 'budget';
  const t0 = B.now();
  try { reCtx.re = re; reCtx.s = s; return vm.runInContext('re.test(s)', reCtx, { timeout: Math.max(1, Math.min(100, Math.ceil(B.limit - B.spent))) }); } catch { return 'error'; } finally { B.spent += B.now() - t0; }
}
/** Deny globs match case- and compatibility-insensitively: APFS (macOS default) treats .CLAUDE, .Git or .ſsh as the protected name. */
const fold = (s) => String(s).normalize('NFKC').toLowerCase();

export function mergePolicy(...layers) {
  const out = JSON.parse(JSON.stringify(DEFAULT_POLICY));
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    for (const k of Object.keys(l)) {
      if (k === '__proto__') continue; // never assign the prototype (JSON.parse makes it an own key)
      if (l[k] && typeof l[k] === 'object' && !Array.isArray(l[k]) && out[k] && typeof out[k] === 'object') out[k] = { ...out[k], ...l[k] };
      else out[k] = l[k];
    }
  }
  return out;
}

const res = (decision, reason, rule, layer, id) => ({ decision, reason, rule, ...(layer ? { layer } : {}), ...(id ? { id } : {}) });
// Rule ids (docs/rules-design.md section 5): `<layer>:<rule>`. The legacy `rule` strings are the ids. Rules not listed here are enforced by
// code (the floor); the listed ones are driven by the policy (default layer, later user/repo/goal).
const DEFAULT_LAYER_RULES = new Set(['scope_denied', 'tool_not_allowed', 'outside_scope', 'bash_allow', 'write_in_scope', 'read_in_worktree', 'dangerous_pattern', 'substitution', 'unknown_command', 'default']);
const POLICY_DENY_REASON = 'command is on the policy deny list';
const withId = (r) => { const { id, ...rest } = r; const layer = r.layer || (DEFAULT_LAYER_RULES.has(r.rule) ? 'default' : 'floor'); return { ...rest, layer, rule_id: `${layer}:${id || r.rule}` }; };
const lex = (p) => p;
const isInside = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const expandHome = (p, home) => (home && (p === '~' || p.startsWith('~/')) ? path.join(home, p.slice(1)) : p);

function makeResolver(ctx) {
  const rp = typeof ctx.realpath === 'function' ? ctx.realpath : lex;
  const cwd = ctx.cwd || ctx.worktree;
  return {
    wt: rp(path.resolve(ctx.worktree)),
    resolve(arg, base = cwd) { const abs = path.resolve(base, expandHome(String(arg), ctx.home)); return { abs, real: rp(abs) }; },
  };
}

/** A deny glob that is neither absolute nor `**`-led is relative to the worktree root (`node_modules/**`, `*.pem`), not to wherever the path happens to be. */
export const isRootRelative = (g) => !g.startsWith('/') && !g.startsWith('**');
const hits = (globs, ps, roots = []) => globs.map(fold).some((g) => {
  if (isRootRelative(g)) {
    const rg = g.replace(/^\.\//, '');
    return roots.some((root) => ps.some((p) => isInside(p, root) && matchGlob(rg, fold(path.relative(root, p)).split(path.sep).join('/'))));
  }
  return ps.map(fold).some((p) => globToRegex(g).test(p) || matchGlob(g, p));
});
/** Which layer protects one of these paths: 'floor' (code), 'default' (the policy's own deny list) or null. Floor wins when both match. */
function pathDeniedBy(policy, ctx, ...ps) {
  const exp = (l) => l.map((x) => expandHome(x, ctx.home));
  const wt = ctx.worktree ? path.resolve(ctx.worktree) : null;
  const roots = wt ? [...new Set([wt, typeof ctx.realpath === 'function' ? ctx.realpath(wt) : wt])] : [];
  if (hits(exp(BUILTIN_DENY_GLOBS), ps, roots)) return 'floor';
  return hits(exp(policy.paths?.deny || []), ps, roots) ? 'default' : null;
}

/** mode: 'read' | 'write'. Returns null when the path is acceptable, else a result. */
function checkPath(policy, ctx, R, arg, mode, base) {
  const { abs, real } = R.resolve(arg, base);
  const pd = pathDeniedBy(policy, ctx, abs, real);
  if (pd) return res('deny', `path is protected by policy: ${mode}`, 'path_denied', pd);
  if (mode === 'write') { const sd = policy.paths?.scope_deny; const wt = path.resolve(ctx.worktree); if (sd?.length && hits(sd.map((x) => expandHome(x, ctx.home)), [abs, real], [...new Set([wt, R.wt])])) return res('deny', 'path is on the rules plan.scope_deny list', 'scope_denied', 'default'); }
  const inside = isInside(real, R.wt);
  if (mode === 'read') {
    if (inside) return null;
    // read_extra entries are globs (docs/rules-design.md): a plain path is a directory root, `*` `**` `?` match the resolved real path
    const extra = (policy.paths?.read_extra || []).map((x) => path.resolve(R.wt, expandHome(x, ctx.home)));
    if (extra.some((r) => (/[*?[]/.test(r) ? globToRegex(r).test(real) || globToRegex(`${r}/**`).test(real) : isInside(real, r)))) return null;
    return res('deny', 'read outside the task worktree', 'outside_read_root');
  }
  if (!inside) return res('deny', 'write outside the task worktree', 'outside_worktree');
  const rel = path.relative(R.wt, real).split(path.sep).join('/');
  if (matchAny(ctx.path_scope || [], rel)) return null;
  const g = (ctx.grants || []).some((x) => x.kind === 'path' && (x.path === real || x.path === abs));
  if (g) return null;
  const onOut = policy.paths?.on_outside_scope || 'ask';
  return res(onOut === 'deny' ? 'deny' : 'ask', `${rel} is outside the task path_scope`, 'outside_scope');
}

const worst = (a, b) => {
  const rank = { allow: 0, ask: 1, deny: 2 };
  return rank[b.decision] > rank[a.decision] ? b : a;
};

const SYSTEM_BIN = /^\/(usr\/(local\/)?)?s?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$/;
function prefixMatch(entry, argv, { strictName = false } = {}) {
  const e = tokenize(entry);
  if (!e.length || argv.length < e.length) return false;
  if (strictName && argv[0].includes('/') && !SYSTEM_BIN.test(argv[0])) return false;
  for (let i = 0; i < e.length; i++) {
    const a = i === 0 ? path.basename(argv[0]) : argv[i];
    if (e[i] !== a) return false;
  }
  return true;
}

function gitInfo(argv, ctx) {
  let i = 1; const opts = [];
  while (i < argv.length && argv[i].startsWith('-')) {
    opts.push(argv[i]);
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(argv[i])) i++;
    i++;
  }
  return { sub: argv[i], rest: argv.slice(i + 1), opts };
}

/** Reason when argv would execute code (the worker's own or anyone's), else null. Pure. */
export function executesCode(argv) {
  if (!Array.isArray(argv) || !argv.length) return null;
  const name = path.basename(String(argv[0])).toLowerCase();
  if (EXEC_NAMES.has(name) || EXEC_PATTERNS.some((r) => r.test(name))) return `${name} executes code and is never allowed for a worker (verification belongs in the plan's checks)`;
  const rest = argv.slice(1);
  if (EXEC_ARG[name] && rest.some((a) => EXEC_ARG[name].test(a))) return `${name} with an option that executes code`;
  if (name === 'git') {
    const g = gitInfo(argv);
    if (GIT_EXEC_SUB.has(g.sub)) return `git ${g.sub} can run hooks, filters or aliases and is not allowed`;
    if (g.opts.some((o) => EXEC_ARG.git.test(o))) return 'git with an option that executes code';
  }
  return null;
}

/**
 * Why an allowed_commands / bash.allow ENTRY is unacceptable for a worker (it executes code, or is not a single simple
 * read-only command), else null. Used by the plan validator to REJECT the plan.
 */
export function allowlistEntryProblem(entry) {
  if (typeof entry !== 'string' || !entry.trim()) return 'empty entry';
  const p = parseShell(entry);
  if (p.commands.length !== 1) return 'must be exactly one simple command';
  if (Object.values(p.flags).some(Boolean)) return 'contains shell constructs (substitution, expansion, heredoc, subshell)';
  const c = p.commands[0];
  if (!c.argv.length || c.redirects.length) return 'must be a plain command without redirects';
  if (/^[A-Za-z_]\w*=/.test(c.argv[0])) return 'starts with a variable assignment';
  const name = path.basename(c.argv[0]);
  if (c.argv[0].includes('/') && !SYSTEM_BIN.test(c.argv[0])) return 'runs a file by path (code the worker can write)';
  if (ALWAYS_DENY_CMDS.has(name.toLowerCase())) return `${name} is never allowed`;
  const ex = executesCode(c.argv);
  if (ex) return ex;
  if (name.toLowerCase() === 'git' && !GIT_READONLY_SUB.has(gitInfo(c.argv).sub)) return `git ${gitInfo(c.argv).sub || '(no subcommand)'} is not a read-only git command (allowed: ${[...GIT_READONLY_SUB].join(', ')})`;
  if (PKG_MGRS.has(name)) return `${name} is a package manager / build tool`;
  return null;
}

function dangerous(policy, ctx, argv) {
  const name = path.basename(argv[0]);
  if (ALWAYS_DENY_CMDS.has(name)) return `${name} is never allowed`;
  if ((policy.bash?.deny || []).some((e) => prefixMatch(e, argv))) return POLICY_DENY_REASON;
  if (PKG_MGRS.has(name) && argv.slice(1).some((a) => PKG_VERBS.has(a))) return 'package installs are not allowed';
  if (name === 'chmod' && argv.some((a) => /^-[a-zA-Z]*R/.test(a))) return 'recursive chmod is not allowed';
  if (name === 'git') {
    const g = gitInfo(argv, ctx);
    if (g.opts.some((o) => ['-C', '-c', '--git-dir', '--work-tree'].includes(o) || o.startsWith('--git-dir=') || o.startsWith('--work-tree='))) return 'git option redirects the repository';
    if (GIT_DENY_SUB.has(g.sub)) return `git ${g.sub} is not allowed`;
    if (g.sub === 'reset' && g.rest.includes('--hard')) return 'git reset --hard is not allowed';
    if (['checkout', 'switch'].includes(g.sub)) {
      const protectedB = new Set(['main', 'master', ctx.base_branch].filter(Boolean));
      if (g.rest.some((a) => protectedB.has(a))) return 'switching to the base branch is not allowed';
    }
    if (g.sub === 'branch' && g.rest.some((a) => /^-[dD]$|--delete/.test(a))) return 'deleting branches is not allowed';
  }
  return executesCode(argv);
}

function evaluateBash(policy, command, ctx) {
  const budget = makeBudget(ctx);
  const R = makeResolver(ctx);
  const cwd = ctx.cwd || ctx.worktree;
  if (command.length > MAX_COMMAND) return res('deny', `command longer than ${MAX_COMMAND} characters`, 'unparsed');
  const p = parseShell(command);
  const askOn = new Set(policy.bash?.ask_on || []);
  let out = res('allow', 'all commands match the allowlist', 'bash_allow');
  const note = (r) => { out = worst(out, r); };
  const askOrDeny = (key, reason) => note(res(askOn.has(key) ? 'ask' : 'deny', reason, key, key === 'unparsed' ? 'floor' : 'default'));

  if (p.raw.length > MAX_REGEX_INPUT) note(res('ask', `command longer than ${MAX_REGEX_INPUT} characters (deny patterns are not run on it)`, 'command_too_long', 'floor'));
  else {
    for (const rx of policy.bash?.deny_patterns || []) {
      const m = regexTest(rx, p.raw, budget);
      if (m === 'budget') return res('deny', 'total deny-pattern time budget exhausted', 'regex_budget');
      if (m === 'error') return res('deny', 'invalid or too slow deny pattern in policy', 'policy_error');
      if (m) return res('deny', 'command matches a dangerous pattern', 'dangerous_pattern');
    }
  }
  if (!isInside(R.resolve('.', cwd).real, R.wt)) return res('deny', 'hook cwd is outside the task worktree', 'cwd_outside');
  if (!p.commands.length) return res('deny', 'empty command', 'unparsed');
  if (p.flags.substitution) askOrDeny('substitution', 'command or process substitution');
  if (p.flags.expansion || p.flags.heredoc || p.flags.subshell || p.flags.unterminated) askOrDeny('unparsed', 'shell construct the policy cannot analyse');

  for (const [ci, c] of p.commands.entries()) {
    if (!c.argv.length) {
      for (const rd of c.redirects) { const r = redirectCheck(policy, ctx, R, rd, cwd); if (r) note(r); }
      continue;
    }
    const name = path.basename(c.argv[0]);
    const why = dangerous(policy, ctx, c.argv);
    if (why) return res('deny', why, 'dangerous', why === POLICY_DENY_REASON && !dangerous({ ...policy, bash: { ...policy.bash, deny: [] } }, ctx, c.argv) ? 'default' : 'floor');
    if (c.ops === '|' && INTERPRETERS.has(name)) return res('deny', 'piping into an interpreter is not allowed', 'pipe_into_interpreter');
    if (/^[A-Za-z_]\w*=/.test(c.argv[0]) || c.argv[0].includes('$')) { askOrDeny('unparsed', 'variable assignment or expanded command name'); continue; }
    // after cd/pushd/popd the rest of the line runs in another directory than the one paths are resolved against
    if (['cd', 'pushd', 'popd'].includes(name) && ci < p.commands.length - 1) askOrDeny('unparsed', `${name} followed by more commands`);
    if (WRAPPERS.has(name)) askOrDeny('unknown_command', `${name} runs another command`);
    if (INTERPRETERS.has(name) && c.argv.slice(1).some((a) => INLINE_CODE.test(a) || /^-[a-zA-Z]*c$/.test(a) && name.endsWith('sh'))) askOrDeny('unknown_command', `${name} with inline code`);
    if (EXEC_FLAGS[name] && c.argv.slice(1).some((a) => EXEC_FLAGS[name].test(a))) askOrDeny('unknown_command', `${name} with an option that runs code or writes files`);

    for (const rd of c.redirects) { const r = redirectCheck(policy, ctx, R, rd, cwd); if (r) note(r); }

    // rm -r with operands outside the worktree is dangerous (no approval possible)
    const operands = c.argv.slice(1).filter((a) => !a.startsWith('-') || a === '-');
    const flagsV = c.argv.slice(1).filter((a) => a.startsWith('-'));
    if (name === 'rm' && flagsV.some((f) => /^-[a-zA-Z]*[rR]|--recursive/.test(f))) {
      for (const o of operands) { const { real } = R.resolve(o, cwd); if (!isInside(real, R.wt)) return res('deny', 'recursive rm outside the worktree', 'dangerous'); }
    }
    // path operands: reads inside the worktree (or read_extra), writes inside scope
    const mode = WRITE_CMDS.has(name) ? 'write' : 'read';
    for (const o of operands) {
      const looksPath = o.startsWith('/') || o.startsWith('~') || o.split('/').includes('..') || WRITE_CMDS.has(name);
      if (!looksPath && !ctx.realpath) continue;
      if (name !== 'rm' && !looksPath) { const r = checkPath(policy, ctx, R, o, 'read', cwd); if (r && r.rule === 'outside_read_root') note(r); else if (r && r.rule === 'path_denied') note(r); continue; }
      const r = checkPath(policy, ctx, R, o, mode, cwd);
      if (r) note(r);
    }
    for (const f of flagsV) {
      const m = /^--?[\w-]+=(.+)$/.exec(f);
      // --opt=/path and attached short options like -f/etc/passwd
      const v = m ? m[1] : (/^-[A-Za-z]./.test(f) ? f.slice(2) : null);
      if (v && (v.startsWith('/') || v.startsWith('~') || v.split('/').includes('..'))) { const r = checkPath(policy, ctx, R, v, 'read', cwd); if (r) note(r); }
    }
    if (name === 'find' && c.argv.some((a) => ['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint'].includes(a))) { note(res('ask', 'find with an action', 'unknown_command', 'floor', 'find_action')); continue; }
    if (name === 'cd') { if (!operands.length) note(res('deny', 'cd without target', 'outside_read_root')); continue; }

    const granted = (ctx.grants || []).some((g) => g.kind === 'command' && (g.command === p.raw.trim() || (Array.isArray(g.argv) && prefixMatch(g.argv.join(' '), c.argv))));
    const allowed = [...(policy.bash?.allow || []), ...(ctx.allowed_commands || [])].some((e) => prefixMatch(e, c.argv, { strictName: true }));
    if (!granted && !allowed) askOrDeny('unknown_command', `command not on the allowlist: ${name}`);
  }
  if (out.decision === 'allow' && p.commands.every((c) => c.argv.length === 0)) return res('deny', 'nothing to run', 'unparsed');
  return out;
}

function redirectCheck(policy, ctx, R, rd, cwd) {
  const t = rd.target;
  if (t === '/dev/null' || /^\d+$/.test(t) || t === '-') return null;
  return checkPath(policy, ctx, R, t, WRITE_REDIRECTS.has(rd.op) ? 'write' : 'read', cwd);
}

/**
 * @param policy  merged policy object (see DEFAULT_POLICY)
 * @param toolCall {tool_name, tool_input, cwd?}
 * @returns {decision, reason, rule, rule_id: '<layer>:<rule>', layer: 'floor'|'default'}
 * @param ctx {worktree, path_scope[], allowed_tools[], allowed_commands[], grants[], home?, base_branch?, realpath?(abs)->real}
 */
export function evaluate(policy, toolCall, ctx) { return withId(evaluateRaw(policy, toolCall, ctx)); }

function evaluateRaw(policy, toolCall, ctx) {
  try {
    const pol = mergePolicy(policy);
    const tool = toolCall?.tool_name;
    const input = toolCall?.tool_input || {};
    const c = { ...ctx, cwd: toolCall?.cwd || ctx.cwd || ctx.worktree };
    if (!ctx || !ctx.worktree) return res('deny', 'no worktree configured', 'no_context');
    if (!pol.tools.allow.includes(tool) || (Array.isArray(ctx.allowed_tools) && !ctx.allowed_tools.includes(tool))) {
      return res('deny', `tool ${tool} is not allowed for this task`, 'tool_not_allowed');
    }
    const R = makeResolver(c);
    if (WRITE_TOOLS.has(tool)) {
      const target = input.file_path || input.notebook_path;
      if (typeof target !== 'string' || !target) return res('deny', 'missing file path', 'unparsed');
      return checkPath(pol, c, R, target, 'write', c.cwd) || res('allow', 'write inside worktree and path_scope', 'write_in_scope');
    }
    if (READ_TOOLS.has(tool)) {
      const target = input.file_path || input.path || input.notebook_path || '.';
      const r = checkPath(pol, c, R, String(target), 'read', c.cwd);
      if (r) return r;
      // Glob: an absolute, ~ or .. pattern ("/home/u/.ssh/*", "../../**/*.pem") lists files outside the search path
      if (tool === 'Glob' && typeof input.pattern === 'string' && (/^[/~]/.test(input.pattern) || input.pattern.split('/').includes('..'))) {
        const segs = input.pattern.split('/'); const k = segs.findIndex((x) => /[*?[{]/.test(x));
        const prefix = (k < 0 ? segs : segs.slice(0, k)).join('/') || '/';
        const g = checkPath(pol, c, R, prefix, 'read', path.resolve(c.cwd, String(input.path || '.')));
        if (g) return g;
      }
      return res('allow', 'read inside worktree', 'read_in_worktree');
    }
    if (tool === 'Bash') {
      if (typeof input.command !== 'string') return res('deny', 'missing command', 'unparsed');
      return evaluateBash(pol, input.command, c);
    }
    return res(pol.default === 'allow' ? 'allow' : 'deny', `no rule for tool ${tool}`, 'default');
  } catch (e) {
    return res('deny', `policy error: ${e.message}`, 'policy_error');
  }
}

/**
 * Worktree-relative path (as `git status` prints it) hit by a protected-path rule (.git, .claude/settings*.json, ...)?
 * Used on the engine's snapshot so files written without a tool call (e.g. by code a test run executed) cannot be committed.
 */
export function isProtectedRel(policy, rel) {
  const pol = mergePolicy(policy);
  const p = fold(`/${rel}`);
  const globs = [...(pol.paths?.deny || []), ...(pol.paths?.scope_deny || []), ...FLOOR_DENY_GLOBS].map(fold);
  return globs.some((g) => (g.startsWith('**/') ? globToRegex(g).test(p) : g.startsWith('~') ? false : isRootRelative(g) && matchGlob(g.replace(/^\.\//, ''), fold(rel))));
}

/** Stable short key identifying a tool call (used to de-duplicate approval requests). */
export function callSummary(toolCall) {
  const i = toolCall?.tool_input || {};
  return toolCall?.tool_name === 'Bash' ? String(i.command ?? '') : String(i.file_path ?? i.path ?? i.notebook_path ?? '');
}

/** First word only: what is safe to put in the monitor-visible event log. */
export const safeLabel = (toolCall) => `${toolCall?.tool_name}:${callSummary(toolCall).trim().split(/\s+/)[0]?.slice(0, 40) || ''}`;

export { isInside };
