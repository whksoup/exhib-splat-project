// Budget A/B screenshots: same view, different splat budgets, GSL on WebGPU, 1600x900, pixelRatio 1.
//   node shots.mjs <outDir>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = process.argv[2];
const BASE = process.env.BASE ?? "http://localhost:5174/";
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const VIEWS = {
  start: "cam=0,0,0&target=-1.8084,-0.4109,4.8796",
  close: "cam=-0.75,-0.17,2.0&target=-1.8084,-0.4109,4.8796",
  near: "cam=-0.24,-0.06,0.65&target=-1.8084,-0.4109,4.8796",
};
const RUNS = JSON.parse(process.env.RUNS ?? "null") ?? [
  { view: "start", tag: "5M", q: "&renderer=gsl" },
  { view: "start", tag: "40M", q: "&renderer=gsl&lodScale=16" },
  { view: "close", tag: "5M", q: "&renderer=gsl" },
  { view: "close", tag: "40M", q: "&renderer=gsl&lodScale=16" },
  { view: "start", tag: "1.5M-phone", q: "&renderer=gsl&budget=1500000&lodScale=1" },
];

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression, awaitPromise = false) => (await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true })).result?.result?.value;
  return { send, evaluate, close: () => ws.close() };
}

async function run({ view, tag, q }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "splat-shot-")).replace(/\\/g, "/");
  const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--window-size=1600,900", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank"], { stdio: "ignore" });
  try {
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      await sleep(200);
      try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
    }
    const c = await cdp(page.webSocketDebuggerUrl);
    await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    const url = `${BASE}?scene=HighRezOculus&${VIEWS[view]}${q.includes("pixelRatio") ? "" : "&pixelRatio=1"}${q}`;
    const t0 = Date.now();
    await c.send("Page.navigate", { url });
    let status;
    while (Date.now() - t0 < 180_000) {
      await sleep(1000);
      status = await c.evaluate("window.viewer?.timeline.status").catch(() => null);
      if (status === "settled" || status === "error") break;
    }
    await sleep(4000);
    const stats = await c.evaluate(`(() => { const v = window.viewer; return { status: v.timeline.status, settledMs: v.timeline.settledMs, budget: v.budget, active: v.activeSplats,
      parts: v.models.map((m) => [m.id, v.modelSplats(m), m.stream?.splatBudget ?? null]), gsl: v.gsl?.summary() ?? null }; })()`);
    await c.evaluate("document.querySelectorAll('.overlay,.topbar,#ui > *').forEach((e) => (e.style.visibility = 'hidden')); 0");
    await sleep(500);
    const img = await c.send("Page.captureScreenshot", { format: "png" });
    const file = `${view}-${tag}.png`;
    fs.writeFileSync(path.join(OUT, file), Buffer.from(img.result.data, "base64"));
    c.close();
    const r = { view, tag, url, file, secs: (Date.now() - t0) / 1000, ...stats };
    console.log(JSON.stringify(r));
    return r;
  } finally {
    chrome.kill();
    await sleep(2000);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

const results = [];
for (const r of RUNS) {
  try { results.push(await run(r)); } catch (e) { console.log(r.view, r.tag, "FAILED", e.message); }
  fs.writeFileSync(path.join(OUT, "runs.json"), JSON.stringify(results, null, 1));
}
