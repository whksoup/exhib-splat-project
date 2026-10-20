/**
 * High-quality offscreen capture of an orthographic section view.
 *
 * - Temporarily raises the splat budget (SparkRenderer.lodSplatCount /
 *   lodSplatScale), turns foveation off (coneFoveate / behindFoveate = 1, so
 *   splats away from the view axis are not coarsened) and switches to Z-depth
 *   sorting (sortRadial = false, right for an orthographic camera).
 * - Splits the image into tiles no larger than the GPU's max texture /
 *   renderbuffer / viewport size. Each tile gets its own orthographic camera
 *   centred over it, so view-dependent paged LoD refines around that tile.
 * - Renders each tile into an sRGB render target through the viewer's normal
 *   render loop (Viewer.renderCamera + renderer.setRenderTarget from an
 *   onFrame hook) until Spark's LoD has settled, using the same signal as the
 *   perf overlay (Viewer.isLodIdle(), held for settleMs) plus "no sort in
 *   flight" (SparkRenderer.sorting / sortDirty). Then reads the pixels back.
 * - Restores every setting afterwards, also on error.
 */
import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import type { FrameHook, Viewer } from "../viewer";
import { framePoint, placeOrthoCamera, type PlanViewDef, type ViewRegion } from "./views";

export interface CaptureOptions {
  view: PlanViewDef;
  /** Region to capture; r1 - r0 and u1 - u0 must be whole multiples of metresPerPixel. */
  region: ViewRegion;
  metresPerPixel: number;
  /** Camera depth along view.n (just in front of the near clip). */
  camDepth: number;
  /** Deepest depth along view.n to include in the frustum. */
  farDepth: number;
  /** null = transparent background. */
  background: THREE.Color | null;
  /** Splat budget during capture (SparkRenderer.lodSplatCount). */
  budget: number;
  /** Upper bound on tile edge in pixels (also limited by the GPU). */
  maxTile?: number;
  /** LoD must stay idle this long before a tile is read back. */
  settleMs: number;
  /** Give up waiting for a tile to settle after this long (it is still captured). */
  timeoutMs: number;
  /** LoD detail multiplier: > 1 = finer than one splat per output pixel. */
  detail: number;
  onProgress?: (msg: string) => void;
}

export interface CaptureResult {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  tileSize: number;
  tiles: number;
  unsettledTiles: number;
  budget: number;
  maxActiveSplats: number;
  durationMs: number;
}

/** Largest canvas the export path accepts (Chrome's canvas area limit is 2^28 px). */
export const MAX_IMAGE_EDGE = 32767;
export const MAX_IMAGE_PIXELS = 268_435_456;

export function gpuTileLimit(renderer: THREE.WebGLRenderer): number {
  const gl = renderer.getContext();
  const rb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
  const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  return Math.min(renderer.capabilities.maxTextureSize, rb, vp[0], vp[1]);
}

// sRGB <-> linear lookup tables for un-premultiplying the readback.
const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LIN_STEPS = 4096;
const LIN_TO_SRGB = new Uint8ClampedArray(LIN_STEPS + 1);
for (let i = 0; i <= LIN_STEPS; i++) {
  const l = i / LIN_STEPS;
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  LIN_TO_SRGB[i] = Math.round(s * 255);
}

/**
 * Copy a bottom-up RGBA readback into a top-down ImageData. Spark renders with
 * premultiplied alpha into an sRGB target (blending in linear space), so with a
 * transparent background the colour is un-premultiplied in linear space.
 */
function toImageData(src: Uint8Array, w: number, h: number, transparent: boolean): ImageData {
  const img = new ImageData(w, h);
  const dst = img.data;
  for (let y = 0; y < h; y++) {
    let s = (h - 1 - y) * w * 4;
    let d = y * w * 4;
    for (let x = 0; x < w; x++, s += 4, d += 4) {
      const a = src[s + 3];
      if (!transparent) {
        dst[d] = src[s];
        dst[d + 1] = src[s + 1];
        dst[d + 2] = src[s + 2];
        dst[d + 3] = 255;
      } else if (a === 0) {
        dst[d] = dst[d + 1] = dst[d + 2] = dst[d + 3] = 0;
      } else if (a === 255) {
        dst[d] = src[s];
        dst[d + 1] = src[s + 1];
        dst[d + 2] = src[s + 2];
        dst[d + 3] = 255;
      } else {
        const k = (255 / a) * LIN_STEPS;
        dst[d] = LIN_TO_SRGB[Math.min(LIN_STEPS, Math.round(SRGB_TO_LIN[src[s]] * k))];
        dst[d + 1] = LIN_TO_SRGB[Math.min(LIN_STEPS, Math.round(SRGB_TO_LIN[src[s + 1]] * k))];
        dst[d + 2] = LIN_TO_SRGB[Math.min(LIN_STEPS, Math.round(SRGB_TO_LIN[src[s + 2]] * k))];
        dst[d + 3] = a;
      }
    }
  }
  return img;
}

