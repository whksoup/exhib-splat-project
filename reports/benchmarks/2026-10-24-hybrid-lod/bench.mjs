// Frame cost of the candidates for online: the hybrid (A + B, streamed SOG LoD), Mid12M as
// streamed RAD (build-lod) and Mid12M as one SOG level (loaded once, nothing streams).
// Same orbit benchmark as ../2026-10-23-streaming-vs-count (bench-renderers.mjs: fresh profile,
// vsync off, 1600x900, pixel ratio 1, 20 s window.bench orbit). Budgets: 5M (desktop default),
// 2M (mid-range proxy), 1M (phone proxy). Needs the dev server on :5174 and a free GPU.
//
//   node reports/benchmarks/2026-10-24-hybrid-lod/bench.mjs <outFile.json> [repeats]
import { spawnSync } from "node:child_process";
import path from "node:path";

const [out, repeats = "1"] = process.argv.slice(2);
if (!out) {
  console.log("usage: node bench.mjs <outFile.json> [repeats]");
  process.exit(1);
}
const gsl = (budget) => `&renderer=gsl&budget=${budget}&lodScale=1`;
const hybrid = "config=/models/Hybrid/ab/viewer.json";
const mid12mSog = "config=/models/Mid12M/sog/viewer.json";
const ARMS = [
  { name: "hybrid 5M", page: hybrid, q: gsl(5_000_000) },
  { name: "hybrid 2M", page: hybrid, q: gsl(2_000_000) },
  { name: "hybrid 1M", page: hybrid, q: gsl(1_000_000) },
  { name: "Mid12M RAD 5M", page: "scene=Mid12M", q: gsl(5_000_000) },
  { name: "Mid12M RAD 2M", page: "scene=Mid12M", q: gsl(2_000_000) },
  { name: "Mid12M RAD 1M", page: "scene=Mid12M", q: gsl(1_000_000) },
  // One level: the budget can't lower detail, so give it room for every splat in view.
  { name: "Mid12M single SOG", page: mid12mSog, q: gsl(10_000_000) },
];
const runs = Array.from({ length: Number(repeats) }, (_, i) => ARMS.map((a) => ({ ...a, name: `${a.name} #${i + 1}` }))).flat();
const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "../2026-10-23-spark-vs-gsl/bench-renderers.mjs"), path.resolve(out)], {
  stdio: "inherit",
  env: { ...process.env, RUNS: JSON.stringify(runs) },
});
process.exit(r.status ?? 1);
