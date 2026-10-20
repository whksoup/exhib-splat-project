/**
 * Plan export files: PNG (with a pHYs pixels-per-metre chunk), JSON sidecar,
 * and a GLB holding one textured plane at the exact world position.
 * Saved through the dev server's POST /__plan-export (assets/nav/<model>/),
 * or as browser downloads when that endpoint is unavailable.
 */
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { framePoint, frameRangeToWorld, axisOf, type PlanViewDef, type ViewRegion } from "./views";

export const SIDECAR_SCHEMA = "splat-plan-export/1";

const r9 = (v: number): number => Number(v.toFixed(9));
const v3 = (v: THREE.Vector3): [number, number, number] => [r9(v.x), r9(v.y), r9(v.z)];

/** Model folder name from a model URL: file stem without a trailing "-lod". */
export function modelNameFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0];
  const file = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
  const stem = file.replace(/\.[^.]+$/, "").replace(/-lod$/i, "");
  return sanitizeName(stem) || "model";
}

/** Keep [A-Za-z0-9._-], no leading dot, no "..". Mirrors the dev-server check. */
export function sanitizeName(s: string, max = 80): string {
  return s
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.]+/, "")
    .slice(0, max);
}

export interface PlanExportInfo {
  view: PlanViewDef;
  region: ViewRegion;
  metresPerPixel: number;
  width: number;
  height: number;
  /** Depth along view.n of the GLB plane (the floor / back value). */
  planeDepth: number;
  cut: number;
  cutEnabled: boolean;
  floor: number;
  floorEnabled: boolean;
  modelUrls: string[];
  modelName: string;
  label: string;
  background: string;
  capture: Record<string, unknown>;
}

export function corners(info: PlanExportInfo) {
  const { view, region, planeDepth: d } = info;
  return {
    topLeft: framePoint(view, region.r0, region.u1, d),
    topRight: framePoint(view, region.r1, region.u1, d),
    bottomLeft: framePoint(view, region.r0, region.u0, d),
    bottomRight: framePoint(view, region.r1, region.u0, d),
  };
}

export function buildSidecar(info: PlanExportInfo, files: { png: string; glb: string }) {
  const { view, region } = info;
  const c = corners(info);
  const box = new THREE.Box3().setFromPoints(Object.values(c));
  const world: Record<string, number> = {};
  for (const [vec, lo, hi] of [
    [view.right, region.r0, region.r1],
    [view.up, region.u0, region.u1],
  ] as const) {
    const { axis } = axisOf(vec);
    const [min, max] = frameRangeToWorld(vec, lo, hi);
    world[`min${axis.toUpperCase()}`] = r9(min);
    world[`max${axis.toUpperCase()}`] = r9(max);
  }
  const planeAxis = axisOf(view.n).axis;
  return {
    schema: SIDECAR_SCHEMA,
    created: new Date().toISOString(),
    view: view.id,
    label: info.label,
    modelName: info.modelName,
    modelUrl: info.modelUrls[0] ?? null,
    modelUrls: info.modelUrls,
    image: {
      file: files.png,
      width: info.width,
      height: info.height,
      metresPerPixel: r9(info.metresPerPixel),
      pixelsPerMetre: r9(1 / info.metresPerPixel),
      background: info.background,
    },
    /** World range covered by the image edges (not pixel centres). */
    world,
    section: {
      axis: view.axis,
      /** Splats with dot(centre, axisVector) > cut are hidden (when cutEnabled). */
      cut: r9(info.cut),
      cutEnabled: info.cutEnabled,
      /** Splats with dot(centre, axisVector) < floor are hidden (when floorEnabled). */
      floor: r9(info.floor),
      floorEnabled: info.floorEnabled,
      axisVector: v3(view.n),
    },
    plane: {
      file: files.glb,
      [planeAxis]: r9(info.planeDepth),
      corners: {
        topLeft: v3(c.topLeft),
        topRight: v3(c.topRight),
        bottomLeft: v3(c.bottomLeft),
        bottomRight: v3(c.bottomRight),
      },
      bounds: { min: v3(box.min), max: v3(box.max) },
    },
    axes: {
      convention: view.convention,
      imageRight: v3(view.right),
      imageUp: v3(view.up),
      imageDown: v3(view.up.clone().negate()),
      viewDirection: v3(view.n.clone().negate()),
      glb: "GLB is glTF 2.0 (Y-up, metres) with the plane's vertices in these world coordinates and an identity node transform; UV (0,0) = image top-left. Blender and Rhino convert Y-up to Z-up on import: (x, y, z) -> (x, -z, y).",
    },
    capture: info.capture,
  };
}