/** Hide every top-level scene object that isn't splats (helpers, collision debug, ...). */
function hideNonSplats(viewer: Viewer): () => void {
  const hidden: THREE.Object3D[] = [];
  for (const child of viewer.scene.children) {
    const keep =
      child === viewer.spark ||
      child instanceof SplatMesh ||
      (child as { isSplatEdit?: boolean }).isSplatEdit === true;
    if (!keep && child.visible) {
      child.visible = false;
      hidden.push(child);
    }
  }
  return () => hidden.forEach((o) => (o.visible = true));
}

interface TileResult {
  pixels: Uint8Array;
  settled: boolean;
  maxActive: number;
}

/** Render `cam` into `rt` every frame until LoD settles, then read it back. */
function renderUntilSettled(
  viewer: Viewer,
  cam: THREE.Camera,
  rt: THREE.WebGLRenderTarget,
  opts: CaptureOptions,
  onTick: (idleMs: number, elapsedMs: number) => void,
): Promise<TileResult> {
  const { renderer, spark } = viewer;
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let idleSince: number | null = null;
    let frames = 0;
    let maxActive = 0;
    const hook: FrameHook = ({ now }) => {
      try {
        if (frames > 0) {
          // State after the previous frame's render into rt.
          maxActive = Math.max(maxActive, spark.activeSplats);
          const idle = viewer.isLodIdle() && !spark.sorting && !spark.sortDirty && spark.activeSplats > 0;
          if (idle) idleSince ??= now;
          else idleSince = null;
          const idleMs = idleSince === null ? 0 : now - idleSince;
          const settled = frames >= 6 && idleMs >= opts.settleMs;
          const timedOut = now - start > opts.timeoutMs;
          onTick(idleMs, now - start);
          if (settled || timedOut) {
            const pixels = new Uint8Array(rt.width * rt.height * 4);
            renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, pixels);
            renderer.setRenderTarget(null);
            // Remove after the frame's hook loop finishes, so no other hook is skipped.
            queueMicrotask(() => {
              const i = viewer.onFrame.indexOf(hook);
              if (i >= 0) viewer.onFrame.splice(i, 1);
            });
            resolve({ pixels, settled, maxActive });
            return;
          }
        }
        frames++;
        renderer.setRenderTarget(rt);
        viewer.renderCamera = cam;
      } catch (err) {
        renderer.setRenderTarget(null);
        queueMicrotask(() => {
          const i = viewer.onFrame.indexOf(hook);
          if (i >= 0) viewer.onFrame.splice(i, 1);
        });
        reject(err);
      }
    };
    viewer.onFrame.push(hook);
  });
}

