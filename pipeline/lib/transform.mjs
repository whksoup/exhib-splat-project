// Viewer "Align" transform JSON -> PlayCanvas splat-transform actions.
//
// The viewer (three.js) previews a model with Object3D TRS:
//     p_world = T + R(q) * (s * p_file)          (scale, then rotate, then translate, about the world origin)
// and writes that as assets/transforms/<stem>.json (tool "viewer-align").
// This module turns the JSON into splat-transform CLI arguments whose result,
// written back to .ply, holds exactly p_out = T + R(q) * (s * p_in) per splat.
//
// splat-transform 3.10.0 conventions (verified in node_modules/@playcanvas/splat-transform/dist/index.mjs
// and node_modules/playcanvas/build/playcanvas.mjs, not guessed):
//  - Readers tag PLY/SOG/SPZ/splat data with Transform.PLY = a 180 degree rotation about Z
//    ("PLY coordinate convention"). User actions act in PlayCanvas *engine* space:
//    each action left-multiplies the pending transform (processDataTable: `new Transform(...).mul(result.transform)`),
//    so CLI order == application order. On write the pending transform is baked into
//    PLY space: delta = PLY^-1 * U * PLY (bakeTransform / convertToSpace).
//    So to get M in file space we must pass U = C * M * C^-1 with C = Rz(180):
//      translation (x, y, z) -> (-x, -y, z), quaternion (x, y, z, w) -> (-x, -y, z, w), scale unchanged.
//  - `-r x,y,z` uses Quat.setFromEulerAngles(x, y, z) in degrees, which equals three.js
//    Euler order 'ZYX' (q = qz * qy * qx: rotate about X first, then Y, then Z, world axes).
//  - Baking: positions get full TRS, rot_* quaternions are pre-multiplied by the rotation,
//    scale_* (log) get + ln(s), and f_rest_* SH (bands 1-3) are rotated with RotateSH
//    (sh-lib). DC and opacity are untouched.

export const TRANSFORM_TOOL = 'viewer-align';

const EPS_ZERO = 1e-12;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum);

/** Quaternion [x,y,z,w] -> row-major 3x3 [[m11,m12,m13],[m21..],[m31..]]. */
export function quatToMat3([x, y, z, w]) {
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    [1 - (yy + zz), xy - wz, xz + wy],
    [xy + wz, 1 - (xx + zz), yz - wx],
    [xz - wy, yz + wx, 1 - (xx + yy)],
  ];
}

/** Column-major 4x4 (three.js Matrix4.elements order) for T * R(q) * S(s). */
export function composeMatrix(position, quaternion, scale) {
  const m = quatToMat3(quaternion);
  return [
    m[0][0] * scale, m[1][0] * scale, m[2][0] * scale, 0,
    m[0][1] * scale, m[1][1] * scale, m[2][1] * scale, 0,
    m[0][2] * scale, m[1][2] * scale, m[2][2] * scale, 0,
    position[0], position[1], position[2], 1,
  ];
}

export function applyMatrix(me, [x, y, z]) {
  return [
    me[0] * x + me[4] * y + me[8] * z + me[12],
    me[1] * x + me[5] * y + me[9] * z + me[13],
    me[2] * x + me[6] * y + me[10] * z + me[14],
  ];
}

/** Hamilton product a * b, both [x,y,z,w]. */
export function quatMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by + ay * bw + az * bx - ax * bz,
    aw * bz + az * bw + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** PlayCanvas Quat.setFromEulerAngles(ex, ey, ez) (degrees), copied formula. */
export function playcanvasEulerToQuat(ex, ey, ez) {
  const h = 0.5 * Math.PI / 180;
  const sx = Math.sin(ex * h), cx = Math.cos(ex * h);
  const sy = Math.sin(ey * h), cy = Math.cos(ey * h);
  const sz = Math.sin(ez * h), cz = Math.cos(ez * h);
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

/** Quaternion -> PlayCanvas Euler degrees (three.js 'ZYX' extraction). */
export function quatToPlaycanvasEuler(q) {
  const m = quatToMat3(q);
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  const y = Math.asin(-clamp(m[2][0]));
  let x;
  let z;
  if (Math.abs(m[2][0]) < 0.9999999) {
    x = Math.atan2(m[2][1], m[2][2]);
    z = Math.atan2(m[1][0], m[0][0]);
  } else {
    x = 0;
    z = Math.atan2(-m[0][1], m[1][1]);
  }
  const d = 180 / Math.PI;
  return [x * d, y * d, z * d];
}

const quatAngleErr = (a, b) => 1 - Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);

/**
 * Validate and normalise a transform JSON object.
 * quaternion/position/scale are authoritative; `matrix` (when present) must agree.
 * @returns {{ position: number[], quaternion: number[], scale: number, matrix: number[], warnings: string[] }}
 */
