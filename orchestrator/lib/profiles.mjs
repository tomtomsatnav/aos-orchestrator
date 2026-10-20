// Profiles (docs/rules-design.md 4.2, 4.3): goal-layer rules objects chosen by the human. Pure data, no imports.
const gl = (id, glob) => ({ id, glob }); const cm = (id, cmd, description) => ({ id, cmd, ...(description ? { description } : {}) });
export const PROFILES = Object.freeze({
  strict: null,
  'node-library': { rules_version: 1,
    checks: { allowlist: [cm('node-test', 'node --test', 'built-in test runner'), cm('npm-test', 'npm test'), cm('node-check', 'node --check')], max_timeout_s: 600, allow_loopback: false, protect_existing_tests: true, acceptance_first: true },
    worker: { paths: { deny: [gl('lockfile', '**/package-lock.json'), gl('ci', '**/.github/**')] } },
    plan: { scope_deny: [gl('no-node-modules', 'node_modules/**')], max_tasks: 8 }, retry: { max_attempts: 3 } },
  'docs-only': { rules_version: 1,
    worker: { tools: { allow: ['Read', 'Glob', 'Grep', 'Edit', 'Write'] }, paths: { on_outside_scope: 'deny' } },
    plan: { approval: 'auto', tiers: ['haiku', 'sonnet'], max_start_tier: 'haiku', scope_deny: [gl('code', '**/*.{js,mjs,ts,py,sh}')], max_tasks: 6 },
    checks: { allowlist: [cm('grep', 'grep'), cm('test', 'test')], max_timeout_s: 60 }, retry: { ladder: ['haiku', 'sonnet'], max_attempts: 2 },
    budgets: { max_new_tokens: 300000, max_usd: 1 } },
});
