/**
 * Scene transform maths for the viewer (pure, no DOM; unit tested in sceneMath.test.ts).
 *
 * `scene.transform` is ABSOLUTE: it maps the original source file's coordinates
 * to scene (aligned) coordinates, T_new. What the viewer actually loads is either
 *   - the built .rad, which already has T_built = scene.build.transformMatrix
 *     baked into its splats, or
 *   - the original source (unbuilt scene), in raw file coordinates.
 * So the matrix put on the SplatMesh is
 *   built:   D = T_new * T_built^-1     (identity when nothing changed since the build)
 *   source:  T_new
 * and in both cases  meshMatrix * p_loaded = T_new * p_source.
 *
 * All matrices are column-major 4x4 arrays (three.js Matrix4.elements order).
 */
import {
  decomposeTRS,
  deltaMatrix,
  mat4Multiply,
  matricesEqual,
  transformFromTRS,
  type SceneTransform,
} from "../../../shared/scene-schema.mjs";

export type Mat4 = number[];
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface TRS {
  position: Vec3;
  quaternion: Quat;
  scale: number;
}

/** Matrix for the loaded mesh so it shows the scene with transform `transformMatrix`. */
export function meshMatrixFor(transformMatrix: Mat4, builtMatrix: Mat4 | null): Mat4 {
  return builtMatrix ? deltaMatrix(transformMatrix, builtMatrix) : [...transformMatrix];
}

/** Inverse of meshMatrixFor: the absolute scene transform that a mesh matrix represents. */
export function transformMatrixFromMesh(meshMatrix: Mat4, builtMatrix: Mat4 | null): Mat4 {
  return builtMatrix ? mat4Multiply(meshMatrix, builtMatrix) : [...meshMatrix];
}

/** TRS to put on the mesh (Object3D position / quaternion / uniform scale). */
export function meshTRSFor(transformMatrix: Mat4, builtMatrix: Mat4 | null): TRS {
  return decomposeTRS(meshMatrixFor(transformMatrix, builtMatrix), 1e-5) as TRS;
}

/** Full scene.transform block from an authored TRS (what Align writes into the store). */
export function sceneTransformFromTRS(t: TRS): SceneTransform {
  return transformFromTRS({ position: [...t.position], quaternion: [...t.quaternion], scale: t.scale });
}

/** True when the absolute transform differs from the one baked into the build (false when unbuilt). */
export function transformDiffers(transformMatrix: Mat4, builtMatrix: Mat4 | null): boolean {
  return !!builtMatrix && !matricesEqual(transformMatrix, builtMatrix);
}

/** Camera forward vector -> nav yaw/pitch in degrees (yaw 0 looks down -Z, positive turns left). */
export function yawPitchFromForward(f: Vec3): { yaw: number; pitch: number } {
  const len = Math.hypot(f[0], f[1], f[2]) || 1;
  const [x, y, z] = [f[0] / len, f[1] / len, f[2] / len];
  const deg = 180 / Math.PI;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { yaw: r(Math.atan2(-x, -z) * deg) || 0, pitch: r(Math.asin(Math.max(-1, Math.min(1, y))) * deg) || 0 };
}

/** Round a world coordinate for storage (0.1 mm). */
export function roundCoord(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}
