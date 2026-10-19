// Untrusted repository configuration (security review condition 2). A repo can steer a Claude Code worker through
// its own project config: hooks, permissions, env, MCP servers, apiKeyHelper, statusLine, plugins, and executable
// .claude/{hooks,commands,agents,skills}. scanRepoConfig() finds those; createGoal refuses such repos unless the human
// passes --trust-repo-config. CLAUDE.md files are only hashed (trusted-input risk, not refused). Pure fs reads, no exec.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// settings keys that are inert; anything else is refused (fail closed) when present with a non-empty value
const BENIGN_KEYS = new Set(['$schema', 'model', 'includeCoAuthoredBy', 'cleanupPeriodDays', 'outputStyle', 'language', 'spinnerTipsEnabled', 'alwaysThinkingEnabled',
  'attribution', 'respectGitignore', 'verbose', 'autoUpdates', 'theme']);
const DANGEROUS_KEYS = new Set(['hooks', 'disableAllHooks', 'permissions', 'env', 'mcpServers', 'enabledMcpjsonServers', 'enableAllProjectMcpServers', 'disabledMcpjsonServers',
  'apiKeyHelper', 'statusLine', 'enabledPlugins', 'extraKnownMarketplaces', 'plugins', 'commands', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper',
  'additionalDirectories', 'sandbox', 'fileSuggestion', 'forceLoginMethod', 'autoMemoryDirectory']);
const SETTINGS_FILES = ['settings.json', 'settings.local.json'];
const CODE_DIRS = ['hooks', 'commands', 'agents', 'skills'];
export const INSTRUCTION_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];

const empty = (v) => v == null || v === false || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
export const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** Directories to scan: `start` and each parent up to and including `root` (the git root). */
export function chainDirs(start, root) {
  const out = []; let d = path.resolve(start); const r = path.resolve(root);
  for (let i = 0; i < 64; i++) {
    out.push(d);
    if (d === r || path.dirname(d) === d) break;
    d = path.dirname(d);
    if (!d.startsWith(r)) break; // start was not inside root: scan only start
  }
  return out;
}

function walkFiles(dir, out = [], depth = 0) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const f = path.join(dir, n);
    let st; try { st = fs.lstatSync(f); } catch { continue; }
    if (st.isDirectory() && depth < 8) walkFiles(f, out, depth + 1);
    else out.push({ file: f, st });
  }
  return out;
}

function scanSettings(file, findings) {
  let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; findings.push({ path: file, kind: 'settings', detail: `unreadable: ${e.code || e.message}` }); return; }
  let j; try { j = JSON.parse(txt); } catch { findings.push({ path: file, kind: 'settings', detail: 'is not valid JSON (cannot be verified)' }); return; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) { findings.push({ path: file, kind: 'settings', detail: 'is not a JSON object' }); return; }
  for (const [k, v] of Object.entries(j)) {
    if (BENIGN_KEYS.has(k)) continue;
    if (empty(v) && DANGEROUS_KEYS.has(k)) continue;
    findings.push({ path: file, kind: DANGEROUS_KEYS.has(k) ? k : 'unknown_key', detail: DANGEROUS_KEYS.has(k) ? `defines "${k}"` : `has unvetted key "${k}"` });
  }
}

/**
 * @returns {{findings: {path, kind, detail}[]}}  anything that could add hooks/permissions/env/MCP/helpers/plugins/commands to a worker.
 */
export function scanRepoConfig(start, root = start) {
  const findings = [];
  for (const d of chainDirs(start, root)) {
    for (const n of SETTINGS_FILES) scanSettings(path.join(d, '.claude', n), findings);
    // any other settings*.json (managed/legacy names) is treated the same way
    try { for (const n of fs.readdirSync(path.join(d, '.claude'))) if (/^settings.*\.json$/i.test(n) && !SETTINGS_FILES.includes(n)) scanSettings(path.join(d, '.claude', n), findings); } catch { /* none */ }
    const mcp = path.join(d, '.mcp.json');
    if (fs.existsSync(mcp)) {
      let j = null; try { j = JSON.parse(fs.readFileSync(mcp, 'utf8')); } catch { findings.push({ path: mcp, kind: 'mcp', detail: 'is not valid JSON (cannot be verified)' }); }
      if (j && !empty(j.mcpServers) ) findings.push({ path: mcp, kind: 'mcp', detail: `defines MCP servers: ${Object.keys(j.mcpServers).slice(0, 5).join(', ')}` });
      else if (j && Object.keys(j).some((k) => k !== 'mcpServers')) findings.push({ path: mcp, kind: 'mcp', detail: 'has unvetted keys' });
    }
    for (const cd of CODE_DIRS) {
      const dir = path.join(d, '.claude', cd);
      let st; try { st = fs.lstatSync(dir); } catch { continue; }
      if (st.isSymbolicLink()) { findings.push({ path: dir, kind: `${cd}_dir`, detail: 'is a symlink' }); continue; }
      const files = walkFiles(dir).filter((x) => x.st.isSymbolicLink() || (x.st.isFile() && x.st.size > 0));
      if (files.length) findings.push({ path: dir, kind: `${cd}_dir`, detail: `contains executable/instruction content (${files.length} file(s), e.g. ${path.relative(dir, files[0].file)})` });
    }
  }
  return { findings };
}

export const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** Hash the instruction files as they exist in a checked-out tree (the worktree a worker will run in). rel -> sha256|null */
export function instructionHashes(dir) {
  const out = {};
  for (const rel of INSTRUCTION_FILES) {
    try { const f = path.join(dir, rel); out[rel] = fs.statSync(f).isFile() ? sha256File(f) : null; } catch { out[rel] = null; }
  }
  return out;
}

export const formatFindings = (findings) => findings.map((f) => `${f.path}: ${f.detail}`).join('\n  ');
export const instructionNotice = (repo, hashes) => Object.entries(hashes).filter(([, h]) => h).map(([rel, h]) => `repo instructions will be loaded by workers: ${path.join(repo, rel)} ${h.slice(0, 12)}`);
