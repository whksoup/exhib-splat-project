/**
 * Gaussian Splat Lite backend (?renderer=gsl), the alternative to Spark.
 *
 * GSL reads the same RAD v1 files Spark's build-lod writes (header .rad plus
 * .radc pages), so scenes stream from their existing builds unchanged. It
 * renders through three's WebGPURenderer: native WebGPU sorts splats on the GPU
 * every frame; ?renderer=gsl-webgl forces that renderer's WebGL2 backend.
 *
 * Each streamed part is its own RadStreamScheduler with its own splat budget
 * (GSL has no budget shared across schedulers), so the viewer's total budget
 * is re-split between parts a few times a second by how much of the screen
 * each part's bounds cover. One GaussianSplatRenderer sorts every part
 * together, so there are no seams between parts.
 *
 * Not supported on this path yet: Align and Plan modes (they read Spark's
 * splat buffers, dyno modifiers and WebGL render targets), and in-browser LoD
 * for plain files (they load whole).
 */
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { GaussianSplatRenderer, RadStreamScheduler, SplatMesh as GslSplatMesh, type RadStreamStats } from "gaussian-splat-lite";
import type { GslOptions } from "./config";
import { dist, SampleRing, type Dist } from "./diagnostics";

/** Bytes per resident splat at SH3 (measured on HighRezOculus: ~480 CPU, ~415 GPU), rounded up. */
const BYTES_PER_SPLAT = 512;
const GIB = 1024 ** 3;
/** How often part budgets are re-split. Each new budget requests a new LoD selection. */
const SHARE_INTERVAL_MS = 250;
/** Budget changes smaller than this fraction are not applied (they would only churn selections). */
const SHARE_HYSTERESIS = 0.05;
/**
 * How long unused detail stays cached (GSL's own default is 2000). On HighRezOculus
 * 10 s cut orbit hitches by a quarter to a third and re-downloads by ~0.4 GB, for
 * ~0.5 GB more GPU memory (reports/benchmarks/2026-10-23-spark-vs-gsl).
 */
export const DEFAULT_COOLDOWN_MS = 10_000;
/** With the camera still: re-splits made once the streams are idle, and the longest time to keep re-splitting. */
const IDLE_SHARES = 4;
const MAX_STILL_SHARE_MS = 8000;

export async function createGslRenderer(forceWebGL: boolean): Promise<WebGPURenderer> {
  // GSL docs: antialias off; MSAA slows splats down without improving them.
  const renderer = new WebGPURenderer({ antialias: false, powerPreference: "high-performance", forceWebGL, trackTimestamp: true });
  await renderer.init();
  return renderer;
}

/**
 * Split `total` between parts by weight, each visible part getting at least
 * `minShare` of it. Hidden parts get 1 splat (GSL budgets must be positive).
 * Pure; unit tested.
 */
export function shareBudget(total: number, parts: { weight: number; visible: boolean }[], minShare = 0.05): number[] {
  const shown = parts.filter((p) => p.visible);
  if (shown.length === 0) return parts.map(() => 1);
  const floor = Math.min(minShare, 1 / shown.length);
  const sum = shown.reduce((s, p) => s + Math.max(0, p.weight), 0);
  const free = 1 - floor * shown.length;
  return parts.map((p) => {
    if (!p.visible) return 1;
    const w = sum > 0 ? Math.max(0, p.weight) / sum : 1 / shown.length;
    return Math.max(1, Math.round(total * (floor + free * w)));
  });
}

/** A part draws at least this share of its budget: it is budget-limited and would use more. */
const SATURATED = 0.9;
/** Headroom over current use for parts that are not budget-limited. */
const DEMAND_HEADROOM = 1.25;

/**
 * Split `total` by demand: a part that draws well under its budget (its
 * detail stopped at the 1-pixel limit, or it is mostly off-screen) keeps its
 * current use plus headroom, and the rest goes to the budget-limited parts by
 * weight. Falls back to shareBudget when the parts that aren't limited already
 * need the whole total, or none is limited. Pure; unit tested.
 */
