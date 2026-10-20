/**
 * Align-mode transform JSON (assets/transforms/<stem>.json) and the bake command.
 * Pure functions (no DOM), unit tested in transformJson.test.ts.
 *
 * The JSON describes three.js Object3D TRS applied to the splat file's raw coordinates:
 *   p_world = position + R(quaternion) * (scale * p_file)
 * i.e. scale, then rotate, then translate, about the world origin. `quaternion` and
 * `matrix` are authoritative; `rotationDeg` (Euler order XYZ) is for humans.
 * pipeline/transform.mjs bakes exactly this into the file.
 */
import * as THREE from "three";

export const TRANSFORM_TOOL = "viewer-align";
export const EULER_ORDER = "XYZ" as const;
export const APPLIED_ORDER =
  "scale, then rotate, then translate, about the world origin (three.js Object3D: M = T * R * S, column vectors)";

export interface AlignTransformJson {
  source: string;
  position: [number, number, number];
  rotationDeg: [number, number, number];
  eulerOrder: typeof EULER_ORDER;
  quaternion: [number, number, number, number];
  scale: number;
  /** Column-major 4x4 (three.js Matrix4.elements). */
  matrix: number[];
  appliedOrder: string;
  createdAt: string;
  tool: typeof TRANSFORM_TOOL;
}

/** Round away float noise (e.g. 1e-17, 89.99999999999999) without visibly changing values. */
const clean = (v: number): number => {
  const r = Math.round(v * 1e9) / 1e9;
  const out = Math.abs(r - v) < 1e-12 ? r : v;
  return Object.is(out, -0) ? 0 : out;
};

export function buildTransformJson(
  t: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: number },
  source: string,
  createdAt = new Date().toISOString(),
): AlignTransformJson {
  const q = t.quaternion.clone().normalize();
  const m = new THREE.Matrix4().compose(t.position, q, new THREE.Vector3(t.scale, t.scale, t.scale));
  const e = new THREE.Euler().setFromQuaternion(q, EULER_ORDER);
  return {
    source,
    position: t.position.toArray() as [number, number, number],
    rotationDeg: [e.x, e.y, e.z].map((r) => clean(THREE.MathUtils.radToDeg(r))) as [number, number, number],
    eulerOrder: EULER_ORDER,
    quaternion: q.toArray() as [number, number, number, number],
    scale: t.scale,
    matrix: m.toArray(),
    appliedOrder: APPLIED_ORDER,
    createdAt,
    tool: TRANSFORM_TOOL,
  };
}

/** Dev-server URL -> repo-relative path of the file (mounts from vite.config.ts). */
export function sourceFromModelUrl(url: string): string {
  const p = decodeURIComponent(url.split(/[?#]/)[0]);
  if (p.startsWith("/source/")) return `assets/source_ply/${p.slice(8)}`;
  if (p.startsWith("/models/")) return `assets/rad_output/${p.slice(8)}`;
  return p;
}

/** File stem used for the JSON name: OculusMerged_1.ply -> OculusMerged_1 (".compressed" and "-lod" dropped). */
export function stemFromSource(source: string): string {
  const file = source.slice(source.lastIndexOf("/") + 1);
  const stem = file.replace(/\.[^.]+$/, "").replace(/\.compressed$/i, "").replace(/-lod$/i, "");
  return (
    stem
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.]+/, "")
      .slice(0, 100) || "model"
  );
}

const quote = (s: string): string => (/[\s"'&|<>^]/.test(s) ? `"${s}"` : s);

/** Command to bake the saved JSON (run from the repo root). */
export function bakeCommand(source: string, stem: string): string {
  const dir = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : ".";
  const out = /\.(ply|sog|spz|splat|ksplat)$/i.test(source) && !/\.rad$/i.test(source) ? `${dir}/${stem}-aligned.ply` : `assets/source_ply/${stem}-aligned.ply`;
  return `node pipeline/transform.mjs ${quote(source)} --transform ${quote(`assets/transforms/${stem}.json`)} --out ${quote(out)}`;
}
