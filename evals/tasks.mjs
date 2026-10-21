// Eval task specs. Each: { id, profile, prompt, seed(dir) -> writes the seed repo files, grade(dir) -> {ok, why}, fake }.
// `grade` is a deterministic grader that only READS files from the integration checkout. Code tasks load the model-written module in a vm context
// with a timeout (not a security boundary: run real evals on a machine where that is acceptable). `fake` feeds `--fake` mode (test/fake-claude.mjs):
// a valid draft, a one-task plan and the worker's file edits that satisfy the grader.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } };
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
function loadCjs(code) { const m = { exports: {} }; vm.runInNewContext(code, { module: m, exports: m.exports }, { timeout: 1000 }); return m.exports; }
const verdict = (ok, why) => ({ ok: !!ok, why: ok ? 'ok' : why });

const NODE_TEST = { argv: ['node', '--test'], timeout_s: 60 };
const draftOf = (title, description, extra = []) => ({ title, description, success_criteria: [
  { id: 'c1', text: 'the node tests pass', check: NODE_TEST }, { id: 'c2', text: 'the node tests pass on the integration branch', check: NODE_TEST }, ...extra ],
  budgets: { max_new_tokens: 300000, max_attempts: 2 }, risks: [] });
const GREP_DRAFT = (title, description, file, needle) => ({ title, description, success_criteria: [
  { id: 'c1', text: `${file} mentions the new text`, check: { argv: ['grep', '-q', needle, file], timeout_s: 30 } },
  { id: 'c2', text: `${file} still exists`, check: { argv: ['test', '-f', file], timeout_s: 30 } } ], budgets: { max_new_tokens: 300000, max_attempts: 2 }, risks: [] });
const onePlan = (t) => ({ tasks: [{ id: 't1', depends_on: [], model_tier: 'haiku', allowed_commands: [], ...t }], risks: [] });
// node-library turns on checks.acceptance_first: an acceptance task writes test/accept.test.js first and the implementation task depends on it
const accPlan = (t) => ({ tasks: [{ id: 't0', role: 'acceptance', depends_on: [], model_tier: 'haiku', allowed_commands: [], title: 'Acceptance test', description: 'Write test/accept.test.js only',
  path_scope: ['test/accept.test.js'], checks: [{ argv: ['node', '--check', 'test/accept.test.js'], timeout_s: 30 }], output_contract: 'test written', acceptance: ['test/accept.test.js parses'] },
  { id: 't1', depends_on: ['t0'], model_tier: 'haiku', allowed_commands: [], ...t }], risks: [] });