export async function captureView(viewer: Viewer, opts: CaptureOptions): Promise<CaptureResult> {
  const t0 = performance.now();
  const { renderer, spark } = viewer;
  const mpp = opts.metresPerPixel;
  const W = Math.round((opts.region.r1 - opts.region.r0) / mpp);
  const H = Math.round((opts.region.u1 - opts.region.u0) / mpp);
  if (W < 1 || H < 1) throw new Error("Capture region is empty");
  if (W > MAX_IMAGE_EDGE || H > MAX_IMAGE_EDGE || W * H > MAX_IMAGE_PIXELS) {
    throw new Error(`Image ${W}x${H} px is too large for a browser canvas; lower px/m or shrink the region`);
  }
  const tile = Math.max(256, Math.min(opts.maxTile ?? 4096, gpuTileLimit(renderer)));
  const cols = Math.ceil(W / tile);
  const rows = Math.ceil(H / tile);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");

  const hasPaged = viewer.models.some((m) => m.paged);
  const budget = Math.round(hasPaged ? Math.min(opts.budget, spark.maxPagedSplats) : opts.budget);

  const saved = {
    lodSplatCount: spark.lodSplatCount,
    lodSplatScale: spark.lodSplatScale,
    lodRenderScale: spark.lodRenderScale,
    coneFoveate: spark.coneFoveate,
    behindFoveate: spark.behindFoveate,
    sortRadial: spark.sortRadial,
    clearColor: renderer.getClearColor(new THREE.Color()),
    clearAlpha: renderer.getClearAlpha(),
    renderCamera: viewer.renderCamera,
  };
  const restoreVisibility = hideNonSplats(viewer);
  const rt = new THREE.WebGLRenderTarget(1, 1, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const cam = new THREE.OrthographicCamera();
  let unsettled = 0;
  let maxActive = 0;

  try {
    spark.lodSplatCount = budget;
    spark.lodSplatScale = 1;
    spark.coneFoveate = 1;
    spark.behindFoveate = 1;
    spark.sortRadial = false;
    if (opts.background) renderer.setClearColor(opts.background, 1);
    else renderer.setClearColor(0x000000, 0);

    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const tw = Math.min(tile, W - tx * tile);
        const th = Math.min(tile, H - ty * tile);
        const r0 = opts.region.r0 + tx * tile * mpp;
        const u1 = opts.region.u1 - ty * tile * mpp; // image rows run along -up
        const tileRegion: ViewRegion = { r0, r1: r0 + tw * mpp, u0: u1 - th * mpp, u1 };
        placeOrthoCamera(cam, opts.view, tileRegion, opts.camDepth, opts.farDepth);
        rt.setSize(tw, th);
        spark.lodRenderScale = lodRenderScaleFor(opts, tileRegion);

        const n = ty * cols + tx + 1;
        const total = rows * cols;
        const res = await renderUntilSettled(viewer, cam, rt, opts, (idleMs, elapsed) =>
          opts.onProgress?.(
            `Tile ${n}/${total} (${tw}x${th} px): ${spark.activeSplats.toLocaleString()} splats, ` +
              `${idleMs > 0 ? `settling ${(idleMs / 1000).toFixed(1)} s` : "LoD loading"} (${(elapsed / 1000).toFixed(0)} s)`,
          ),
        );
        if (!res.settled) unsettled++;
        maxActive = Math.max(maxActive, res.maxActive);
        ctx.putImageData(toImageData(res.pixels, tw, th, !opts.background), tx * tile, ty * tile);
      }
    }
  } finally {
    renderer.setRenderTarget(null);
    spark.lodSplatCount = saved.lodSplatCount;
    spark.lodSplatScale = saved.lodSplatScale;
    spark.lodRenderScale = saved.lodRenderScale;
    spark.coneFoveate = saved.coneFoveate;
    spark.behindFoveate = saved.behindFoveate;
    spark.sortRadial = saved.sortRadial;
    renderer.setClearColor(saved.clearColor, saved.clearAlpha);
    viewer.renderCamera = saved.renderCamera;
    restoreVisibility();
    rt.dispose();
  }

  return {
    canvas,
    width: W,
    height: H,
    tileSize: tile,
    tiles: rows * cols,
    unsettledTiles: unsettled,
    budget,
    maxActiveSplats: maxActive,
    durationMs: performance.now() - t0,
  };
}

/**
 * SparkRenderer.lodRenderScale for one tile. For an orthographic camera Spark
 * sets the LoD pixel limit to world metres per render pixel, but the LoD tree
 * traversal (Rust/WASM, traverse_lod_trees) receives no projection type and
 * measures splat size relative to distance from the camera, as for a
 * perspective view (checked: same ortho view, camera 3 m vs 40 m above the
 * floor drew 62k vs 0.7k splats). Scaling by 1 / (farthest distance from the camera to the
 * tile's slab) makes every splat in the tile at least as fine as one output
 * pixel; the budget caps the total.
 */
function lodRenderScaleFor(opts: CaptureOptions, region: ViewRegion): number {
  const cr = (region.r0 + region.r1) / 2;
  const cu = (region.u0 + region.u1) / 2;
  const camPos = framePoint(opts.view, cr, cu, opts.camDepth);
  let dMax = 0;
  for (const r of [region.r0, region.r1])
    for (const u of [region.u0, region.u1])
      for (const d of [opts.camDepth, opts.farDepth]) dMax = Math.max(dMax, framePoint(opts.view, r, u, d).distanceTo(camPos));
  return THREE.MathUtils.clamp(1 / (Math.max(dMax, 1) * Math.max(0.1, opts.detail)), 1e-3, 1);
}
