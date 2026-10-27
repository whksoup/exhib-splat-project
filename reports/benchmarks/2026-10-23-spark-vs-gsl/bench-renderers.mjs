// Spark vs GSL benchmark on a scene: fresh Chrome profile per run (cold cache),
// background throttling and vsync off, driven over the DevTools protocol.
// Per run: time to first splat / LoD settled, process RAM + GPU memory after
// settling, then the viewer's own 20 s orbit benchmark (window.bench).
//   node bench-renderers.mjs <outFile.json> [scene]
// RUNS (JSON env) replaces the run list; a run's "page" replaces scene=<scene>
// (e.g. "config=/models/LowCap/l0/viewer.json").
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = process.argv[2];
const SCENE = process.argv[3] ?? "HighRezOculus";
const BASE = process.env.BASE ?? "http://localhost:5174/";
const VIEW = "cam=0,1.6,4&target=0,1.2,0&pixelRatio=1";
const RUNS = process.env.RUNS ? JSON.parse(process.env.RUNS) : [
  { name: "spark 5M", q: "" },
  { name: "gsl 5M (WebGPU)", q: "&renderer=gsl" },
  { name: "gsl 5M (WebGL2 backend)", q: "&renderer=gsl-webgl" },
  { name: "spark 10M", q: "&lodScale=4" },
  { name: "gsl 10M (WebGPU)", q: "&renderer=gsl&lodScale=4" },
];
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function memoryOf(profileDir) {
  const ps = `
$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(profileDir)}*' }
$ids = @($procs | ForEach-Object { $_.ProcessId })
$ws = 0; $priv = 0
foreach ($p in $procs) { $ws += $p.WorkingSetSize; $priv += $p.PrivatePageCount }
$gpu = 0
try {
  $c = Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction Stop
  foreach ($s in $c.CounterSamples) { if ($s.InstanceName -match 'pid_(\\d+)_') { if ($ids -contains [int]$Matches[1]) { $gpu += $s.CookedValue } } }
} catch {}
"{0} {1} {2}" -f $ws, $priv, $gpu`;
  const [ws, priv, gpu] = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
  return { workingSetMB: Math.round(ws / 1e6), privateMB: Math.round(priv / 1e6), gpuDedicatedMB: Math.round(gpu / 1e6) };
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

async function run({ name, q, page: pageQuery, freezeShare, shot, js }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "splat-bench-")).replace(/\\/g, "/");
  const chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      "--window-size=1600,900",
      "--window-position=40,40",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-gpu-vsync",
      "--disable-frame-rate-limit",
      "--enable-precise-memory-info",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      await sleep(200);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((t) => t.type === "page");
      } catch {}
    }
    if (!page) throw new Error("Chrome did not start");
    const c = await cdp(page.webSocketDebuggerUrl);
    await c.send("Runtime.enable");
    await c.send("Page.bringToFront");
    await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const url = `${BASE}?${pageQuery ?? `scene=${SCENE}`}&${VIEW}${q}`;
    const t0 = Date.now();
    await c.send("Page.navigate", { url });
    // Trace: once a second, how long the page took to answer (main-thread stalls) and frames rendered since.
    const trace = [];
    let tracing = true;
    const tracer = (async () => {
      while (tracing) {
        const s = Date.now();
        const v = await c
          .evaluate("window.viewer ? [window.viewer.frames.live().frames, window.viewer.activeSplats, performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null, window.viewer.timeline.status] : null")
          .catch(() => null);
        trace.push({ t: s - t0, answerMs: Date.now() - s, v });
        await sleep(1000);
      }
    })();
    let status = null;
    while (Date.now() - t0 < 240_000) {
      await sleep(500);
      status = trace.at(-1)?.v?.[3] ?? null;
      if (status === "settled" || status === "error") break;
    }
    const load = await c.evaluate(`(() => { const v = window.viewer; const t = v.timeline; const n = v.network.get();
      return { status: t.status, modelRequestMs: t.modelRequestMs, firstSplatFrameMs: t.firstSplatFrameMs, settledMs: t.settledMs,
        activeSplats: v.activeSplats, budget: v.budget, networkMB: +(n.bodyBytes / 1e6).toFixed(1), requests: n.requests,
        errors: [...v.errors], gpu: v.gpuInfo(), parts: v.models.map((m) => [m.id, v.modelSplats(m)]) }; })()`);
    await sleep(3000);
    if (js) {
      await c.evaluate(js);
      await sleep(1500);
    }
    if (shot) {
      await c.evaluate("document.querySelector('.overlay') && (document.querySelector('.overlay').hidden = true); 0");
      const img = await c.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(path.dirname(OUT), shot), Buffer.from(img.result.data, "base64"));
    }
    if (freezeShare) await c.evaluate("window.viewer.gsl.lastShareAt = Infinity; 0");
    const memSettled = memoryOf(profile);
    const bench = await c.evaluate("window.bench({ seconds: 20 })", true);
    const memAfter = memoryOf(profile);
    tracing = false;
    await tracer;
    c.close();
    const stalls = trace.filter((x) => x.answerMs > 1000).map((x) => [x.t, x.answerMs]);
    const r = { name, url, load, memSettled, memAfter, bench, stalls, trace };
    console.log(
      JSON.stringify({ name, status: load.status, settledS: load.settledMs && +(load.settledMs / 1000).toFixed(1), fps: bench.frames.avgFps, maxFrameMs: bench.frames.maxFrameMs, gpuMs: bench.gpuMs?.median, memAfter, stalls }),
    );
    return r;
  } finally {
    chrome.kill();
    await sleep(2000);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}

const results = [];
for (const r of RUNS) {
  try {
    results.push(await run(r));
  } catch (err) {
    console.log(`${r.name}: FAILED ${err.message}`);
    results.push({ name: r.name, error: String(err.message) });
  }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
}