// --- PNG ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Insert a pHYs chunk (unit = metre) right after IHDR so image tools know the scale. */
function withPhys(png: Uint8Array, pixelsPerMetre: number): Uint8Array {
  const ihdrEnd = 8 + 4 + 4 + 13 + 4; // signature + IHDR(len, type, data, crc)
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  const ppm = Math.round(pixelsPerMetre);
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}

export async function canvasToPng(canvas: HTMLCanvasElement, pixelsPerMetre: number): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG encoding failed (canvas too large?)");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new Blob([withPhys(bytes, pixelsPerMetre) as Uint8Array<ArrayBuffer>], { type: "image/png" });
}

// --- GLB ---------------------------------------------------------------

/**
 * One quad with its vertices at the world corners of the image (identity
 * node transform) and the PNG as an unlit base-colour texture. UVs use the
 * glTF convention directly (origin top-left, texture.flipY = false), so the
 * exporter writes the image unflipped.
 */
export async function buildPlaneGlb(canvas: HTMLCanvasElement, info: PlanExportInfo, extras: object): Promise<ArrayBuffer> {
  const c = corners(info);
  const n = info.view.n;
  const geom = new THREE.BufferGeometry();
  // TL, BL, BR, TR
  geom.setAttribute("position", new THREE.Float32BufferAttribute([...v3(c.topLeft), ...v3(c.bottomLeft), ...v3(c.bottomRight), ...v3(c.topRight)], 3));
  geom.setAttribute("normal", new THREE.Float32BufferAttribute([n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z], 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 1, 1, 0], 2));
  geom.setIndex([0, 1, 2, 0, 2, 3]); // counter-clockwise seen from +n (the camera side)

  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.mimeType = "image/png";
  const transparent = info.background === "transparent";
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent });
  mat.name = `plan-${info.label}`;
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = `plan-${info.label}`;
  mesh.userData = extras;
  const scene = new THREE.Scene();
  scene.name = `plan-${info.label}`;
  scene.add(mesh);

  try {
    const out = await new GLTFExporter().parseAsync(scene, { binary: true, maxTextureSize: 16384 });
    if (!(out instanceof ArrayBuffer)) throw new Error("GLTFExporter did not return binary output");
    return out;
  } finally {
    geom.dispose();
    mat.dispose();
    tex.dispose();
  }
}

// --- Saving --------------------------------------------------------------

let endpointProbe: Promise<boolean> | null = null;

/** True when the Vite dev/preview server's /__plan-export endpoint answers. */
export function hasSaveEndpoint(): Promise<boolean> {
  endpointProbe ??= fetch("/__plan-export", { cache: "no-store" })
    .then(async (r) => r.ok && ((await r.json()) as { ok?: boolean }).ok === true)
    .catch(() => false);
  return endpointProbe;
}

/** Save into assets/nav/<model>/<file> via the dev server, else download. Returns where it went. */
export async function saveFile(model: string, file: string, blob: Blob): Promise<string> {
  if (await hasSaveEndpoint()) {
    const q = new URLSearchParams({ model, file });
    const res = await fetch(`/__plan-export?${q}`, { method: "POST", body: blob });
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; file?: string; error?: string };
    if (!res.ok || !out.ok) throw new Error(`Saving ${file} failed: ${out.error ?? `HTTP ${res.status}`}`);
    return out.file ?? file;
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: file });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return `download: ${file}`;
}
