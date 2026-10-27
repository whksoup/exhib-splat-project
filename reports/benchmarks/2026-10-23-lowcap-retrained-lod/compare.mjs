// Same views, same budgets, every arm: screenshots + load stats. GSL on WebGPU,
// Chrome with a fresh profile per run (cold cache), 1600x900, pixelRatio 1.
// Needs the dev server (cd viewer-v2 && npm run dev) on :5174.
//
//   node compare.mjs <outDir> [arm,arm,...] [view,view,...] [budget,budget,...]
//
// Writes <outDir>/<arm>-<view>-<budget>.png and <outDir>/results.json; sheet.ps1
// stacks the arms per view and budget and measures sharpness.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE ?? 'http://localhost:5174/';
const PORT = 9335;
// No bandwidth emulation: CDP's page-level throttling does not reach GSL's worker fetches
// (1.07 GB arrived in 9 s "at 50 Mbit/s"). Online load time is downloadedMB * 8 / Mbit/s.
const SETTLE_LIMIT_MS = 180_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What each arm loads (the page part of the URL). */
const ARMS = {
  current: 'scene=HighRezOculus', //            A: 4 x 12M, build-lod (what is online)
  'lowcap-rad': 'scene=LowCap', //              B: L0 4M, build-lod (merge LoD)
  retrained: 'config=/models/LowCap/retrained/viewer.json', // C: L0-L3 retrained, SOG
  merged: 'config=/models/LowCap/merged/viewer.json', //       D: L0 + merge-only levels, SOG (control for C)
  l0: 'config=/models/LowCap/l0/viewer.json', //               E: L0 alone, SOG (control for SOG vs RAD)
  downsampled: 'config=/models/LowCap/downsampled/viewer.json', // F: HighRezOculus merged to 4M, SOG (vs E: trained small vs downsampled big)
  mid12m: 'scene=Mid12M', //                                   4 x 3M parts, build-lod (../2026-10-24-mid12m-parts)
  hybrid: 'config=/models/Hybrid/ab/viewer.json', //           A as level 0 + B as level 1, SOG (../2026-10-24-hybrid-lod)
  focus10: 'scene=FocusPilot-W010', //                         6M, focus regions, outside weight 0.1 (../2026-10-25-focus-pilot)
  focus30: 'scene=FocusPilot-W030', //                         6M, focus regions, outside weight 0.3
  'splice-a-in-b': 'config=/models/Splice/a-in-b/viewer.json', //       A in the focus boxes + B outside, one SOG (../2026-10-26-focus-splice)
  'splice-a-in-w010': 'config=/models/Splice/a-in-w010/viewer.json', // A in the focus boxes + W010 outside, one SOG
  'w010-sog': 'config=/models/Splice/w010/viewer.json', //            W010 alone, one SOG (format control for the splices)
  'splice-a-in-b-x1.5': 'config=/models/Splice/a-in-b-x1.5/viewer.json', //       the same with every box grown 1.5x about its centre
  'splice-a-in-w010-x1.5': 'config=/models/Splice/a-in-w010-x1.5/viewer.json',
  'splice-a-in-b-m0.2': 'config=/models/Splice/a-in-b-m0.2/viewer.json', //       every box face pushed out 20 cm
  'splice-a-in-b-x1.5-b1': 'config=/models/Splice/a-in-b-x1.5-b1/viewer.json', // x1.5 plus each one-sided box's backing (A's) behind it
  smoke: 'config=/models/LowCap/smoke/viewer.json', //         HighRezOculus miniatures, packaging test only
};
/** The views of reports/benchmarks/2026-10-23-blur-diagnosis, plus three more around the room. */
const VIEWS = {
  start: 'cam=0,0,0&target=-1.8084,-0.4109,4.8796',
  near: 'cam=-0.24,-0.06,0.65&target=-1.8084,-0.4109,4.8796',
  atrium: 'cam=-0.75,-0.17,2.0&target=-1.8084,-0.4109,4.8796',
  cashier: 'cam=0.6,0,0.6&target=-1.6,-0.3,1.6',
  back: 'cam=-1.8,0,3.6&target=0,-0.2,0',
  floor: 'cam=0,0.3,0&target=-0.9,-1.4,2.5',
  // Close-ups of focus regions (scenes/LowCap focusRegions, camera in front of the box).
  'close-r2': 'cam=2.341,-0.127,4.004&target=2.961,-0.127,3.429',
  'close-r6': 'cam=-0.473,-0.14,9.837&target=-0.776,-0.14,8.322',
  'close-r8': 'cam=-3.289,-0.16,5.915&target=-4.71,-0.16,6.892',
  'close-r10': 'cam=-5.22,-0.247,1.501&target=-4.596,-0.247,2.175',
  'close-r1': 'cam=1.116,-0.213,2.211&target=1.898,-0.213,1.706',
  'close-r3': 'cam=2.142,-0.064,5.024&target=3.673,-0.064,5.176',
  'close-r5': 'cam=0.132,-0.274,6.340&target=1.060,-0.274,7.101',
};
/** Desktop (the published default), iPhone, Android profile budgets. */
const BUDGETS = { '5M': 5_000_000, '1.5M': 1_500_000, '1M': 1_000_000, '10M': 10_000_000, '12M': 12_000_000, '15M': 15_000_000 };

