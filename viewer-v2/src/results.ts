/**
 * Builds the JSON snapshot behind "Copy results". Field names are stable so
 * reports/ can be compared across devices and runs.
 */
import * as THREE from "three";
import type { Viewer } from "./viewer";

declare const __SPARK_VERSION__: string;
declare const __GSL_VERSION__: string;

export const SPARK_VERSION: string = typeof __SPARK_VERSION__ === "string" ? __SPARK_VERSION__ : "unknown";
export const GSL_VERSION: string = typeof __GSL_VERSION__ === "string" ? __GSL_VERSION__ : "unknown";

const round = (v: number | null | undefined, digits = 1): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(digits));

export function buildResults(viewer: Viewer) {
  const { spark, gsl, timeline, device, config } = viewer;
  const live = viewer.frames.live();
  const measured = viewer.frames.measurement();
  const fr = (s: typeof live) => ({
    frames: s.frames,
    durationS: round(s.durationS, 2),
    avgFps: round(s.avgFps),
    onePctLowFps: round(s.onePctLowFps),
    avgFrameMs: round(s.avgFrameMs, 2),
    p99FrameMs: round(s.p99FrameMs, 2),
    maxFrameMs: round(s.maxFrameMs, 2),
  });
  const size = viewer.renderer.getDrawingBufferSize(new THREE.Vector2());
  const net = viewer.network.get();
  return {
    schema: "splat-viewer-results/1",
    capturedAt: new Date().toISOString(),
    pageUrl: window.location.href,
    renderer: viewer.rendererKind,
    versions: { spark: SPARK_VERSION, gsl: GSL_VERSION, three: THREE.REVISION },
    device: {
      profile: device.profile.id,
      detected: device.detected,
      forced: device.forced,
      mobile: device.mobile,
      userAgent: navigator.userAgent,
      gpu: viewer.gpuInfo(),
      devicePixelRatio: window.devicePixelRatio,
      pixelRatio: viewer.pixelRatio,
      drawingBuffer: [size.x, size.y],
      notes: device.notes,
    },
    budget: {
      effective: viewer.budget,
      source: viewer.budgetSource,
      detail: viewer.detail,
      // Spark only (null on the GSL path).
      lodSplatCount: spark?.lodSplatCount ?? null,
      sparkDefaultSplatTarget: spark?.defaultSplatTarget() ?? null,
      lodSplatScale: spark?.lodSplatScale ?? null,
      lodRenderScale: spark?.lodRenderScale ?? null,
      maxStdDev: round(spark?.maxStdDev ?? gsl?.splatRenderer.maxStdDev, 4),
      maxPagedSplats: spark?.maxPagedSplats ?? null,
      pagedExtSplats: spark?.pagedExtSplats ?? null,
      // GSL only: streaming options (unset = defaults) and each streamed part's current share of the budget.
      gslOptions: gsl ? config.gsl : null,
      gslPartBudgets: gsl ? gsl.streams.map((s) => s.splatBudget) : null,
    },
    models: viewer.models.map((m) => ({
      url: m.spec.url,
      paged: m.paged,
      lod: m.spec.lod ?? null,
      ready: m.ready,
      rangeSupport: m.preflight.range,
      totalBytes: m.preflight.totalBytes,
      // Non-paged files: bytes from SplatMesh onProgress and time the mesh finished loading/decoding.
      plainBytesLoaded: m.paged ? null : m.bytesLoaded,
      plainLoadEndMs: m.paged ? null : round(m.loadEndMs),
    })),
    timing: {
      note: "ms since navigation start (performance.now())",
      modelRequestMs: round(timeline.modelRequestMs),
      firstSplatFrameMs: round(timeline.firstSplatFrameMs),
      lodSettledMs: round(timeline.settledMs),
      settleWindowMs: config.settleWindowMs,
      lastModelResponseEndMs: round(net.lastResponseEndMs),
      firstInteractionMs: round(timeline.firstInteractionMs),
      interactedBeforeSettle: timeline.interactedBeforeSettle,
      lodStatus: timeline.status,
    },
    network: {
      note: "Resource Timing for model URLs fetched on the main thread (paged .rad header + .radc chunks, plus 1 preflight per model). Plain files load in a worker: see models[].plainBytesLoaded.",
      requests: net.requests,
      transferMB: round(net.transferBytes / 1e6, 2),
      bodyMB: round(net.bodyBytes / 1e6, 2),
    },
    splats: {
      drawnNow: viewer.activeSplats,
      budget: viewer.budget,
      pagerPoolSplats: spark?.pager?.maxSplats ?? null,
    },
    frames: {
      live: fr(live),
      measurement: { sinceMs: round(viewer.frames.measureStartMs), ...fr(measured) },
    },
    diagnostics: {
      note: "Last 5 s unless stated. traverseMs = worker LoD traversal; sortMs = worker sort + ordering upload; readbackMs = depth readback before each sort; gpuMs = EXT_disjoint_timer_query_webgl2 around renderer.render().",
      gpuTimerSupported: viewer.gpu.supported,
      gpuMs: viewer.gpu.summary(),
      spark: viewer.sparkStats?.summary() ?? null,
      pager: viewer.sparkStats?.pagerState() ?? null,
      gsl: gsl?.summary() ?? null,
      memory: memorySnapshot(viewer),
      parts: viewer.models.map((m) => ({ id: m.id, url: m.spec.url, visible: m.object.visible, lodSplats: viewer.modelSplats(m) })),
      hitches: { total: viewer.hitches.total, recent: viewer.hitches.entries.slice(-50) },
      benchmark: viewer.lastBenchmark,
    },
    camera: {
      position: viewer.camera.position.toArray().map((v) => round(v, 3)),
      quaternion: viewer.camera.quaternion.toArray().map((v) => round(v, 4)),
      fov: viewer.camera.fov,
      controls: viewer.rig.mode,
    },
    errors: [...viewer.errors],
  };
}

/**
 * Memory, comparable across renderers only for the JS heap: Chrome's
 * performance.memory (ArrayBuffers held by JS count, GPU memory doesn't).
 * The GSL figures are its own estimates of retained CPU and GPU data.
 */
export function memorySnapshot(viewer: Viewer) {
  const pm = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const g = viewer.gsl?.summary();
  return {
    jsHeapUsedMB: pm ? round(pm.usedJSHeapSize / 1e6) : null,
    gslResidentCpuMB: g?.residentCpuMB ?? null,
    gslResidentGpuMB: g?.residentGpuMB ?? null,
  };
}

export type Results = ReturnType<typeof buildResults>;