export function shareBudgetByDemand(
  total: number,
  parts: { weight: number; visible: boolean; budget: number; used: number }[],
  minShare = 0.05,
): number[] {
  const shown = parts.filter((p) => p.visible);
  if (shown.length === 0) return parts.map(() => 1);
  const floor = Math.round(total * Math.min(minShare, 1 / shown.length));
  const limited = (p: (typeof parts)[number]) => p.used >= SATURATED * p.budget;
  const want = (p: (typeof parts)[number]) => Math.max(floor, Math.ceil(p.used * DEMAND_HEADROOM));
  const hungry = shown.filter(limited);
  const spare = total - shown.filter((p) => !limited(p)).reduce((s, p) => s + want(p), 0);
  if (hungry.length === 0 || spare < floor * hungry.length) return shareBudget(total, parts, minShare);
  const hungryShare = shareBudget(spare, hungry, minShare);
  return parts.map((p) => {
    if (!p.visible) return 1;
    const i = hungry.indexOf(p);
    return i >= 0 ? hungryShare[i] : want(p);
  });
}

const corner = new THREE.Vector3();

/**
 * Fraction of the screen covered by a world-space box (its projected rectangle,
 * clipped to the viewport): 1 when the camera is inside it or it straddles the
 * camera plane, 0 when it is off-screen or empty.
 */
export function screenCoverage(box: THREE.Box3, camera: THREE.Camera): number {
  if (box.isEmpty()) return 0;
  const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  if (box.containsPoint(camPos)) return 1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    corner.applyMatrix4(camera.matrixWorldInverse);
    if (corner.z >= 0) return 1; // a corner behind the camera: the box surrounds the view direction
    corner.applyMatrix4(camera.projectionMatrix);
    minX = Math.min(minX, corner.x);
    maxX = Math.max(maxX, corner.x);
    minY = Math.min(minY, corner.y);
    maxY = Math.max(maxY, corner.y);
  }
  const w = Math.min(1, maxX) - Math.max(-1, minX);
  const h = Math.min(1, maxY) - Math.max(-1, minY);
  return w > 0 && h > 0 ? (w * h) / 4 : 0;
}

export interface GslStatsSummary {
  visibleSplats: number;
  residentCpuMB: number;
  residentGpuMB: number;
  downloadedMB: number;
  loadingChunks: number;
  /** Lowest per-part loadProgress (0..1). */
  loadProgress: number;
  peakWasmMB: number;
  /** Per-part LoD selection time, last 5 s. */
  lodTimeMs: Dist | null;
}

/** The GSL renderer plus every streamed part; the Viewer owns one in GSL mode. */
export class GslSplats {
  readonly splatRenderer: GaussianSplatRenderer;
  readonly streams: RadStreamScheduler[] = [];
  /** Total splat budget, re-split between visible streamed parts. */
  budget: number;
  private readonly lodTime = new SampleRing();
  private readonly lastLodTime = new WeakMap<RadStreamScheduler, number>();
  private lastShareAt = -Infinity;
  private lastShareView = "";
  private stillSince = 0;
  private idleShares = 0;

  constructor(
    readonly renderer: WebGPURenderer,
    scene: THREE.Scene,
    budget: number,
    private readonly opts: GslOptions & { maxStdDev?: number } = {},
  ) {
    this.budget = budget;
    this.splatRenderer = new GaussianSplatRenderer({
      renderer,
      ...(opts.maxStdDev !== undefined && { maxStdDev: opts.maxStdDev }),
    });
    scene.add(this.splatRenderer);
  }

