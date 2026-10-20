import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { composeTRS, IDENTITY, mat4ApplyPoint } from "../../../shared/scene-schema.mjs";
import {
  meshMatrixFor,
  meshTRSFor,
  sceneTransformFromTRS,
  transformDiffers,
  transformMatrixFromMesh,
  yawPitchFromForward,
  type Mat4,
  type Vec3,
} from "./sceneMath";

// The real oculus scene transform (scenes/oculus/scene.json): -90 deg about X, scale 5.
const OCULUS: Mat4 = [5, 0, 0, 0, 0, 1.1102230246251565e-15, -5, 0, 0, 5, 1.1102230246251565e-15, 0, 0.7995684725019578, -0.2476744170031172, -3.368313447842285, 1];

const quatAxisAngle = (axis: Vec3, deg: number): [number, number, number, number] => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), THREE.MathUtils.degToRad(deg));
  return [q.x, q.y, q.z, q.w];
};

const POINTS: Vec3[] = [
  [0, 0, 0],
  [1, 2, 3],
  [-4.5, 0.25, 7],
  [12, -3, -9],
];

function closeVec(a: number[], b: number[], tol = 1e-9): void {
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(tol)));
}

/** What three.js renders: Object3D with the mesh TRS applied to a loaded point. */
function renderThroughObject3D(meshMatrix: Mat4, p: Vec3, built: Mat4 | null, tNew: Mat4): number[] {
  const trs = meshTRSFor(tNew, built);
  const o = new THREE.Object3D();
  o.position.set(...trs.position);
  o.quaternion.set(...trs.quaternion);
  o.scale.setScalar(trs.scale);
  o.updateMatrixWorld(true);
  closeVec(o.matrixWorld.elements, meshMatrix, 1e-9);
  return new THREE.Vector3(...p).applyMatrix4(o.matrixWorld).toArray();
}

describe("delta preview of a built scene", () => {
  const tNew = composeTRS([1.5, -0.2, 3], quatAxisAngle([0, 1, 0], 30), 1.2);

  it("D * (T_built * p) == T_new * p for source points", () => {
    for (const built of [OCULUS, composeTRS([0, 0, 0], quatAxisAngle([1, 1, 0], 77), 0.5), [...IDENTITY]]) {
      const d = meshMatrixFor(tNew, built);
      for (const p of POINTS) {
        const loaded = mat4ApplyPoint(built, p) as Vec3; // the .rad holds T_built * p_source
        closeVec(mat4ApplyPoint(d, loaded), mat4ApplyPoint(tNew, p), 1e-9);
      }
    }
  });

  it("is the identity when the transform has not changed since the build", () => {
    closeVec(meshMatrixFor(OCULUS, OCULUS), [...IDENTITY], 1e-12);
    const trs = meshTRSFor(OCULUS, OCULUS);
    closeVec(trs.position, [0, 0, 0], 1e-12);
    closeVec(trs.quaternion, [0, 0, 0, 1], 1e-12);
    expect(trs.scale).toBeCloseTo(1, 12);
    expect(transformDiffers(OCULUS, OCULUS)).toBe(false);
  });

  it("decomposes to an Object3D TRS that renders the same as T_new on the source", () => {
    const d = meshMatrixFor(tNew, OCULUS);
    for (const p of POINTS) {
      const loaded = mat4ApplyPoint(OCULUS, p) as Vec3;
      closeVec(renderThroughObject3D(d, loaded, OCULUS, tNew), mat4ApplyPoint(tNew, p), 1e-9);
    }
  });

  it("round-trips mesh matrix <-> absolute transform", () => {
    const d = meshMatrixFor(tNew, OCULUS);
    closeVec(transformMatrixFromMesh(d, OCULUS), tNew, 1e-9);
  });

  it("detects a changed transform", () => {
    expect(transformDiffers(tNew, OCULUS)).toBe(true);
    expect(transformDiffers(tNew, null)).toBe(false); // unbuilt: nothing to differ from
  });

  it("moving the origin by o shifts every scene point by -o, also through the delta", () => {
    const t = sceneTransformFromTRS({ position: [0.7995684725019578, -0.2476744170031172, -3.368313447842285], quaternion: [-0.7071067811865475, 0, 0, 0.7071067811865476], scale: 5 });
    closeVec(t.matrix, OCULUS, 1e-12);
    const o: Vec3 = [1, 2, -0.5];
    const shifted = sceneTransformFromTRS({ position: [t.position[0] - o[0], t.position[1] - o[1], t.position[2] - o[2]], quaternion: t.quaternion, scale: t.scale });
    const d = meshMatrixFor(shifted.matrix, OCULUS);
    for (const p of POINTS) {
      const before = mat4ApplyPoint(OCULUS, p) as Vec3;
      closeVec(mat4ApplyPoint(d, before), [before[0] - o[0], before[1] - o[1], before[2] - o[2]], 1e-9);
    }
  });
});

describe("unbuilt scene (source preview)", () => {
  it("puts T_new itself on the mesh", () => {
    const tNew = composeTRS([0, 1, 0], quatAxisAngle([1, 0, 0], -90), 2);
    expect(meshMatrixFor(tNew, null)).toEqual(tNew);
    expect(transformMatrixFromMesh(tNew, null)).toEqual(tNew);
  });
});

describe("yawPitchFromForward", () => {
  it("matches the nav convention (yaw 0 = -Z, +90 = -X)", () => {
    expect(yawPitchFromForward([0, 0, -1])).toEqual({ yaw: 0, pitch: 0 });
    expect(yawPitchFromForward([-1, 0, 0])).toEqual({ yaw: 90, pitch: 0 });
    expect(yawPitchFromForward([0, 1, -1]).pitch).toBeCloseTo(45, 2);
  });
});
