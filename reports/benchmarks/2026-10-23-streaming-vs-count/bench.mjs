// Is the chug splat count or LoD streaming? The current build (RAD, streamed LoD)
// against single-file SOGs that load once and never stream, through the same
// orbit benchmark as ../2026-10-23-spark-vs-gsl (bench-renderers.mjs: fresh
// profile, vsync off, 1600x900, pixel ratio 1, 20 s window.bench orbit).
// Needs the dev server on :5174 and a free GPU (close Spirula, no training).
//
//   node reports/benchmarks/2026-10-23-streaming-vs-count/bench.mjs <outFile.json> [repeats]
//
// Single-file arms: ../2026-10-23-lowcap-retrained-lod/run.mjs "downsample 10000000" +
// "pack downsampled-10000k" (10M); "downsample" + "pack downsampled" (4M).
import { spawnSync } from "node:child_process";
import path from "node:path";

const [out, repeats = "2"] = process.argv.slice(2);
if (!out) {
  console.log("usage: node bench.mjs <outFile.json> [repeats]");
  process.exit(1);
}
const gsl = (budget) => `&renderer=gsl&budget=${budget}&lodScale=1`;
const ARMS = [
  { name: "A streamed 5M", q: gsl(5_000_000) },
  { name: "A streamed 10M", q: gsl(10_000_000) },
  // Nothing is released during the orbit, so nothing is re-downloaded: what streaming costs without churn.
  { name: "A streamed 10M, no release", q: `${gsl(10_000_000)}&gslCooldown=600000` },
  { name: "single SOG 4M", page: "config=/models/LowCap/downsampled/viewer.json", q: gsl(10_000_000) },
  { name: "single SOG 10M", page: "config=/models/LowCap/downsampled-10000k/viewer.json", q: gsl(10_000_000) },
];
const runs = Array.from({ length: Number(repeats) }, (_, i) => ARMS.map((a) => ({ ...a, name: `${a.name} #${i + 1}` }))).flat();
const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "../2026-10-23-spark-vs-gsl/bench-renderers.mjs"), path.resolve(out)], {
  stdio: "inherit",
  env: { ...process.env, RUNS: JSON.stringify(runs) },
});
process.exit(r.status ?? 1);