export function parseTransformJson(json) {
  const errors = [];
  const warnings = [];
  if (!json || typeof json !== 'object') throw new Error('transform JSON must be an object');
  if (!isVec(json.position, 3)) errors.push('"position" must be [x, y, z]');
  if (!isVec(json.quaternion, 4)) errors.push('"quaternion" must be [x, y, z, w]');
  if (!isNum(json.scale) || json.scale <= 0) errors.push('"scale" must be a positive number (uniform scale only)');
  if (errors.length) throw new Error(`invalid transform JSON: ${errors.join('; ')}`);
  if (json.tool && json.tool !== TRANSFORM_TOOL) warnings.push(`tool is "${json.tool}", expected "${TRANSFORM_TOOL}"`);

  const n = Math.hypot(...json.quaternion);
  if (Math.abs(n - 1) > 1e-6) {
    if (n < 1e-6) throw new Error('"quaternion" has zero length');
    warnings.push(`quaternion length ${n} renormalised`);
  }
  const quaternion = json.quaternion.map((v) => v / n);
  const position = [...json.position];
  const scale = json.scale;
  const matrix = composeMatrix(position, quaternion, scale);

  if (json.matrix !== undefined) {
    if (!isVec(json.matrix, 16)) throw new Error('"matrix" must be 16 numbers (column-major)');
    const tol = 1e-6 * Math.max(1, scale, ...position.map(Math.abs));
    const bad = json.matrix.findIndex((v, i) => Math.abs(v - matrix[i]) > tol);
    if (bad >= 0) {
      throw new Error(`"matrix" disagrees with position/quaternion/scale at element ${bad} (${json.matrix[bad]} vs ${matrix[bad]}); the file was edited inconsistently`);
    }
  }
  if (json.rotationDeg !== undefined && json.eulerOrder === 'XYZ' && isVec(json.rotationDeg, 3)) {
    const q = eulerXYZDegToQuat(json.rotationDeg);
    if (quatAngleErr(q, quaternion) > 1e-8) warnings.push('rotationDeg (XYZ) does not match quaternion; quaternion wins');
  }
  return { position, quaternion, scale, matrix, warnings };
}

/** three.js Euler(x, y, z, 'XYZ') in degrees -> quaternion (q = qx * qy * qz). */
export function eulerXYZDegToQuat([ex, ey, ez]) {
  const h = 0.5 * Math.PI / 180;
  const c1 = Math.cos(ex * h), c2 = Math.cos(ey * h), c3 = Math.cos(ez * h);
  const s1 = Math.sin(ex * h), s2 = Math.sin(ey * h), s3 = Math.sin(ez * h);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

const fmtNum = (v) => {
  const r = Math.abs(v) < EPS_ZERO ? 0 : v;
  return String(Object.is(r, -0) ? 0 : r); // shortest round-trip repr of the double
};

/**
 * Map a parsed transform onto splat-transform CLI action arguments.
 * Uses the `--name=value` form so negative values are never mistaken for flags.
 * @returns {{ args: string[], engine: { translate: number[], eulerDeg: number[], scale: number } }}
 */
export function toSplatTransformActions({ position, quaternion, scale }) {
  // U = C * M * C^-1, C = Rz(180): conjugating by C negates x and y.
  const qEngine = [-quaternion[0], -quaternion[1], quaternion[2], quaternion[3]];
  const tEngine = [-position[0], -position[1], position[2]];
  // Snap float noise (89.99999999999999 -> 90): moves the angle by < 1e-10 deg, i.e. < 2e-12 rad.
  const eulerDeg = quatToPlaycanvasEuler(qEngine).map((v) => {
    const r = Math.round(v * 1e9) / 1e9;
    return Math.abs(r - v) < 1e-10 ? r : v;
  });
  // Self-check: the Euler angles must reproduce the quaternion through PlayCanvas's formula.
  const back = playcanvasEulerToQuat(...eulerDeg);
  if (quatAngleErr(back, qEngine) > 1e-12) {
    throw new Error(`internal: Euler round trip failed (${eulerDeg.join(',')})`);
  }
  const args = [];
  // Order matters: actions apply in CLI order (scale, then rotate, then translate) == three.js T*R*S.
  if (Math.abs(scale - 1) > EPS_ZERO) args.push(`--scale=${fmtNum(scale)}`);
  if (quatAngleErr(qEngine, [0, 0, 0, 1]) > EPS_ZERO) args.push(`--rotate=${eulerDeg.map(fmtNum).join(',')}`);
  if (tEngine.some((v) => Math.abs(v) > EPS_ZERO)) args.push(`--translate=${tEngine.map(fmtNum).join(',')}`);
  return { args, engine: { translate: tEngine, eulerDeg, scale } };
}
