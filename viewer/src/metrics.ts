/**
 * Measurement helpers for the week-1 go/no-go test: frame timing, load
 * timeline, and network bytes for model files. All times are
 * performance.now() milliseconds, i.e. relative to navigation start
 * ("page load" in the scope doc).
 */

export interface FrameSummary {
  frames: number;
  durationS: number;
  avgFps: number;
  /** Average fps over the slowest 1% of frames. */
  onePctLowFps: number;
  avgFrameMs: number;
  p99FrameMs: number;
  maxFrameMs: number;
}

function summarize(dts: ArrayLike<number>, count: number): FrameSummary {
  if (count === 0) {
    return { frames: 0, durationS: 0, avgFps: 0, onePctLowFps: 0, avgFrameMs: 0, p99FrameMs: 0, maxFrameMs: 0 };
  }
  const sorted = Array.from({ length: count }, (_, i) => dts[i]).sort((a, b) => b - a);
  let total = 0;
  for (const d of sorted) total += d;
  const worstN = Math.max(1, Math.ceil(count * 0.01));
  let worst = 0;
  for (let i = 0; i < worstN; i++) worst += sorted[i];
  const avgFrameMs = total / count;
  return {
    frames: count,
    durationS: total / 1000,
    avgFps: 1000 / avgFrameMs,
    onePctLowFps: 1000 / (worst / worstN),
    avgFrameMs,
    p99FrameMs: sorted[worstN - 1],
    maxFrameMs: sorted[0],
  };
}

/**
 * Tracks frame deltas in two windows: a short rolling window for the live
 * display, and a "measurement" window that runs from the last reset (the
 * tester presses Reset once LoD has settled, then walks the test route).
 */
export class FrameStats {
  private rolling: Float64Array;
  private rollingCount = 0;
  private rollingIndex = 0;
  private measure: number[] = [];
  measureStartMs = performance.now();
  private static readonly MAX_MEASURE = 200_000;

  constructor(rollingFrames = 240) {
    this.rolling = new Float64Array(rollingFrames);
  }

  record(dtMs: number): void {
    // Ignore gaps from tab switches / breakpoints; they aren't render cost.
    if (!(dtMs > 0) || dtMs > 1000) return;
    this.rolling[this.rollingIndex] = dtMs;
    this.rollingIndex = (this.rollingIndex + 1) % this.rolling.length;
    this.rollingCount = Math.min(this.rollingCount + 1, this.rolling.length);
    if (this.measure.length < FrameStats.MAX_MEASURE) this.measure.push(dtMs);
  }

  resetMeasurement(): void {
    this.measure = [];
    this.measureStartMs = performance.now();
  }

  live(): FrameSummary {
    return summarize(this.rolling, this.rollingCount);
  }

  measurement(): FrameSummary {
    return summarize(this.measure, this.measure.length);
  }
}

export interface NetworkSummary {
  requests: number;
  /** Bytes over the wire (0 for cross-origin responses without Timing-Allow-Origin). */
  transferBytes: number;
  /** Response body bytes (compressed size if content-encoded). */
  bodyBytes: number;
  firstResponseEndMs: number | null;
  /** When the most recent model request finished: a proxy for "full detail downloaded". */
  lastResponseEndMs: number | null;
}

/** Sums Resource Timing entries for URLs under the given prefixes (model dirs). */
export class NetworkTracker {
  private prefixes: string[] = [];
  private summary: NetworkSummary = {
    requests: 0,
    transferBytes: 0,
    bodyBytes: 0,
    firstResponseEndMs: null,
    lastResponseEndMs: null,
  };
  private observer?: PerformanceObserver;

  start(modelUrls: string[]): void {
    this.prefixes = modelUrls.map((u) => {
      const abs = new URL(u, window.location.href);
      abs.search = "";
      abs.hash = "";
      return abs.href.slice(0, abs.href.lastIndexOf("/") + 1);
    });
    try {
      performance.setResourceTimingBufferSize(20_000);
    } catch {
      /* not critical */
    }
    if (typeof PerformanceObserver === "undefined") return;
    this.observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) this.add(e);
    });
    this.observer.observe({ type: "resource", buffered: true });
  }

  private add(e: PerformanceResourceTiming): void {
    if (!this.prefixes.some((p) => e.name.startsWith(p))) return;
    const s = this.summary;
    s.requests += 1;
    s.transferBytes += e.transferSize || 0;
    s.bodyBytes += e.encodedBodySize || 0;
    s.firstResponseEndMs = s.firstResponseEndMs === null ? e.responseEnd : Math.min(s.firstResponseEndMs, e.responseEnd);
    s.lastResponseEndMs = s.lastResponseEndMs === null ? e.responseEnd : Math.max(s.lastResponseEndMs, e.responseEnd);
  }

  get(): NetworkSummary {
    return { ...this.summary };
  }
}

export type LodStatus = "waiting" | "loading" | "settled" | "error";

/**
 * Load timeline. `firstSplatFrameMs` = first rendered frame with
 * SparkRenderer.activeSplats > 0. `settledMs` = start of the first period of
 * at least `windowMs` during which Spark reported no outstanding LoD work
 * (see Viewer.isLodIdle for the exact signal).
 */
export class LoadTimeline {
  modelRequestMs: number | null = null;
  firstSplatFrameMs: number | null = null;
  settledMs: number | null = null;
  firstInteractionMs: number | null = null;
  status: LodStatus = "waiting";
  private idleSinceMs: number | null = null;

  constructor(private readonly windowMs: number) {}

  /** Call once per rendered frame. */
  update(now: number, activeSplats: number, idle: boolean): void {
    if (this.status === "error") return;
    if (this.firstSplatFrameMs === null && activeSplats > 0) this.firstSplatFrameMs = now;
    if (this.modelRequestMs === null) return;
    if (idle && activeSplats > 0) {
      if (this.idleSinceMs === null) this.idleSinceMs = now;
      if (now - this.idleSinceMs >= this.windowMs) {
        this.status = "settled";
        if (this.settledMs === null) this.settledMs = this.idleSinceMs;
      }
    } else {
      this.idleSinceMs = null;
      this.status = "loading";
    }
  }

  markInteraction(now: number): void {
    if (this.firstInteractionMs === null) this.firstInteractionMs = now;
  }

  /** True if the user moved the camera before the first settle (timing then isn't "at the start viewpoint"). */
  get interactedBeforeSettle(): boolean {
    return this.firstInteractionMs !== null && (this.settledMs === null || this.firstInteractionMs < this.settledMs);
  }
}
