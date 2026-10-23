/**
 * Scripted orbit benchmark: circles the camera around the current look-at
 * point at constant radius and height, so runs with different URL knobs
 * (?pixelRatio=, ?budget=, ?lodRenderScale=...) are comparable. Hand-driven
 * mouse orbits aren't: their speed and path differ every time.
 *
 * Started from the overlay (Orbit bench / K), ?bench=<seconds> (runs once
 * after LoD first settles), or the console: window.bench({ seconds: 10 }).
 */
import * as THREE from "three";
import { dist, type Dist, type SparkStatsSummary } from "./diagnostics";
import type { GslStatsSummary } from "./gsl";
import { summarize, type FrameSummary } from "./metrics";
import { memorySnapshot } from "./results";
import type { Viewer } from "./viewer";

export interface BenchOptions {
  seconds?: number;
  turns?: number;
}

export interface BenchResult {
  kind: "orbit";
  renderer: Viewer["rendererKind"];
  startedAtMs: number;
  seconds: number;
  turns: number;
  target: [number, number, number];
  radius: number;
  height: number;
  pixelRatio: number;
  drawingBuffer: [number, number];
  budget: number;
  frames: FrameSummary;
  gpuMs: Dist | null;
  /** Spark path only. */
  spark: SparkStatsSummary | null;
  /** GSL path only. */
  gsl: GslStatsSummary | null;
  memory: ReturnType<typeof memorySnapshot>;
  activeSplats: { min: number; avg: number; max: number };
  hitches: number;
  worstHitchMs: number | null;
}

/** Camera position `k` (0..1) of the way through an orbit that starts at `angle0`. Pure, unit tested. */
export function orbitPosition(
  target: THREE.Vector3,
  radius: number,
  height: number,
  angle0: number,
  turns: number,
  k: number,
): THREE.Vector3 {
  const a = angle0 + k * turns * 2 * Math.PI;
  return new THREE.Vector3(target.x + radius * Math.cos(a), target.y + height, target.z + radius * Math.sin(a));
}

let running: Promise<BenchResult> | null = null;

export function benchRunning(): boolean {
  return running !== null;
}

export function runOrbitBenchmark(viewer: Viewer, opts: BenchOptions = {}): Promise<BenchResult> {
  if (running) return running;
  const seconds = Math.max(1, opts.seconds ?? 10);
  const turns = opts.turns ?? 1;
  const { camera, rig } = viewer;
  const target = rig.getTarget();
  const startPos = camera.position.clone();
  const off = startPos.clone().sub(target);
  const radius = Math.max(0.5, Math.hypot(off.x, off.z));
  const angle0 = Math.atan2(off.z, off.x);

  running = new Promise<BenchResult>((resolve) => {
    const dts: number[] = [];
    let splatMin = Infinity;
    let splatMax = 0;
    let splatSum = 0;
    let t0: number | null = null;
    const hitchesBefore = viewer.hitches.total;

    const finish = (now: number) => {
      viewer.onFrame.splice(viewer.onFrame.indexOf(hook), 1);
      rig.setPose(startPos, target);
      rig.setSuspended(false);
      const windowMs = now - (t0 as number);
      const since = t0 as number;
      const hitches = viewer.hitches.entries.filter((h) => h.atMs >= since);
      const size = viewer.renderer.getDrawingBufferSize(new THREE.Vector2());
      const result: BenchResult = {
        kind: "orbit",
        renderer: viewer.rendererKind,
        startedAtMs: since,
        seconds,
        turns,
        target: target.toArray() as [number, number, number],
        radius,
        height: off.y,
        pixelRatio: viewer.renderer.getPixelRatio(),
        drawingBuffer: [size.x, size.y],
        budget: viewer.budget,
        frames: summarize(dts),
        gpuMs: dist(viewer.gpu.samples.since(since)),
        spark: viewer.sparkStats?.summary(windowMs, now) ?? null,
        gsl: viewer.gsl?.summary(windowMs, now) ?? null,
        memory: memorySnapshot(viewer),
        activeSplats: { min: dts.length ? splatMin : 0, avg: dts.length ? Math.round(splatSum / dts.length) : 0, max: splatMax },
        hitches: viewer.hitches.total - hitchesBefore,
        worstHitchMs: hitches.length ? Math.max(...hitches.map((h) => h.frameMs)) : null,
      };
      viewer.lastBenchmark = result;
      running = null;
      resolve(result);
    };

    // Runs after rig.update(), so it overrides orbit / fly / walk for the frame.
    const hook = ({ dtMs, now }: { dtMs: number; now: number }) => {
      if (t0 === null) t0 = now;
      else {
        dts.push(dtMs);
        const n = viewer.activeSplats;
        splatMin = Math.min(splatMin, n);
        splatMax = Math.max(splatMax, n);
        splatSum += n;
      }
      const k = (now - t0) / (seconds * 1000);
      if (k >= 1) return finish(now);
      rig.setPose(orbitPosition(target, radius, off.y, angle0, turns, k), target);
      camera.updateMatrixWorld();
    };
    rig.setSuspended(true);
    viewer.onFrame.push(hook);
  });
  return running;
}

/** One-line summary for the overlay / toast. */
export function formatBench(r: BenchResult): string {
  const f = (d: Dist | null, digits = 1) => (d ? `${d.median.toFixed(digits)}` : "—");
  const lod = r.spark
    ? `traverse ${f(r.spark.traverseMs, 0)} ms @ ${r.spark.lodUpdatesPerS.toFixed(1)}/s`
    : `lod ${f(r.gsl?.lodTimeMs ?? null, 0)} ms`;
  return `${r.frames.avgFps.toFixed(1)} fps, 1% low ${r.frames.onePctLowFps.toFixed(1)}, gpu ${f(r.gpuMs, 2)} ms, ${lod}, hitches ${r.hitches}`;
}
