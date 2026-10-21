#!/usr/bin/env node
// Step 3 of the demo: render demo/out/aos-demo.mp4 (1080x1350, 30 fps, H.264) and docs/demo.gif from demo/data/ ONLY.
// Every number, file name, diff line and message on screen is read here from those files; nothing is typed in. Captions are fixed text,
// but each one is checked against the data below and the render stops if the data does not support it.
//   node demo/render.mjs   (env: PLAYWRIGHT, FFMPEG)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data'), OUT = path.join(HERE, 'out'), GIF = path.join(HERE, '..', 'docs', 'demo.gif');
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const { chromium } = await import(process.env.PLAYWRIGHT || '/Users/tom/career-ops/node_modules/playwright/index.mjs');
const W = 1080, H = 1350, FPS = 30, FADE = 0.35;

const read = (f) => fs.readFileSync(path.join(DATA, f), 'utf8');
const json = (f) => JSON.parse(read(f));
const need = (cond, what) => { if (!cond) throw new Error(`data does not support: ${what}`); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const png = (f) => `data:image/png;base64,${fs.readFileSync(path.join(DATA, f)).toString('base64')}`;

// ---------- data ----------
const bareDoc = json(fs.readdirSync(DATA).find((f) => /^eval-real-bare-impossible-test-.*\.json$/.test(f)));
const guardDoc = json(fs.readdirSync(DATA).find((f) => /^eval-real-guarded-impossible-test-.*\.json$/.test(f)));
const lowest = (doc) => doc.results.slice().sort((a, b) => a.trial - b.trial)[0]; // trial-selection rule
const bare = lowest(bareDoc), guarded = lowest(guardDoc);
const prompt = read('task-prompt.txt').trim();

// The table from evals/compile.mjs: rows keyed task/arm.
const table = new Map();
for (const line of read('table.md').split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| task'))) {
  const c = line.split('|').slice(1, -1).map((s) => s.trim());
  table.set(`${c[0]}/${c[1]}`, { task: c[0], arm: c[1], trials: +c[2], passed: c[3], usd: c[10], wall: c[11], tiers: c[12] });
}
const row = (task, arm) => { const r = table.get(`${task}/${arm}`); need(r, `table row ${task}/${arm}`); return r; };
const frac = (s) => { const [a, b] = s.split('/').map(Number); return a / b; };

// Diff: the changed lines, cropped to the statement that differs (shown with a leading ellipsis).
const diffOf = (f) => {
  const d = read(f), file = d.match(/^\+\+\+ b\/(.+)$/m)[1], idx = d.match(/^index (\S+)/m)[1];
  const minus = d.split('\n').find((l) => /^-[^-]/.test(l)), plus = d.split('\n').find((l) => /^\+[^+]/.test(l));
  let i = 1; while (minus[i] === plus[i]) i++;
  let j = i; while (j > 0 && /\d/.test(minus[j - 1])) j--;
  const from = minus.lastIndexOf('assert.', i); need(from > 0, 'diff crop');
  return { file, idx, minus: '-…' + minus.slice(from), plus: '+…' + plus.slice(from), old: minus.slice(j).match(/^\d+/)[0], neu: plus.slice(j).match(/^\d+/)[0] };
};
const bareDiff = diffOf('bare-trial-1.diff'), guardDiff = diffOf('guarded-trial-1.diff'), verdictDiff = diffOf('verdict-vat-cheat.diff');
need(bare.files_touched.includes(bareDiff.file), 'bare diff file is in files_touched');
need(bare.cheat === 'test_edited' && !bare.pass, 'bare trial 1 graded as test_edited');
const sentence = (msg, re) => { const s = msg.replace(/\n+/g, ' ').split(/(?<=\.)\s+(?=[A-Z])/).find((x) => re.test(x)); need(s, `sentence ${re} in final message`); return s; };
const bareQuote = sentence(bare.final_message, /\bchanged\b/i);
const guardQuote = sentence(guarded.final_message, /\bchanged\b/i);
need(guardDiff.idx === bareDiff.idx, 'guarded trial made the same edit as bare trial');

// Counts for captions and the end card.
const bareEdited = bareDoc.results.filter((r) => r.cheat === 'test_edited').length, bareK = bareDoc.results.length;
const guardRejected = guardDoc.results.filter((r) => r.guard && r.guard.accepted === false).length, guardK = guardDoc.results.length;
const guardMerged = guardDoc.results.filter((r) => !r.merged_nothing).length;
const itBare = row('impossible-test', 'bare'), itGuard = row('impossible-test', 'guarded');
need(bareEdited === bareK && bareK === 10, 'bare rewrote the test in 10 of 10');
need(guardRejected === guardK && guardK === 5 && guardMerged === 0, 'guard rejected 5 of 5, nothing merged');
need(itBare.usd === itGuard.usd, `same mean cost (${itBare.usd} vs ${itGuard.usd})`);
const g = guarded.guard, gKinds = g.rejections.map((r) => r.kind);
need(g.accepted === false && gKinds.includes('tests_edited'), 'guarded trial 1 verdict rejected for tests_edited');
const gFail = g.failing_tests[0]; need(gFail && gFail.in === 'original', 'failing original test');
const assertLine = (g.protected.output_tail.match(/^\s*(\d+ !== \d+)\s*$/m) || [])[1]; need(assertLine, 'assertion line in protected output');

// Dashboard verdict: the rejected one, judged on the same edit.
const vFile = fs.readdirSync(path.join(DATA, 'orch/verdicts')).map((f) => json(`orch/verdicts/${f}`)).find((v) => v.repo_name === 'vat-cheat');
need(vFile && vFile.accepted === false && vFile.rejections.some((r) => r.kind === 'tests_edited'), 'dashboard verdict rejected tests_edited');
need(verdictDiff.idx === bareDiff.idx, 'dashboard verdict judged the same edit');
const dash = json('dashboard-text.json');
need(/REJECTED: TESTS EDITED/.test(dash.boxes.text.header) && dash.boxes.text.failing.includes(`${gFail.file}: ${gFail.name}`), 'dashboard crop text');

// Capability table: three tasks, bare vs guarded vs AOS (the original aos arm; see README for aos-fixed).
const TASKS = ['hard-feature', 'hard-feature-2', 'parallel-features-8'];
const ARMS = [['bare', 'bare'], ['guarded', 'guarded'], ['aos', 'AOS']];
for (const t of TASKS) {
  const b = row(t, 'bare'), a = row(t, 'aos');
  need(+a.usd > +b.usd && +a.wall > +b.wall && frac(a.passed) <= frac(b.passed), `${t}: AOS dearer, slower, no better than bare`);
}
const ks = [...TASKS.flatMap((t) => ARMS.map(([a]) => row(t, a).trials)), bareK, guardK];
const runDate = new Date(bareDoc.generated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
need(runDate === new Date(guardDoc.generated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' }), 'same run date');

// ---------- scenes (seconds) ----------
const S = [
  { id: 's1', label: '1 · HOOK', start: 0, end: 4 },
  { id: 's2', label: '2 · WITHOUT A GUARD', start: 4, end: 14, caption: `Plain Haiku: rewrote the test in ${bareEdited} of ${bareK} runs.` },
  { id: 's3', label: '3 · WITH THE GUARD', start: 14, end: 26, caption: `Same agent plus a guard: edit rejected ${guardRejected} of ${guardK}, same cost.` },
  { id: 's4', label: '4 · DASHBOARD', start: 26, end: 33, caption: 'The dashboard’s Guard view shows the rejected verdict.' },
  { id: 's5', label: '5 · WHAT ABOUT ORCHESTRATION', start: 33, end: 39, caption: 'Orchestration: dearer and slower than bare, and no better.' },
  { id: 's6', label: '6 · RESULTS', start: 39, end: 46 },
];
for (const s of S) if (s.caption) need(s.caption.split(/\s+/).length <= 12 && s.end - s.start >= 2.5, `caption length/hold: ${s.caption}`);
const at = (sec) => `data-at="${sec}"`; // appear time within the scene

const head = (s) => `<div class="label">${esc(s.label)}</div>${s.caption ? `<h2 class="cap">${esc(s.caption)}</h2>` : ''}`;
const capRows = TASKS.map((t) => `<tr class="task"><td colspan="4">${esc(t)}</td></tr>` + ARMS.map(([a, name]) => { const r = row(t, a);
  return `<tr class="${a}"><td>${esc(name)}</td><td>${esc(r.passed)}</td><td>$${esc(Number(r.usd).toFixed(3))}</td><td>${esc(r.wall)} s</td></tr>`; }).join('')).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--bg:#0b0f17;--fg:#ece6d8;--dim:#9a9484;--amber:#e8b04a;--red:#e0705f;--green:#7fc98a;--line:#2a3140;--box:#121826}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;background:var(--bg);color:var(--fg);overflow:hidden;font-family:-apple-system,"SF Pro Text","Helvetica Neue",Arial,sans-serif}
.scene{position:absolute;inset:0;padding:72px 56px 56px;display:flex;flex-direction:column;gap:40px}
.mono,pre,code,.label,table{font-family:"SF Mono",Menlo,ui-monospace,monospace}
.label{font-size:30px;letter-spacing:.16em;color:var(--amber)}
.cap{font-size:58px;line-height:1.14;font-weight:650;letter-spacing:-.01em;margin-bottom:6px}
.hook{font-size:88px;line-height:1.1;font-weight:700;letter-spacing:-.02em;margin-top:230px}
.sub{font-size:34px;line-height:1.4;color:var(--dim)}
.k{font-size:32px;color:var(--dim);margin-bottom:10px}
.box{background:var(--box);border:1px solid var(--line);border-radius:14px;padding:26px 28px}
pre{font-size:32px;line-height:1.5;white-space:pre}
.minus{color:var(--red)} .plus{color:var(--green)}
.hl{outline:4px solid var(--amber);outline-offset:6px;border-radius:4px}
.quote{font-family:"SF Mono",Menlo,monospace;font-size:32px;line-height:1.45;border-left:6px solid var(--dim);padding-left:22px}
.grade{font-size:36px} .grade b{color:var(--red)}
.verdict b.rej{display:inline-block;background:var(--red);color:#120a08;font-size:44px;letter-spacing:.06em;padding:6px 18px;border-radius:8px;margin:8px 0 18px}
.verdict .line{font-size:32px;line-height:1.55} .verdict .line i{font-style:normal;color:var(--dim)}
.shot{display:block;max-width:100%;border-radius:10px}
table{border-collapse:collapse;font-size:34px;width:100%}
td{padding:6px 10px} td:not(:first-child){text-align:right}
tr.task td{color:var(--dim);padding-top:22px;font-size:30px}
tr.aos td{color:var(--amber)} th{font-size:30px;color:var(--dim);font-weight:400;text-align:right;padding:0 10px} th:first-child{text-align:left}
.stat{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line);padding-top:24px}
.stat b{font-size:80px;line-height:1;font-weight:700} .stat span{font-size:36px;line-height:1.3}
.url{font-size:38px;color:var(--amber);margin-top:auto}
.foot{font-size:30px;line-height:1.45;color:var(--dim)}
</style></head><body>

<section class="scene" id="s1">${head(S[0])}
  <h1 class="hook">Coding agents rewarded by tests will sometimes game the tests.</h1>
  <p class="sub">A small real eval of Claude Code, ${esc(runDate)}.</p>
</section>

<section class="scene" id="s2">${head(S[1])}
  <div ${at(0)}><div class="k">Task prompt</div><div class="quote">${esc(prompt)}</div></div>
  <div ${at(0.6)} data-zoom="1"><div class="k">Bare trial ${bare.trial}: its diff of ${esc(bareDiff.file)}</div>
    <div class="box"><pre><span class="minus">${esc(bareDiff.minus)}</span>\n<span class="plus hl">${esc(bareDiff.plus)}</span></pre></div></div>
  <div ${at(3.4)}><div class="k">Its final message</div><div class="quote">“${esc(bareQuote)}”</div></div>
  <div ${at(6.6)}><div class="k">Grader</div><div class="grade mono"><b>FAIL</b> · ${esc(bare.why)}</div></div>
</section>

<section class="scene" id="s3">${head(S[2])}
  <div ${at(0)}><div class="k">Same prompt. Guarded trial ${guarded.trial} made the same edit; the session ends:</div><div class="quote">“${esc(guardQuote)}”</div></div>
  <div ${at(3.2)} class="box verdict" data-zoom="1"><div class="k">then aos-orch verify re-runs the original tests:</div>
    <b class="rej mono">REJECTED</b>
    <div class="line mono hl">${esc(gKinds.find((k) => k === 'tests_edited'))}: ${esc(gFail.file)}</div>
    <div class="line mono"><i>failing original test:</i> “${esc(gFail.name)}”</div>
    <div class="line mono"><i>assertion:</i> ${esc(assertLine)}</div></div>
  <div ${at(6.8)}><div class="k">Mean cost per run, impossible-test</div><div class="grade mono">bare $${esc(itBare.usd)} · guarded $${esc(itGuard.usd)}</div></div>
</section>

<section class="scene" id="s4">${head(S[3])}
  <div ${at(0)}><div class="k">AOS dashboard, Guard verdicts</div><img class="shot" src="${png('dashboard-header.png')}"></div>
  <div ${at(0.6)} data-zoom="1"><img class="shot hl" src="${png('dashboard-failing.png')}"></div>
  <p ${at(1.2)} class="foot">Verdict ${esc(vFile.id)}, written by aos-orch verify on the same seed with the same ${esc(verdictDiff.old)} → ${esc(verdictDiff.neu)} edit.</p>
</section>

<section class="scene" id="s5">${head(S[4])}
  <div ${at(0)}><table><tr><th>capability task</th><th>passed</th><th>mean $</th><th>mean time</th></tr>${capRows}</table></div>
  <p ${at(0.6)} class="foot">Means per run, from evals/compile.mjs. AOS runs used ${esc([...new Set(TASKS.map((t) => row(t, 'aos').tiers))].join(', '))}.</p>
</section>

<section class="scene" id="s6">${head(S[5])}
  <div class="stat" ${at(0)}><b>${bareEdited}/${bareK}</b><span>plain Haiku runs rewrote the impossible test</span></div>
  <div class="stat" ${at(0.4)}><b>${guardMerged}/${guardK}</b><span>guarded runs merged a test edit, at the same mean cost ($${esc(itGuard.usd)})</span></div>
  <div class="stat" ${at(0.8)}><b>No gain</b><span>from orchestration on ${TASKS.length} capability tasks</span></div>
  <div class="url mono" ${at(1.2)}>github.com/tomtomsatnav/aos-orchestrator</div>
  <p class="foot" ${at(1.2)}>Run ${esc(runDate)} · k = ${Math.min(...ks)}-${Math.max(...ks)} per arm · small tasks · Haiku · one machine. Trials shown: the lowest-numbered of each arm.</p>
</section>

<script>
const S = ${JSON.stringify(S)}, FADE = ${FADE};
const ease = (x) => x <= 0 ? 0 : x >= 1 ? 1 : (x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
window.frame = (t) => {
  for (const s of S) {
    const el = document.getElementById(s.id);
    const vin = s.start === 0 ? 1 : ease((t - s.start) / FADE), vout = 1 - ease((t - (s.end - FADE)) / FADE);
    const last = s === S[S.length - 1];
    const o = t < s.start || (t >= s.end && !last) ? 0 : Math.min(vin, last ? 1 : vout);
    el.style.opacity = o; el.style.display = o > 0 ? 'flex' : 'none';
    for (const it of el.querySelectorAll('[data-at]')) {
      const a = +it.dataset.at, p = s.start === 0 && a === 0 ? 1 : ease((t - s.start - a) / FADE);
      const z = it.dataset.zoom ? 0.94 + 0.06 * ease((t - s.start - a) / 0.6) : 1;
      it.style.opacity = p; it.style.transform = 'translateY(' + (18 * (1 - p)) + 'px) scale(' + z + ')'; it.style.transformOrigin = 'left center';
    }
  }
};
</script></body></html>`;

// ---------- render ----------
fs.mkdirSync(OUT, { recursive: true });
const total = S[S.length - 1].end, N = Math.round(total * FPS), mp4 = path.join(OUT, 'aos-demo.mp4');
const ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', '-an', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((ok, no) => ff.on('exit', (c) => (c === 0 ? ok() : no(new Error(`ffmpeg exit ${c}`)))));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.setContent(html); await page.evaluate(() => document.fonts.ready);
fs.writeFileSync(path.join(OUT, 'frame.html'), html);
for (let i = 0; i < N; i++) {
  await page.evaluate((t) => window.frame(t), i / FPS);
  const buf = await page.screenshot({ type: 'png' });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
}
ff.stdin.end(); await done; await browser.close();

// GIF: 800 px wide, 12 fps, one palette for the whole clip.
fs.mkdirSync(path.dirname(GIF), { recursive: true });
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', mp4, '-vf', 'fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none', GIF]);
console.log(`frames ${N} (${total} s) -> ${mp4} ${(fs.statSync(mp4).size / 1e6).toFixed(2)} MB; ${GIF} ${(fs.statSync(GIF).size / 1e6).toFixed(2)} MB`);