export const TASKS = [
  { id: 'readme-usage', profile: 'docs-only',
    prompt: 'Add a "## Usage" section to README.md with a fenced shell block that shows the command `npm start`. Keep the existing title.',
    seed(d) { put(d, 'README.md', '# Widget\n\nA tiny widget.\n'); },
    grade(d) { const t = read(d, 'README.md') || ''; return verdict(/^# Widget$/m.test(t) && /^## Usage\s*$/m.test(t) && /```[a-z]*\n[^`]*npm start[^`]*```/.test(t), 'README.md lacks the title, the Usage heading or a fenced npm start block'); },
    fake: { draft: { ...GREP_DRAFT('Add Usage section', 'Document npm start in README.md.', 'README.md', 'Usage'), // real drafts often add a human criterion here: exercise the eval's stand-in confirm
        success_criteria: [...GREP_DRAFT('', '', 'README.md', 'Usage').success_criteria, { id: 'title-kept', text: 'the existing title is unchanged', verify: 'human' }] },
      plan: onePlan({ title: 'Add usage', description: 'Add a Usage section to README.md', path_scope: ['README.md'], checks: [{ argv: ['grep', '-q', 'Usage', 'README.md'], timeout_s: 30 }], output_contract: 'README has Usage', acceptance: ['README has a Usage section'] }),
      edits: [{ path: 'README.md', content: '# Widget\n\nA tiny widget.\n\n## Usage\n\n```sh\nnpm start\n```\n' }] } },
  { id: 'changelog-entry', profile: 'docs-only',
    prompt: 'Add a new "## 1.1.0" entry to CHANGELOG.md above the existing 1.0.0 entry, with one bullet: "- add retry to the fetcher". Do not change the 1.0.0 entry.',
    seed(d) { put(d, 'CHANGELOG.md', '# Changelog\n\n## 1.0.0\n\n- initial release\n'); },
    grade(d) { const t = read(d, 'CHANGELOG.md') || ''; const a = t.indexOf('## 1.1.0'); const b = t.indexOf('## 1.0.0');
      return verdict(a > 0 && b > a && /^- add retry to the fetcher\s*$/m.test(t.slice(a, b)) && /- initial release/.test(t.slice(b)), 'missing 1.1.0 entry above 1.0.0 with the retry bullet, or 1.0.0 changed'); },
    fake: { draft: GREP_DRAFT('Changelog 1.1.0', 'Add the 1.1.0 entry.', 'CHANGELOG.md', '1.1.0'),
      plan: onePlan({ title: 'Add entry', description: 'Add the 1.1.0 changelog entry', path_scope: ['CHANGELOG.md'], checks: [{ argv: ['grep', '-q', '1.1.0', 'CHANGELOG.md'], timeout_s: 30 }], output_contract: 'entry added', acceptance: ['1.1.0 entry exists'] }),
      edits: [{ path: 'CHANGELOG.md', content: '# Changelog\n\n## 1.1.0\n\n- add retry to the fetcher\n\n## 1.0.0\n\n- initial release\n' }] } },
  { id: 'fix-add', profile: 'node-library',
    prompt: 'The function add in src/add.js returns the wrong result (see test/add.test.js). Fix src/add.js so `node --test` passes. Do not edit the test.',
    seed(d) { put(d, 'package.json', '{"name":"adder","version":"1.0.0","scripts":{"test":"node --test"}}\n'); put(d, 'src/add.js', 'exports.add = (a, b) => a - b;\n');
      put(d, 'test/add.test.js', "const test = require('node:test'); const assert = require('node:assert'); const { add } = require('../src/add.js');\ntest('add', () => { assert.strictEqual(add(2, 3), 5); assert.strictEqual(add(-1, 1), 0); });\n"); },
    grade(d) { try { const { add } = loadCjs(read(d, 'src/add.js') || ''); const orig = read(d, 'test/add.test.js') || '';
      return verdict(add(2, 3) === 5 && add(-1, 1) === 0 && add(0, 0) === 0 && /strictEqual\(add\(2, 3\), 5\)/.test(orig), 'add() is wrong or the test was edited'); } catch (e) { return verdict(false, `src/add.js failed to load: ${e.message}`); } },
    fake: { draft: draftOf('Fix add', 'Fix src/add.js.'),
      plan: accPlan({ title: 'Fix add', description: 'Fix add in src/add.js', path_scope: ['src/add.js'], checks: [NODE_TEST], output_contract: 'add works', acceptance: ['node --test passes'] }),
      accept: "const test = require('node:test'); const assert = require('node:assert'); const { add } = require('../src/add.js');\ntest('accept add', () => { assert.strictEqual(add(1, 2), 3); });\n",
      edits: [{ path: 'src/add.js', content: 'exports.add = (a, b) => a + b;\n' }] } },
  { id: 'add-slugify', profile: 'node-library',
    prompt: 'Add src/slugify.js (CommonJS, module.exports = { slugify }) where slugify(s) lowercases, trims, replaces each run of non-alphanumeric characters with a single "-" and has no leading or trailing "-". Add test/slugify.test.js using node:test that covers it.',
    seed(d) { put(d, 'package.json', '{"name":"slug","version":"1.0.0","scripts":{"test":"node --test"}}\n'); put(d, 'src/index.js', '// entry point\n'); },
    grade(d) { try { const { slugify } = loadCjs(read(d, 'src/slugify.js') || ''); const cases = [['Hello World', 'hello-world'], ['  A  B  ', 'a-b'], ['a--b__c', 'a-b-c'], ['---x---', 'x'], ['ABC123', 'abc123']];
      const bad = cases.find(([i, o]) => slugify(i) !== o); const tests = read(d, 'test/slugify.test.js') || '';
      return verdict(!bad && /node:test/.test(tests) && /slugify/.test(tests), bad ? `slugify(${JSON.stringify(bad[0])}) !== ${JSON.stringify(bad[1])}` : 'test/slugify.test.js missing or does not use node:test'); } catch (e) { return verdict(false, `src/slugify.js failed to load: ${e.message}`); } },
    fake: { draft: draftOf('Add slugify', 'Add src/slugify.js and a test.'),
      accept: "const test = require('node:test'); const assert = require('node:assert'); const { slugify } = require('../src/slugify.js');\ntest('accept slugify', () => { assert.strictEqual(slugify(' A b '), 'a-b'); });\n",
      plan: accPlan({ title: 'Add slugify', description: 'Add src/slugify.js and its test', path_scope: ['src/slugify.js', 'test/slugify.test.js'], checks: [NODE_TEST], output_contract: 'slugify works', acceptance: ['node --test passes'] }),
      edits: [{ path: 'src/slugify.js', content: "exports.slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n" },
        { path: 'test/slugify.test.js', content: "const test = require('node:test'); const assert = require('node:assert'); const { slugify } = require('../src/slugify.js');\ntest('slugify', () => { assert.strictEqual(slugify('Hello World'), 'hello-world'); });\n" }] } },
  { id: 'count-cli', profile: 'node-library',
    prompt: 'Add src/count.js (CommonJS, module.exports = { count }) where count(text) returns { lines, words, chars }: lines = number of "\\n"-separated lines (0 for the empty string, a trailing newline does not start a new line), words = runs of non-whitespace, chars = text.length. Add bin/count.js that reads stdin and prints "<lines> <words> <chars>". Add tests in test/count.test.js using node:test, and a "## count" section to README.md showing `echo hi | node bin/count.js`.',
    seed(d) { put(d, 'package.json', '{"name":"counter","version":"1.0.0","scripts":{"test":"node --test"}}\n'); put(d, 'README.md', '# counter\n'); },
    grade(d) { try { const { count } = loadCjs(read(d, 'src/count.js') || ''); const cases = [['', [0, 0, 0]], ['hi\n', [1, 1, 3]], ['a b\nc', [2, 3, 5]], ['  x  \n\n', [2, 1, 7]]];
      const bad = cases.find(([i, [l, w, c]]) => { const r = count(i); return !r || r.lines !== l || r.words !== w || r.chars !== c; });
      const bin = read(d, 'bin/count.js') || ''; const t = read(d, 'test/count.test.js') || ''; const rd = read(d, 'README.md') || '';
      if (bad) return verdict(false, `count(${JSON.stringify(bad[0])}) is wrong`);
      return verdict(/count/.test(bin) && /stdin/.test(bin) && /node:test/.test(t) && /^## count\s*$/m.test(rd) && /node bin\/count\.js/.test(rd), 'bin/count.js, test/count.test.js or the README section is missing'); } catch (e) { return verdict(false, `src/count.js failed to load: ${e.message}`); } },
    fake: { draft: draftOf('Add count', 'Add src/count.js, bin/count.js, tests and a README section.'),
      accept: "const test = require('node:test'); const assert = require('node:assert'); const { count } = require('../src/count.js');\ntest('accept count', () => { assert.deepStrictEqual(count('a b\\nc'), { lines: 2, words: 3, chars: 5 }); });\n",
      plan: accPlan({ title: 'Add count', description: 'Add the count library, CLI, test and README section', path_scope: ['src/count.js', 'bin/count.js', 'test/count.test.js', 'README.md'], checks: [NODE_TEST], output_contract: 'count works', acceptance: ['node --test passes'] }),
      edits: [{ path: 'src/count.js', content: "exports.count = (t) => ({ lines: t === '' ? 0 : t.replace(/\\n$/, '').split('\\n').length, words: (t.match(/\\S+/g) || []).length, chars: t.length });\n" },
        { path: 'bin/count.js', content: "const { count } = require('../src/count.js'); let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => { const r = count(s); console.log(`${r.lines} ${r.words} ${r.chars}`); });\n" },
        { path: 'test/count.test.js', content: "const test = require('node:test'); const assert = require('node:assert'); const { count } = require('../src/count.js');\ntest('count', () => { assert.deepStrictEqual(count('hi\\n'), { lines: 1, words: 1, chars: 3 }); });\n" },
        { path: 'README.md', content: '# counter\n\n## count\n\n```sh\necho hi | node bin/count.js\n```\n' }] } },
  { id: 'two-bug-trap', profile: 'node-library',
    prompt: 'The cart tests fail. Make all tests pass.',
    seed(d) { put(d, 'package.json', '{"name":"cart","version":"1.0.0","scripts":{"test":"node --test"}}\n');
      put(d, 'src/price.js', '// price in pence after a percentage discount, rounded to the nearest penny\nexports.discounted = (pence, pct) => Math.floor(pence * (100 - pct) / 100);\n');
      put(d, 'src/cart.js', "const { discounted } = require('./price.js');\n// total in pence of [{ pence, qty, pct }]\nexports.total = (items) => items.slice(1).reduce((s, i) => s + discounted(i.pence, i.pct || 0) * i.qty, 0);\n");
      put(d, 'test/cart.test.js', "const test = require('node:test'); const assert = require('node:assert'); const { total } = require('../src/cart.js'); const { discounted } = require('../src/price.js');\ntest('discount rounds to nearest', () => { assert.strictEqual(discounted(999, 15), 849); assert.strictEqual(discounted(1001, 50), 501); });\ntest('total sums every line', () => { assert.strictEqual(total([{ pence: 100, qty: 2 }, { pence: 250, qty: 1, pct: 10 }]), 425); });\n"); },
    grade(d) { try { const t = read(d, 'test/cart.test.js') || '';
      if (!/strictEqual\(discounted\(999, 15\), 849\)/.test(t) || !/strictEqual\(discounted\(1001, 50\), 501\)/.test(t) || !/, 425\)/.test(t)) return verdict(false, 'the existing assertions in test/cart.test.js were changed');
      const P = loadCjs(read(d, 'src/price.js') || ''); const src = (read(d, 'src/cart.js') || '').replace("require('./price.js')", '__price'); const m = { exports: {} };
      vm.runInNewContext(src, { module: m, exports: m.exports, __price: P }, { timeout: 1000 });
      const ok = P.discounted(999, 15) === 849 && P.discounted(1001, 50) === 501 && P.discounted(199, 50) === 100 && m.exports.total([{ pence: 10, qty: 3 }, { pence: 200, qty: 1, pct: 50 }, { pence: 1, qty: 1 }]) === 131;
      return verdict(ok, 'discounted() or total() is still wrong on hidden cases'); } catch (e) { return verdict(false, `src failed to load: ${e.message}`); } },
    fake: { draft: draftOf('Fix cart', 'Fix the rounding and the sum.'),
      accept: "const test = require('node:test'); const assert = require('node:assert'); const { total } = require('../src/cart.js');\ntest('accept total', () => { assert.strictEqual(total([{ pence: 10, qty: 3 }]), 30); });\n",
      plan: accPlan({ title: 'Fix cart', description: 'Fix src/price.js rounding and src/cart.js sum', path_scope: ['src/price.js', 'src/cart.js'], checks: [NODE_TEST], output_contract: 'tests pass', acceptance: ['node --test passes'] }),
      edits: [{ path: 'src/price.js', content: '// price in pence after a percentage discount, rounded to the nearest penny\nexports.discounted = (pence, pct) => Math.round(pence * (100 - pct) / 100);\n' },
        { path: 'src/cart.js', content: "const { discounted } = require('./price.js');\n// total in pence of [{ pence, qty, pct }]\nexports.total = (items) => items.reduce((s, i) => s + discounted(i.pence, i.pct || 0) * i.qty, 0);\n" }] } },
];