const [outDir, armArg, viewArg, budgetArg] = process.argv.slice(2);
if (!outDir) {
  console.log('usage: node compare.mjs <outDir> [arms] [views] [budgets]');
  process.exit(1);
}
// An arm may also be any packed folder: models/<path> loads /models/<path>/viewer.json.
for (const a of (armArg ?? '').split(',')) if (a.startsWith('models/')) ARMS[a] = `config=/${a}/viewer.json`;
const pick = (arg, all) => (arg ? arg.split(',') : Object.keys(all)).map((k) => {
  if (!(k in all)) throw new Error(`unknown "${k}" (known: ${Object.keys(all).join(', ')})`);
  return k;
});
const arms = pick(armArg, ARMS).filter((a) => armArg || a !== 'smoke');
const views = pick(viewArg, VIEWS);
const budgets = pick(budgetArg, BUDGETS);
fs.mkdirSync(outDir, { recursive: true });

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
  return { send, evaluate, close: () => ws.close() };
}

async function shot(arm, view, budget) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lowcap-cmp-')).replace(/\\/g, '/');
  const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--window-size=1600,900', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' });
  try {
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      await sleep(200);
      try {
        page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
      } catch {}
    }
    if (!page) throw new Error('Chrome did not start');
    const c = await cdp(page.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    // budget x lodScale 1: the same total splat budget for every arm, whatever the device profile.
    const url = `${BASE}?${ARMS[arm]}&${VIEWS[view]}&renderer=gsl&pixelRatio=1&budget=${BUDGETS[budget]}&lodScale=1&overlay=0`;
    const t0 = Date.now();
    await c.send('Page.navigate', { url });
    let status;
    while (Date.now() - t0 < SETTLE_LIMIT_MS) {
      await sleep(1000);
      status = await c.evaluate('window.viewer?.timeline.status').catch(() => null);
      if (status === 'settled' || status === 'error') break;
    }
    await sleep(3000);
    const stats = await c.evaluate(`(() => { const v = window.viewer; return { status: v.timeline.status, settledMs: v.timeline.settledMs,
      firstSplatMs: v.timeline.firstSplatFrameMs, budgetSplats: v.budget, drawn: v.activeSplats, errors: [...v.errors], gsl: v.gsl?.summary() ?? null }; })()`);
    await c.evaluate("document.querySelectorAll('#ui > *').forEach((e) => (e.style.visibility = 'hidden')); 0");
    await sleep(500);
    const img = await c.send('Page.captureScreenshot', { format: 'png' });
    const file = `${arm.replace(/\//g, '_')}-${view}-${budget}.png`;
    fs.writeFileSync(path.join(outDir, file), Buffer.from(img.result.data, 'base64'));
    c.close();
    return { arm, view, budget, url, file, ...stats };
  } finally {
    chrome.kill();
    await sleep(2000);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}

const results = [];
for (const view of views) {
  for (const budget of budgets) {
    for (const arm of arms) {
      try {
        const r = await shot(arm, view, budget);
        results.push(r);
        const g = r.gsl;
        console.log(`${arm.padEnd(10)} ${view.padEnd(8)} ${budget.padEnd(5)} ${String(r.status).padEnd(8)} settled ${r.settledMs ? (r.settledMs / 1000).toFixed(1) : '-'} s  drawn ${(r.drawn / 1e6).toFixed(2)}M  downloaded ${g?.downloadedMB ?? '-'} MB  GPU ${g?.residentGpuMB ?? '-'} MB${r.errors.length ? `  ERRORS ${r.errors.join('; ')}` : ''}`);
      } catch (err) {
        console.log(`${arm} ${view} ${budget}: FAILED ${err.message}`);
        results.push({ arm, view, budget, error: String(err.message) });
      }
      fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 1));
    }
  }
}
