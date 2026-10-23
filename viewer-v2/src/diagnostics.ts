/**
 * Performance diagnostics beyond frame timing (see metrics.ts):
 *  - SparkStats: LoD traversal / sort / depth-readback timings, LoD update and
 *    sort rates, pager state and page-upload cost, read from Spark internals.
 *  - GpuTimer: GPU time of each renderer.render() (EXT_disjoint_timer_query_webgl2),
 *    so headroom is visible even when FPS is pinned at vsync.
 *  - HitchLog: frames much slower than typical, with what Spark was doing.
 *
 * Spark 2.3.1 exposes no timing API, so SparkStats wraps a few private
 * SparkRenderer / SplatPager methods on the instance (not the prototype).
 * The names are checked when wrapping; if a Spark upgrade renames them the
 * affected stats stay empty and `missing` lists what was not found.
 */
import type { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

/** Fixed-size ring of (time, value) samples. */
export class SampleRing {
  private readonly at: Float64Array;
  private readonly value: Float64Array;
  private next = 0;
  private size = 0;

  constructor(readonly capacity = 4096) {
    this.at = new Float64Array(capacity);
    this.value = new Float64Array(capacity);
  }

  push(at: number, value: number): void {
    this.at[this.next] = at;
    this.value[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
  }

  /** Values recorded at or after `since`, oldest first. */
  since(since: number): number[] {
    const out: number[] = [];
    for (let k = this.size; k > 0; k--) {
      const i = (this.next - k + this.capacity) % this.capacity;
      if (this.at[i] >= since) out.push(this.value[i]);
    }
    return out;
  }

  /** Most recent value, or null when empty. */
  latest(): number | null {
    return this.size === 0 ? null : this.value[(this.next - 1 + this.capacity) % this.capacity];
  }
}

export interface Dist {
  n: number;
  median: number;
  p95: number;
  max: number;
}

export function dist(values: number[]): Dist | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, median: at(0.5), p95: at(0.95), max: s[s.length - 1] };
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/** The SparkRenderer members SparkStats reads or wraps (private in Spark's typings). */
interface SparkInternals {
  driveSort?: () => Promise<void>;
  readbackDepth?: (args: unknown) => Promise<void>;
  updateLodInstances?: (...args: unknown[]) => Promise<void>;
  lastTraverseTime: number;
  lastSortTime: number;
  sorting: boolean;
  lodInstances: Map<SplatMesh, { numSplats: number }>;
}

interface PagerInternals {
  maxPages: number;
  pageToSplatsChunk: unknown[];
  fetchers?: unknown[];
  fetched?: unknown[];
  newUploads?: unknown[];
  readyUploads?: unknown[];
  fetchPriority: { splats: unknown; chunk: number }[];
  getSplatsChunk(splats: unknown, chunk: number): unknown;
  isFetching(): boolean;
  processUploads?: () => void;
}

export interface PagerState {
  pagesUsed: number;
  maxPages: number;
  /** Chunk requests in flight. */
  fetching: number;
  /** Fetched chunks not yet uploaded to the GPU. */
  awaitingUpload: number;
  /** Chunks the current LoD selection wants that are not resident (streaming backlog). */
  missingChunks: number;
}

export interface SparkStatsSummary {
  windowS: number;
  lodUpdatesPerS: number;
  /** Worker-side LoD tree traversal (SparkRenderer.lastTraverseTime). */
  traverseMs: Dist | null;
  /** Whole LoD update on the LoD worker queue: traversal + index upload + page uploads + fetch scheduling. */
  lodUpdateMs: Dist | null;
  sortsPerS: number;
  /** GPU depth readback before each sort (async readRenderTargetPixelsAsync). */
  readbackMs: Dist | null;
  /** Worker sort + ordering-texture upload (sort cycle minus readback). */
  sortMs: Dist | null;
  /** Main-thread time spent uploading streamed pages, per second. */
  uploadMsPerS: number;
  pagesUploadedPerS: number;
  missing: string[];
}

/** Main-thread work attributed to the gap before a frame (for HitchLog). */
export interface FrameWork {
  uploadMs: number;
  pagesUploaded: number;
}

export class SparkStats {
  readonly traverse = new SampleRing();
  readonly lodUpdate = new SampleRing();
  readonly readback = new SampleRing();
  readonly sort = new SampleRing();
  readonly upload = new SampleRing();
  readonly pagesUploaded = new SampleRing();
  /** Internal Spark members that could not be wrapped (Spark version mismatch). */
  readonly missing: string[] = [];
  /** True while an LoD update (traversal on the LoD worker) is in flight. */
  lodUpdating = false;

  private readonly s: SparkInternals;
  private wrappedPager: PagerInternals | null = null;
  private lastReadbackMs = 0;
  private work: FrameWork = { uploadMs: 0, pagesUploaded: 0 };

  constructor(private readonly spark: SparkRenderer) {
    const s = (this.s = spark as unknown as SparkInternals);

    const readbackDepth = s.readbackDepth;
    if (typeof readbackDepth === "function") {
      s.readbackDepth = async (args) => {
        const t0 = performance.now();
        await readbackDepth.call(s, args);
        this.lastReadbackMs = performance.now() - t0;
        this.readback.push(t0, this.lastReadbackMs);
      };
    } else this.missing.push("SparkRenderer.readbackDepth");

    // driveSort returns early when a sort is running or nothing changed; a
    // new lastSortTime means it really sorted. It re-calls this.driveSort()
    // (unawaited) at the end, which lands back here as its own cycle.
    const driveSort = s.driveSort;
    if (typeof driveSort === "function") {
      s.driveSort = async () => {
        const before = s.lastSortTime;
        const t0 = performance.now();
        await driveSort.call(s);
        if (s.lastSortTime !== before) this.sort.push(t0, Math.max(0, performance.now() - t0 - this.lastReadbackMs));
      };
    } else this.missing.push("SparkRenderer.driveSort");

    const updateLodInstances = s.updateLodInstances;
    if (typeof updateLodInstances === "function") {
      s.updateLodInstances = async (...args) => {
        const t0 = performance.now();
        this.lodUpdating = true;
        try {
          await updateLodInstances.apply(s, args);
        } finally {
          this.lodUpdating = false;
        }
        this.traverse.push(t0, s.lastTraverseTime);
        this.lodUpdate.push(t0, performance.now() - t0);
      };
    } else this.missing.push("SparkRenderer.updateLodInstances");
  }

  private get pager(): PagerInternals | null {
    return (this.spark.pager as unknown as PagerInternals | undefined) ?? null;
  }

  /** Call once per frame: wraps the pager once Spark creates it (lazily, on the first paged mesh). */
  poll(): void {
    const p = this.pager;
    if (!p || p === this.wrappedPager) return;
    this.wrappedPager = p;
    const processUploads = p.processUploads;
    if (typeof processUploads !== "function" || !Array.isArray(p.readyUploads)) {
      this.missing.push("SplatPager.processUploads");
      return;
    }
    p.processUploads = () => {
      const pages = p.readyUploads?.length ?? 0;
      if (pages === 0) return processUploads.call(p);
      const t0 = performance.now();
      processUploads.call(p);
      const ms = performance.now() - t0;
      this.upload.push(t0, ms);
      this.pagesUploaded.push(t0, pages);
      this.work.uploadMs += ms;
      this.work.pagesUploaded += pages;
    };
  }

  /** Work done since the previous call (the gap before this frame). */
  takeFrameWork(): FrameWork {
    const w = this.work;
    this.work = { uploadMs: 0, pagesUploaded: 0 };
    return w;
  }

  get sorting(): boolean {
    return this.s.sorting;
  }

  pagerState(): PagerState | null {
    const p = this.pager;
    if (!p) return null;
    let missingChunks = 0;
    for (const { splats, chunk } of p.fetchPriority) if (!p.getSplatsChunk(splats, chunk)) missingChunks++;
    return {
      pagesUsed: p.pageToSplatsChunk.reduce<number>((n, e) => n + (e ? 1 : 0), 0),
      maxPages: p.maxPages,
      fetching: p.fetchers?.length ?? (p.isFetching() ? 1 : 0),
      awaitingUpload: (p.fetched?.length ?? 0) + (p.newUploads?.length ?? 0) + (p.readyUploads?.length ?? 0),
      missingChunks,
    };
  }

  /** Splats each mesh currently draws from its LoD selection (whole count for non-LoD meshes; 0 when hidden). */
  meshSplats(mesh: SplatMesh): number {
    if (!mesh.visible) return 0;
    if (mesh.paged) return mesh.paged.numSplats;
    return this.s.lodInstances.get(mesh)?.numSplats ?? mesh.numSplats;
  }

  summary(windowMs = 5000, now = performance.now()): SparkStatsSummary {
    const since = now - windowMs;
    const perS = (n: number) => n / (windowMs / 1000);
    return {
      windowS: windowMs / 1000,
      lodUpdatesPerS: perS(this.lodUpdate.since(since).length),
      traverseMs: dist(this.traverse.since(since)),
      lodUpdateMs: dist(this.lodUpdate.since(since)),
      sortsPerS: perS(this.sort.since(since).length),
      readbackMs: dist(this.readback.since(since)),
      sortMs: dist(this.sort.since(since)),
      uploadMsPerS: perS(sum(this.upload.since(since))),
      pagesUploadedPerS: perS(sum(this.pagesUploaded.since(since))),
      missing: [...this.missing],
    };
  }
}

/** Minimal slice of EXT_disjoint_timer_query_webgl2. */
interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/**
 * GPU time per renderer.render() via EXT_disjoint_timer_query_webgl2.
 * Results arrive a few frames late; samples are stamped with the frame they
 * measured. Unsupported (Safari, most mobile) -> `supported` false, no samples.
 */
export class GpuTimer {
  readonly samples = new SampleRing(2048);
  readonly supported: boolean;
  private readonly ext: TimerQueryExt | null;
  private readonly free: WebGLQuery[] = [];
  private readonly pending: { query: WebGLQuery; at: number }[] = [];
  private active: WebGLQuery | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerQueryExt | null;
    this.supported = this.ext !== null;
  }

  begin(): void {
    if (!this.ext || this.active) return;
    // Results not coming back (context trouble): stop issuing queries rather than leak them.
    if (this.pending.length > 16) return;
    const query = this.free.pop() ?? this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = query;
  }

  end(at: number): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push({ query: this.active, at });
    this.active = null;
  }

  /** Collect finished queries (call once per frame, outside begin/end). */
  poll(): void {
    if (!this.ext) return;
    const gl = this.gl;
    while (this.pending.length > 0) {
      const { query, at } = this.pending[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      // A disjoint event (GPU reset, clock change) invalidates results in flight.
      if (!gl.getParameter(this.ext.GPU_DISJOINT_EXT)) this.samples.push(at, (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6);
      this.free.push(query);
    }
  }

  summary(windowMs = 5000, now = performance.now()): Dist | null {
    return dist(this.samples.since(now - windowMs));
  }
}

export interface Hitch {
  /** performance.now() of the slow frame. */
  atMs: number;
  frameMs: number;
  /** Typical frame time just before it. */
  typicalMs: number;
  activeSplats: number;
  cameraMoving: boolean;
  sorting: boolean;
  lodUpdating: boolean;
  fetching: boolean;
  /** Main-thread page uploads in the gap before the frame. */
  uploadMs: number;
  pagesUploaded: number;
  /** Most recent GPU frame time available at that point (lags a few frames). */
  gpuMs: number | null;
}

/**
 * Hitch = a frame at least twice the typical frame time and 20 ms over it
 * (at 60 Hz: one dropped frame is not a hitch, two are). "Typical" is an
 * EMA over non-hitch frames, so a run of hitches doesn't raise the bar.
 */
export class HitchLog {
  static readonly MAX = 200;
  readonly entries: Hitch[] = [];
  total = 0;
  private typical: number | null = null;

  /** Returns the typical frame time if `dtMs` is a hitch, else null (and updates the baseline). */
  check(dtMs: number): number | null {
    if (!(dtMs > 0) || dtMs > 1000) return null; // tab switches / breakpoints, as FrameStats
    const typical = this.typical;
    if (typical !== null && dtMs >= 2 * typical && dtMs >= typical + 20) return typical;
    this.typical = typical === null ? dtMs : typical + 0.05 * (dtMs - typical);
    return null;
  }

  add(h: Hitch): void {
    this.total++;
    this.entries.push(h);
    if (this.entries.length > HitchLog.MAX) this.entries.shift();
  }

  reset(): void {
    this.entries.length = 0;
    this.total = 0;
  }

  /** Short cause tags for display. */
  static tags(h: Hitch): string {
    const t: string[] = [];
    if (h.pagesUploaded > 0) t.push(`upload ${h.pagesUploaded}p ${h.uploadMs.toFixed(0)}ms`);
    if (h.fetching) t.push("fetching");
    if (h.lodUpdating) t.push("lod");
    if (h.sorting) t.push("sort");
    if (h.cameraMoving) t.push("moving");
    return t.join(", ") || "idle";
  }
}
