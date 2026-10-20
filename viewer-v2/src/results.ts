/**
 * Builds the JSON snapshot behind "Copy results". Field names are stable so
 * reports/ can be compared across devices and runs.
 */
import * as THREE from "three";
import { gpuInfo } from "./device";
import type { Viewer } from "./viewer";

declare const __SPARK_VERSION__: string;

export const SPARK_VERSION: string = typeof __SPARK_VERSION__ === "string" ? __SPARK_VERSION__ : "unknown";

const round = (v: number | null | undefined, digits = 1): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(digits));

export function buildResults(viewer: Viewer) {
  const { spark, timeline, device, config } = viewer;
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
    versions: { spark: SPARK_VERSION, three: THREE.REVISION },
    device: {
      profile: device.profile.id,
      detected: device.detected,
      forced: device.forced,
      mobile: device.mobile,
      userAgent: navigator.userAgent,
      gpu: gpuInfo(viewer.renderer.getContext()),
      devicePixelRatio: window.devicePixelRatio,
      pixelRatio: viewer.pixelRatio,
      drawingBuffer: [size.x, size.y],
      notes: device.notes,
    },
    budget: {
      effective: viewer.budget,
      source: viewer.budgetSource,
      lodSplatCount: spark.lodSplatCount ?? null,
      sparkDefaultSplatTarget: spark.defaultSplatTarget(),
      lodSplatScale: spark.lodSplatScale,
      lodRenderScale: spark.lodRenderScale,
      maxStdDev: round(spark.maxStdDev, 4),
      maxPagedSplats: spark.maxPagedSplats,
      pagedExtSplats: spark.pagedExtSplats,
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
      drawnNow: spark.activeSplats,
      budget: viewer.budget,
      pagerPoolSplats: spark.pager?.maxSplats ?? null,
    },
    frames: {
      live: fr(live),
      measurement: { sinceMs: round(viewer.frames.measureStartMs), ...fr(measured) },
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

export type Results = ReturnType<typeof buildResults>;