  /**
   * Stream a RAD file. Memory caps are per part: ?gslMemMB=, else sized so one
   * part could hold the whole budget. The caps also bound how many pages GSL
   * keeps, so a tight cap evicts pages that are then downloaded again.
   */
  addStream(url: string, camera: THREE.Camera, onError: (message: string) => void): RadStreamScheduler {
    const o = this.opts;
    const cap = o.memMB ? o.memMB * 1e6 : Math.max(GIB, Math.round(this.budget * BYTES_PER_SPLAT));
    const stream = new RadStreamScheduler({
      url,
      // .radc pages keep their names across rebuilds: give them the header's ?v= (build time)
      // so a browser never mixes a new header with pages cached from the previous build.
      resolveFile: (filename) => {
        const u = new URL(filename, new URL(url, location.href));
        u.search = new URL(url, location.href).search;
        return u.href;
      },
      splatBudget: Math.max(1, Math.round(this.budget / (this.streams.length + 1))),
      maxResidentCpuBytes: cap,
      maxResidentGpuBytes: cap,
      cooldownMs: o.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      ...(o.maxConcurrentLoads !== undefined && { maxConcurrentLoads: o.maxConcurrentLoads }),
      ...(o.fadeDurationMs !== undefined && { fadeDurationMs: o.fadeDurationMs }),
      onError: (err, from) => onError(`${from ?? url}: ${err instanceof Error ? err.message : String(err)}`),
    });
    stream.setCamera(camera);
    stream.setResolutionFromRenderer(camera, this.renderer);
    this.streams.push(stream);
    this.lastShareAt = -Infinity;
    return stream;
  }

  /** A plain (.ply / .spz / .sog) file, loaded whole. */
  addMesh(url: string): GslSplatMesh {
    return new GslSplatMesh({ url });
  }

  removeStream(stream: RadStreamScheduler): void {
    const i = this.streams.indexOf(stream);
    if (i >= 0) this.streams.splice(i, 1);
    stream.dispose();
    stream.group.removeFromParent();
    this.lastShareAt = -Infinity;
  }

  gpuInfo(): string {
    return webGpuInfo(this.renderer);
  }

  resize(camera: THREE.Camera): void {
    for (const s of this.streams) s.setResolutionFromRenderer(camera, this.renderer);
  }

  /**
   * Call every frame before rendering: re-split the budget when due, then advance every stream.
   * The split follows demand, and demand follows the split, so it only keeps
   * adjusting while the view changes: once the camera is still it gets a few
   * passes after the streams go idle (MAX_STILL_SHARE_MS at most), then holds,
   * so loading can settle.
   */
  update(camera: THREE.Camera, now: number): void {
    if (now - this.lastShareAt >= SHARE_INTERVAL_MS) {
      this.lastShareAt = now;
      const view = this.viewKey(camera);
      if (view !== this.lastShareView) {
        this.lastShareView = view;
        this.stillSince = now;
        this.idleShares = 0;
      }
      if (now - this.stillSince < MAX_STILL_SHARE_MS && this.idleShares < IDLE_SHARES) {
        this.shareBudget(camera);
        if (this.isIdle()) this.idleShares++;
      }
    }
    for (const s of this.streams) {
      s.update();
      // stats.lodTimeMs is the last selection's time: record it once per new selection.
      const lod = s.stats.lodTimeMs;
      if (lod > 0 && lod !== this.lastLodTime.get(s)) {
        this.lastLodTime.set(s, lod);
        this.lodTime.push(now, lod);
      }
    }
  }

