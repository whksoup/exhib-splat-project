/**
 * Orthographic section views and the image <-> world mapping they share.
 *
 * All coordinates are raw splat-file world coordinates (three.js, right-handed,
 * Y-up, metres; the viewer applies no model transform).
 *
 * A view is an orthonormal frame:
 *   n     = section axis, pointing from the scene TOWARDS the camera
 *           (the camera looks along -n);
 *   right = image +X (columns, left -> right);
 *   up    = image up (rows run top -> bottom, i.e. along -up).
 * right x up = n, so the frame is right-handed.
 *
 * The section keeps splats whose centre satisfies  floor <= dot(c, n) <= cut.
 * "cut" is the near clip (hides what is between the camera and the cut),
 * "floor" is the far clip. For the plan both are Y heights.
 */
import * as THREE from "three";

export type PlanViewId = "plan" | "elevation-z" | "elevation-x";

export interface PlanViewDef {
  id: PlanViewId;
  title: string;
  n: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  /** World axis that n runs along, for labels ("Y" for the plan). */
  axis: "X" | "Y" | "Z";
  cutLabel: string;
  floorLabel: string;
  /** Exact text written to the sidecar. */
  convention: string;
}

export const VIEWS: Record<PlanViewId, PlanViewDef> = {
  plan: {
    id: "plan",
    title: "Plan (top-down, looking -Y)",
    n: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 0, -1),
    axis: "Y",
    cutLabel: "Cut height (hide above)",
    floorLabel: "Floor height (hide below)",
    convention:
      "three.js/glTF world, right-handed, Y-up, metres. Camera looks along -Y. " +
      "Image +X (columns, left to right) = world +X. Image rows (top to bottom) = world +Z, so image up = world -Z. " +
      "Pixel (col,row) centre = (minX + (col+0.5)*metresPerPixel, plane.y, minZ + (row+0.5)*metresPerPixel).",
  },
  "elevation-z": {
    id: "elevation-z",
    title: "Elevation (looking -Z)",
    n: new THREE.Vector3(0, 0, 1),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    axis: "Z",
    cutLabel: "Cut Z (hide nearer, z >)",
    floorLabel: "Back Z (hide behind, z <)",
    convention:
      "three.js/glTF world, right-handed, Y-up, metres. Camera looks along -Z. " +
      "Image +X (columns, left to right) = world +X. Image up = world +Y (rows top to bottom = world -Y). " +
      "Pixel (col,row) centre = (minX + (col+0.5)*metresPerPixel, maxY - (row+0.5)*metresPerPixel, plane.z).",
  },
  "elevation-x": {
    id: "elevation-x",
    title: "Elevation (looking -X)",
    n: new THREE.Vector3(1, 0, 0),
    right: new THREE.Vector3(0, 0, -1),
    up: new THREE.Vector3(0, 1, 0),
    axis: "X",
    cutLabel: "Cut X (hide nearer, x >)",
    floorLabel: "Back X (hide behind, x <)",
    convention:
      "three.js/glTF world, right-handed, Y-up, metres. Camera looks along -X. " +
      "Image +X (columns, left to right) = world -Z. Image up = world +Y (rows top to bottom = world -Y). " +
      "Pixel (col,row) centre = (plane.x, maxY - (row+0.5)*metresPerPixel, maxZ - (col+0.5)*metresPerPixel).",
  },
};

/** Region of the view plane, in (r, u) = (dot(p, right), dot(p, up)) coordinates. */
export interface ViewRegion {
  r0: number;
  r1: number;
  u0: number;
  u1: number;
}

const AXES = ["x", "y", "z"] as const;
export type AxisName = (typeof AXES)[number];

/** Which world axis a unit frame vector runs along, and its sign. */
export function axisOf(v: THREE.Vector3): { axis: AxisName; sign: 1 | -1 } {
  const a = [v.x, v.y, v.z];
  const i = a.findIndex((c) => Math.abs(c) > 0.5);
  return { axis: AXES[i], sign: a[i] > 0 ? 1 : -1 };
}

/** World [min, max] along the axis of `v` <-> [lo, hi] of dot(p, v). */
export function worldRangeToFrame(v: THREE.Vector3, min: number, max: number): [number, number] {
  return axisOf(v).sign > 0 ? [min, max] : [-max, -min];
}
export function frameRangeToWorld(v: THREE.Vector3, lo: number, hi: number): [number, number] {
  return axisOf(v).sign > 0 ? [lo, hi] : [-hi, -lo];
}

/** World point at frame coordinates (r, u, depth along n). */
export function framePoint(view: PlanViewDef, r: number, u: number, d: number): THREE.Vector3 {
  return new THREE.Vector3()
    .addScaledVector(view.right, r)
    .addScaledVector(view.up, u)
    .addScaledVector(view.n, d);
}

/** World-space axis-aligned box of a region at depth range [d0, d1]. */
export function regionBox(view: PlanViewDef, region: ViewRegion, d0: number, d1: number): THREE.Box3 {
  const box = new THREE.Box3();
  for (const r of [region.r0, region.r1])
    for (const u of [region.u0, region.u1]) for (const d of [d0, d1]) box.expandByPoint(framePoint(view, r, u, d));
  return box;
}

/**
 * Position an orthographic camera to show `region`, looking along -n from
 * depth `camDepth`, with frustum depth reaching down to `farDepth`.
 */
export function placeOrthoCamera(
  cam: THREE.OrthographicCamera,
  view: PlanViewDef,
  region: ViewRegion,
  camDepth: number,
  farDepth: number,
): void {
  const cr = (region.r0 + region.r1) / 2;
  const cu = (region.u0 + region.u1) / 2;
  const hw = (region.r1 - region.r0) / 2;
  const hh = (region.u1 - region.u0) / 2;
  cam.position.copy(framePoint(view, cr, cu, camDepth));
  cam.up.copy(view.up);
  cam.lookAt(framePoint(view, cr, cu, camDepth - 1));
  cam.left = -hw;
  cam.right = hw;
  cam.top = hh;
  cam.bottom = -hh;
  cam.zoom = 1;
  cam.near = 0.01;
  cam.far = Math.max(0.1, camDepth - farDepth + 0.5);
  cam.clearViewOffset();
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
}
