// The `claude` CLI version, recorded per attempt (alignment doc row 22). One probe per engine start (cached by the caller); never throws.
import { execFile } from 'node:child_process';
import { resolveBin } from './worker.mjs';

/** First line of `claude --version`, cut to 80 characters, or null when the probe fails or times out. */
export function probeClaudeVersion(bin, env = process.env, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    try {
      const cleanEnv = { PATH: env.PATH || '/usr/bin:/bin', HOME: env.HOME || '' };
      execFile(resolveBin(bin, cleanEnv.PATH), ['--version'], { env: cleanEnv, timeout: timeoutMs, encoding: 'utf8' }, (err, out) => {
        const line = err ? '' : String(out).split('\n')[0].trim();
        resolve(line ? line.replace(/[^\x20-\x7e]/g, '?').slice(0, 80) : null);
      });
    } catch { resolve(null); }
  });
}

/** Versions that differ from the one the goal started with: [{task, n, version}]. Attempts without a recorded version are ignored. */
export function versionDrift(start, tasks) {
  if (!start) return [];
  const out = [];
  for (const t of tasks) for (const a of t.orch?.attempt_log || []) if (a.claude_version && a.claude_version !== start) out.push({ task: t.id, n: a.n, version: a.claude_version });
  return out;
}