  /** What the split depends on besides demand: camera pose, projection, part visibility and the total. */
  private viewKey(camera: THREE.Camera): string {
    const pose = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements].map((v) => v.toFixed(4)).join(",");
    return `${pose}|${this.streams.map((s) => (isShown(s.group) ? 1 : 0)).join("")}|${this.budget}`;
  }

  private shareBudget(camera: THREE.Camera): void {
    const box = new THREE.Box3();
    const parts = this.streams.map((s) => {
      const visible = isShown(s.group);
      const part = { weight: 0, visible, budget: s.splatBudget, used: s.stats.visibleSplats };
      if (!visible) return part;
      box.copy(s.getBoundingBox()).applyMatrix4(s.group.matrixWorld);
      part.weight = screenCoverage(box, camera);
      return part;
    });
    const budgets = this.opts.share === "coverage" ? shareBudget(this.budget, parts) : shareBudgetByDemand(this.budget, parts);
    this.streams.forEach((s, i) => {
      const b = budgets[i];
      if (Math.abs(b - s.splatBudget) > SHARE_HYSTERESIS * Math.max(b, s.splatBudget)) s.splatBudget = b;
    });
  }

  /** Splats on screen across every streamed part. */
  get visibleSplats(): number {
    let n = 0;
    for (const s of this.streams) if (isShown(s.group)) n += s.stats.visibleSplats;
    return n;
  }

  /** True when no stream has pages loading or waiting and every view's detail is ready. */
  isIdle(): boolean {
    return this.streams.every((s) => {
      const st = s.stats;
      return st.loadingChunks === 0 && st.pendingBytes === 0 && st.loadProgress >= 1;
    });
  }

  isFetching(): boolean {
    return this.streams.some((s) => s.stats.loadingChunks > 0);
  }

  summary(windowMs = 5000, now = performance.now()): GslStatsSummary {
    const all: RadStreamStats[] = this.streams.map((s) => s.stats);
    const mb = (f: (s: RadStreamStats) => number) => Number((all.reduce((n, s) => n + f(s), 0) / 1e6).toFixed(1));
    return {
      visibleSplats: this.visibleSplats,
      residentCpuMB: mb((s) => s.residentCpuBytes),
      residentGpuMB: mb((s) => s.residentGpuBytes),
      downloadedMB: mb((s) => s.downloadedBytes),
      loadingChunks: all.reduce((n, s) => n + s.loadingChunks, 0),
      loadProgress: all.length ? Math.min(...all.map((s) => s.loadProgress)) : 1,
      peakWasmMB: mb((s) => s.peakWasmMemoryBytes),
      lodTimeMs: dist(this.lodTime.since(now - windowMs)),
    };
  }
}

function isShown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/**
 * GPU time per frame from WebGPURenderer timestamp queries (render + compute,
 * which includes GSL's GPU sort). Resolved asynchronously; a resolve that
 * covers several frames records their average. Same surface as GpuTimer.
 */
export class WebGpuFrameTimer {
  readonly samples = new SampleRing(2048);
  readonly supported: boolean;
  private frames = 0;
  private lastAt = 0;
  private resolving = false;

  constructor(private readonly renderer: WebGPURenderer) {
    this.supported = (renderer.backend as unknown as { trackTimestamp?: boolean }).trackTimestamp === true;
  }

  begin(): void {}

  end(at: number): void {
    if (!this.supported) return;
    this.frames++;
    this.lastAt = at;
  }

  poll(): void {
    if (!this.supported || this.resolving || this.frames === 0) return;
    this.resolving = true;
    const frames = this.frames;
    const at = this.lastAt;
    this.frames = 0;
    Promise.all([this.renderer.resolveTimestampsAsync("render"), this.renderer.resolveTimestampsAsync("compute")])
      .then(([render, compute]) => {
        const ms = (render ?? 0) + (compute ?? 0);
        if (ms > 0) this.samples.push(at, ms / frames);
      })
      .catch(() => {})
      .finally(() => (this.resolving = false));
  }

  summary(windowMs = 5000, now = performance.now()): Dist | null {
    return dist(this.samples.since(now - windowMs));
  }
}

/** GPU adapter description for results (WebGPU adapter info, or the WebGL renderer string). */
export function webGpuInfo(renderer: WebGPURenderer): string {
  const backend = renderer.backend as unknown as {
    isWebGPUBackend?: boolean;
    device?: { adapterInfo?: { vendor?: string; architecture?: string; description?: string } };
    gl?: WebGL2RenderingContext;
  };
  if (backend.gl) {
    const ext = backend.gl.getExtension("WEBGL_debug_renderer_info");
    return `WebGL2 backend: ${String(backend.gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : backend.gl.RENDERER))}`;
  }
  const info = backend.device?.adapterInfo;
  return info ? `WebGPU: ${[info.vendor, info.architecture, info.description].filter(Boolean).join(" ")}` : "WebGPU";
}
