#!/usr/bin/env node
// Step 2 of the demo: screenshot the dashboard's Guard view rendering the copied verdicts (demo/data/orch/verdicts/).
// Checks out the dashboard repo's guard-view branch into a detached scratch worktree (the user's checkout is not switched), runs its
// monitor on port 4397 with an empty live dir and AOS_ORCH_DIR pointing at a scratch copy of demo/data/orch, crops the rejected verdict,
// writes demo/data/dashboard-header.png and demo/data/dashboard-failing.png, then stops the monitor and removes the worktree.
//   node demo/capture-dashboard.mjs   (env: DASH_REPO, PLAYWRIGHT)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const DASH = process.env.DASH_REPO || '/Users/tom/agent-orchestration-standard';
const { chromium } = await import(process.env.PLAYWRIGHT || '/Users/tom/career-ops/node_modules/playwright/index.mjs');
const PORT = 4397; // never 4318 (the user's live monitor)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-demo-dash-'));
const wt = path.join(scratch, 'dash'), live = path.join(scratch, 'live'), orch = path.join(scratch, 'orch');
fs.mkdirSync(live); fs.cpSync(path.join(DATA, 'orch'), orch, { recursive: true });
const rev = execFileSync('git', ['-C', DASH, 'rev-parse', '--short', 'guard-view'], { encoding: 'utf8' }).trim();
execFileSync('git', ['-C', DASH, 'worktree', 'add', '--detach', wt, 'guard-view'], { stdio: 'inherit' });
const mon = spawn('node', [path.join(wt, 'monitor.mjs')], { env: { ...process.env, PORT: String(PORT), AOS_LIVE_DIR: live, AOS_ORCH_DIR: orch }, stdio: ['ignore', 'pipe', 'inherit'] });
try {
  await new Promise((ok, no) => { mon.stdout.on('data', (d) => /live monitor on/.test(String(d)) && ok()); mon.on('exit', () => no(new Error('monitor exited'))); setTimeout(() => no(new Error('monitor did not start')), 10000); });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 4 });
  await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForTimeout(2500);
  await page.locator('button', { hasText: /GUARD/i }).first().click(); await page.waitForTimeout(1200);
  const card = page.locator('#guard-panel li[data-verdict]', { hasText: 'vat-cheat' }).first();
  await card.waitFor();
  // Tight boxes around the text that matters (measured from the rendered DOM, so the crop is the dashboard's own pixels).
  const boxes = await card.evaluate((li) => {
    const box = (nodes) => { let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0; for (const n of nodes) { const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) { x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); } } return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }; };
    const r1 = li.querySelector('.guard-r1'), ul = li.querySelector('.guard-failing'), h = ul.previousElementSibling;
    return { header: box([...r1.children]), failing: box([h, ...ul.children]), text: { header: r1.innerText, failing: h.innerText + '\n' + ul.innerText } };
  });
  const pad = (b, p) => ({ x: b.x - p, y: b.y - p, width: b.width + 2 * p, height: b.height + 2 * p });
  await page.screenshot({ path: path.join(DATA, 'dashboard-header.png'), clip: pad(boxes.header, 8) });
  await page.screenshot({ path: path.join(DATA, 'dashboard-failing.png'), clip: pad(boxes.failing, 8) });
  fs.writeFileSync(path.join(DATA, 'dashboard-text.json'), JSON.stringify({ captured_at: new Date().toISOString(), dashboard_rev: `guard-view ${rev}`, port: PORT, boxes }, null, 2) + '\n');
  fs.appendFileSync(path.join(DATA, 'SOURCES.md'), `\nDashboard crops captured ${new Date().toISOString()} from ${DASH} guard-view ${rev} (monitor.mjs on port ${PORT}, AOS_ORCH_DIR = copy of demo/data/orch, empty live dir); visible text in \`dashboard-text.json\`.\n`);
  await browser.close();
  console.log('captured', JSON.stringify(boxes.text));
} finally {
  mon.kill();
  execFileSync('git', ['-C', DASH, 'worktree', 'remove', '--force', wt], { stdio: 'inherit' });
  fs.rmSync(scratch, { recursive: true, force: true });
}
