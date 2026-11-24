/**
 * Editing an artwork's collider (its box, or its wall plane) with a gizmo in
 * the walk's debug mode. The gizmo moves, turns and resizes a three.js object;
 * this turns that object back into the artwork's volume, and the volume into
 * the edit the host saves. Pure apart from three.js maths (tested in
 * colliderEdit.test.ts).
 */
import * as THREE from "three";
import type { Vec3, WalkWork } from "./targeting";

/** One edited collider, in this build's frame (the host turns it into exhibition metres). `reset` drops the edit. */
export type WorkEdit =
  | { id: string; center: Vec3; axes: [Vec3, Vec3, Vec3]; half: Vec3; anchor: Vec3 }
  | { id: string; reset: true };

export type GizmoMode = "translate" | "rotate" | "scale";

const r = (n: number) => Math.round(n * 1e5) / 1e5;
const v3 = (v: THREE.Vector3): Vec3 => [r(v.x), r(v.y), r(v.z)];

/** Keep only the turn about the vertical axis: colliders stand upright. */
export function uprightQuaternion(q: THREE.Quaternion): THREE.Quaternion {
  const e = new THREE.Euler().setFromQuaternion(q, "YXZ");
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(0, e.y, 0, "YXZ"));
}

/**
 * The work after the gizmo moved its object: `base` is the work as the
 * object was built (scale 1), `anchorLocal` the marker in the object's own
 * frame at scale 1, so it moves, turns and stretches with the box.
 */
export function workFromObject(
  base: WalkWork,
  object: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 },
  anchorLocal: THREE.Vector3,
): WalkWork {
  const half0: Vec3 = base.box ? base.box.half : [base.radius, base.radius, base.radius];
  const s = object.scale;
  const half: Vec3 = [r(Math.abs(half0[0] * s.x)), r(Math.abs(half0[1] * s.y)), r(Math.abs(half0[2] * s.z))];
  const m = new THREE.Matrix4().makeRotationFromQuaternion(object.quaternion);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  m.extractBasis(a, b, c);
  const anchor = anchorLocal.clone().multiply(s).applyQuaternion(object.quaternion).add(object.position);
  return {
    ...base,
    center: v3(object.position),
    anchor: v3(anchor),
    radius: r(Math.hypot(...half)),
    box: { axes: [v3(a), v3(b), v3(c)], half },
    mount: base.mount ?? "object",
  };
}

/** The edit to save for a work. */
export function editOf(work: WalkWork): WorkEdit {
  const box = work.box ?? { axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [Vec3, Vec3, Vec3], half: [work.radius, work.radius, work.radius] as Vec3 };
  return { id: work.id, center: work.center, axes: box.axes, half: box.half, anchor: work.anchor };
}

/** Which gizmo handles make sense: colliders only turn about Y, and a wall plane has no depth to resize. */
export function gizmoAxes(mode: GizmoMode, work: WalkWork): { x: boolean; y: boolean; z: boolean } {
  if (mode === "rotate") return { x: false, y: true, z: false };
  if (mode === "scale") return { x: true, y: true, z: work.mount !== "wall" };
  return { x: true, y: true, z: true };
}
