// Scene save-file schema (scenes/<name>/scene.json), shared by the viewer
// (viewer-v2, imported through Vite) and the pipeline (Node). Plain JS + JSDoc,
// no dependencies and no Node or DOM APIs, so it runs in both places unchanged.
//
// A scene owns everything about one tour model:
//   scenes/<name>/scene.json   this file (committed)
//   scenes/<name>/nav/         plan exports, collision GLB (committed)
//   scenes/<name>/build/       generated .rad + .radc, build-report.json, build-lod.log (gitignored)
//
// Transforms are three.js Object3D TRS (scale, then rotate, then translate, about
// the world origin), stored like the v1 Align transform JSON. `scene.transform`
// is always relative to the ORIGINAL source file; rebuilds start from the source.
// Matrices are column-major 4x4 (three.js Matrix4.elements order).

export const SCENE_SCHEMA_VERSION = 1;
export const SCENE_FILE = 'scene.json';
export const SCENE_NAV_DIR = 'nav';
export const SCENE_BUILD_DIR = 'build';
/** Scene folder names: letters, digits, "_" and "-", 1-64 chars, no dots (so never "." / ".."). */
export const SCENE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const EULER_ORDER = 'XYZ';
export const APPLIED_ORDER =
  'scale, then rotate, then translate, about the world origin (three.js Object3D: M = T * R * S, column vectors)';
/** Source formats a scene can reference (build-lod inputs that the viewer can also preview unpaged). */
export const SOURCE_EXTS = ['.ply', '.sog', '.spz', '.splat', '.ksplat'];

/** @typedef {[number, number, number]} Vec3 */
/** @typedef {[number, number, number, number]} Quat */

/**
 * @typedef {object} SceneTransform
 * @property {Vec3} position
 * @property {Vec3} rotationDeg  Euler degrees, order XYZ. For people; quaternion wins.
 * @property {'XYZ'} eulerOrder
 * @property {Quat} quaternion  [x, y, z, w], authoritative rotation
 * @property {number} scale  uniform scale (> 0)
 * @property {number[]} matrix  column-major 4x4 = T * R * S
 * @property {string} [appliedOrder]
 */

/**
 * @typedef {object} SceneBuild  Describes what is in scenes/<name>/build/ (last successful build).
 * @property {'ok'} status
 * @property {number[]} transformMatrix  scene transform baked into the .rad (column-major)
 * @property {string} radFile  file name inside build/, e.g. "oculus-lod.rad"
 * @property {string} source  source path used
 * @property {string} [startedAt]
 * @property {string} finishedAt
 * @property {number} [wallClockSeconds]
 * @property {{ input: number|null, final: number|null }} [splatCount]
 * @property {{ bboxMin: Vec3, bboxMax: Vec3 } | null} [bounds]  bbox of the transformed build input
 * @property {string[]} buildLodFlags
 * @property {string|null} [sparkTag]
 * @property {number} [chunkCount]
 * @property {number} [totalBytes]
 */

/**
 * @typedef {object} SceneBuildAttempt  The most recent build attempt (ok or failed).
 * @property {'ok'|'failed'} status
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {string|null} error
 */

/**
 * @typedef {object} SceneCamera
 * @property {Vec3} position
 * @property {Vec3} target
 * @property {number} [fov]
 */

/**
 * @typedef {object} SceneDoc
 * @property {1} schemaVersion
 * @property {string} name
 * @property {string} source  repo-relative path of the original source (never modified)
 * @property {SceneTransform} transform
 * @property {number|null} floorY  floor height in scene (aligned) coordinates
 * @property {Record<string, any>} navigation  v1 navigation block; `collision` is relative to the scene folder
 * @property {SceneCamera|null} camera  start viewpoint
 * @property {number[]|null} navTransformMatrix  scene transform when nav assets were last authored
 * @property {{ extraFlags?: string[] }} buildOptions
 * @property {SceneBuild|null} build
 * @property {SceneBuildAttempt|null} buildAttempt
 * @property {any[]} hotspots
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 */

export const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum);

export function isValidSceneName(name) {
  return typeof name === 'string' && SCENE_NAME_RE.test(name);
}

// --- 4x4 maths (column-major) ----------------------------------------------

/** a * b (apply b first, then a). */
export function mat4Multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** General 4x4 inverse (three.js Matrix4.invert formula). Throws on a singular matrix. */
export function mat4Invert(m) {
  const [n11, n21, n31, n41, n12, n22, n32, n42, n13, n23, n33, n43, n14, n24, n34, n44] = m;
  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (det === 0 || !Number.isFinite(det)) throw new Error('matrix is not invertible');
  const d = 1 / det;
  return [
    t11 * d,
    (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * d,
    (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * d,
    (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * d,
    t12 * d,
    (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * d,
    (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * d,
    (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * d,
    t13 * d,
    (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * d,
    (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * d,
    (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * d,
    t14 * d,
    (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * d,
    (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * d,
    (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * d,
  ];
}

/** Apply to a point (w = 1). */
export function mat4ApplyPoint(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** T * R(q) * S(s) for a uniform scale. Same formula as pipeline/lib/transform.mjs composeMatrix. */
export function composeTRS(position, quaternion, scale) {
  const [x, y, z, w] = quaternion;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const s = scale;
  return [
    (1 - (yy + zz)) * s, (xy + wz) * s, (xz - wy) * s, 0,
    (xy - wz) * s, (1 - (xx + zz)) * s, (yz + wx) * s, 0,
    (xz + wy) * s, (yz - wx) * s, (1 - (xx + yy)) * s, 0,
    position[0], position[1], position[2], 1,
  ];
}

/** Rotation matrix (column-major 4x4, upper 3x3 orthonormal) -> quaternion (three.js setFromRotationMatrix). */
function quatFromRotation(te) {
  const m11 = te[0], m12 = te[4], m13 = te[8];
  const m21 = te[1], m22 = te[5], m23 = te[9];
  const m31 = te[2], m32 = te[6], m33 = te[10];
  const trace = m11 + m22 + m33;
  let q;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  } else if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  } else if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
    q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
  }
  const n = Math.hypot(...q);
  // Canonical sign: w >= 0 (q and -q are the same rotation).
  const sign = q[3] < 0 ? -1 : 1;
  return q.map((v) => (v / n) * sign);
}

/**
 * Decompose a similarity matrix (uniform scale, rotation, translation) into TRS.
 * Throws if the matrix has a projective row, a reflection or non-uniform scale.
 * @returns {{ position: Vec3, quaternion: Quat, scale: number }}
 */
export function decomposeTRS(m, tol = 1e-6) {
  if (!isVec(m, 16)) throw new Error('matrix must be 16 finite numbers');
  if (Math.abs(m[3]) > tol || Math.abs(m[7]) > tol || Math.abs(m[11]) > tol || Math.abs(m[15] - 1) > tol) {
    throw new Error('matrix is not affine');
  }
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const s = (sx + sy + sz) / 3;
  if (!(s > 0) || Math.abs(sx - s) > tol * s || Math.abs(sy - s) > tol * s || Math.abs(sz - s) > tol * s) {
    throw new Error(`matrix has non-uniform scale (${sx}, ${sy}, ${sz})`);
  }
  const r = m.map((v, i) => (i < 11 && i % 4 !== 3 ? v / s : v));
  const det =
    r[0] * (r[5] * r[10] - r[9] * r[6]) - r[4] * (r[1] * r[10] - r[9] * r[2]) + r[8] * (r[1] * r[6] - r[5] * r[2]);
  if (det < 0) throw new Error('matrix contains a reflection');
  return { position: [m[12], m[13], m[14]], quaternion: quatFromRotation(r), scale: s };
}

/** Largest absolute element difference, scaled by the translation magnitude (>= 1). */
export function matricesEqual(a, b, tol = 1e-9) {
  if (!isVec(a, 16) || !isVec(b, 16)) return false;
  const mag = Math.max(1, ...[12, 13, 14].map((i) => Math.abs(a[i])), ...[0, 5, 10].map((i) => Math.abs(a[i])));
  for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > tol * mag) return false;
  return true;
}

export function isIdentityMatrix(m, tol = 1e-12) {
  return matricesEqual(m, IDENTITY, tol);
}

/**
 * Matrix to show a mesh with so it appears with the scene transform:
 *   built .rad (already holds T_built):  D = T_new * T_built^-1
 *   source file (raw coordinates):       T_new
 */
export function deltaMatrix(newMatrix, builtMatrix) {
  return mat4Multiply(newMatrix, mat4Invert(builtMatrix));
}

// --- transform blocks -------------------------------------------------------

/** Round away float noise (1e-17, 89.99999999999999) without visibly changing values. */
const clean = (v) => {
  const r = Math.round(v * 1e9) / 1e9;
  const out = Math.abs(r - v) < 1e-12 ? r : v;
  return Object.is(out, -0) ? 0 : out;
};

/** Quaternion -> three.js Euler 'XYZ' in degrees. */
export function quatToEulerXYZDeg(q) {
  const m = composeTRS([0, 0, 0], q, 1);
  const m11 = m[0], m12 = m[4], m13 = m[8];
  const m22 = m[5], m23 = m[9];
  const m32 = m[6], m33 = m[10];
  const y = Math.asin(Math.max(-1, Math.min(1, m13)));
  let x, z;
  if (Math.abs(m13) < 0.9999999) {
    x = Math.atan2(-m23, m33);
    z = Math.atan2(-m12, m11);
  } else {
    x = Math.atan2(m32, m22);
    z = 0;
  }
  const d = 180 / Math.PI;
  return [x * d, y * d, z * d];
}

/**
 * Full transform block (v1 Align fields) from TRS.
 * @returns {SceneTransform}
 */
export function transformFromTRS({ position, quaternion, scale }) {
  if (!isVec(position, 3)) throw new Error('position must be [x, y, z]');
  if (!isVec(quaternion, 4)) throw new Error('quaternion must be [x, y, z, w]');
  if (!isNum(scale) || scale <= 0) throw new Error('scale must be a positive number');
  const n = Math.hypot(...quaternion);
  if (n < 1e-9) throw new Error('quaternion has zero length');
  const q = /** @type {Quat} */ (quaternion.map((v) => v / n));
  return {
    position: /** @type {Vec3} */ ([...position]),
    rotationDeg: /** @type {Vec3} */ (quatToEulerXYZDeg(q).map(clean)),
    eulerOrder: EULER_ORDER,
    quaternion: q,
    scale,
    matrix: composeTRS(position, q, scale),
    appliedOrder: APPLIED_ORDER,
  };
}

/** Full transform block from a similarity matrix (column-major). */
export function transformFromMatrix(m) {
  return transformFromTRS(decomposeTRS(m));
}

export function identityTransform() {
  return transformFromTRS({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 });
}

/**
 * Validate a transform block (scene.transform or a v1 Align JSON) and return a clean full block.
 * position/quaternion/scale are authoritative; a `matrix` that disagrees is an error.
 * @returns {SceneTransform}
 */
export function normalizeTransform(t) {
  if (!t || typeof t !== 'object') throw new Error('transform must be an object');
  const out = transformFromTRS({ position: t.position, quaternion: t.quaternion, scale: t.scale });
  if (t.matrix !== undefined) {
    if (!isVec(t.matrix, 16)) throw new Error('transform.matrix must be 16 numbers (column-major)');
    if (!matricesEqual(out.matrix, t.matrix, 1e-6)) {
      throw new Error('transform.matrix disagrees with position/quaternion/scale (file edited inconsistently)');
    }
  }
  return out;
}

/** Compose transforms applied in order (first element applied first): M = Mn * ... * M2 * M1. */
export function composeTransforms(list) {
  let m = [...IDENTITY];
  for (const t of list) m = mat4Multiply(normalizeTransform(t).matrix, m);
  return transformFromMatrix(m);
}

// --- paths ------------------------------------------------------------------

/**
 * Validate a path relative to the scene folder (e.g. navigation.collision = "nav/collision.glb").
 * Forward slashes only, no "..", no absolute or drive paths, no leading dot segments.
 */
export function isSafeSceneRelPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 200) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes(':')) return false;
  return p.split('/').every((seg) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(seg) && !seg.includes('..'));
}

/** Validate a repo-relative source path ("assets/source_ply/x.ply"). */
export function isSafeSourcePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 300) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes(':')) return false;
  const segs = p.split('/');
  if (!segs.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && !seg.startsWith('.'))) return false;
  const lower = p.toLowerCase();
  return SOURCE_EXTS.some((e) => lower.endsWith(e));
}

// --- scene documents --------------------------------------------------------

/**
 * New scene document.
 * @param {{ name: string, source: string, transform?: object, now?: string }} o
 * @returns {SceneDoc}
 */
export function createScene({ name, source, transform, now = new Date().toISOString() }) {
  if (!isValidSceneName(name)) throw new Error(`invalid scene name "${name}" (letters, digits, _ and -, max 64)`);
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    name,
    source,
    transform: transform ? normalizeTransform(transform) : identityTransform(),
    floorY: null,
    navigation: {},
    camera: null,
    navTransformMatrix: null,
    buildOptions: {},
    build: null,
    buildAttempt: null,
    hotspots: [],
    createdAt: now,
    updatedAt: now,
  };
}

const RESERVED_EXTRA = [/^--rad$/, /^--rad-chunked$/, /^--spz(-chunked)?$/, /^--unlod$/, /^--quick$/, /^--tiny-lod/, /^--max-sh=/];

/**
 * Validate and normalise a parsed scene.json. Unknown top-level keys are kept
 * (forward compatibility). Never throws; check `errors`.
 * @returns {{ scene: SceneDoc|null, errors: string[], warnings: string[] }}
 */
export function validateScene(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { scene: null, errors: ['scene.json must be an object'], warnings };
  if (raw.schemaVersion !== SCENE_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)} (expected ${SCENE_SCHEMA_VERSION})`);
  }
  if (!isValidSceneName(raw.name)) errors.push(`invalid name ${JSON.stringify(raw.name)}`);
  if (typeof raw.source !== 'string' || !raw.source) errors.push('"source" must be a path');
  let transform = null;
  try {
    transform = normalizeTransform(raw.transform ?? identityTransform());
  } catch (e) {
    errors.push(`transform: ${e.message}`);
  }
  const floorY = raw.floorY === undefined || raw.floorY === null ? null : raw.floorY;
  if (floorY !== null && !isNum(floorY)) errors.push('"floorY" must be a number or null');

  const navigation = raw.navigation ?? {};
  if (typeof navigation !== 'object' || Array.isArray(navigation)) errors.push('"navigation" must be an object');
  else if (navigation.collision !== undefined && navigation.collision !== null && !isSafeSceneRelPath(navigation.collision)) {
    errors.push(`navigation.collision must be a path inside the scene folder (e.g. "nav/collision.glb"), got ${JSON.stringify(navigation.collision)}`);
  }
  if (navigation?.spawn !== undefined && navigation.spawn !== null && !isVec(navigation.spawn?.position, 3)) {
    errors.push('navigation.spawn.position must be [x, y, z]');
  }

  let camera = raw.camera ?? null;
  if (camera !== null && (!isVec(camera.position, 3) || !isVec(camera.target, 3) || (camera.fov !== undefined && !isNum(camera.fov)))) {
    errors.push('"camera" must be { position: [x,y,z], target: [x,y,z], fov? } or null');
    camera = null;
  }
  const navTransformMatrix = raw.navTransformMatrix ?? null;
  if (navTransformMatrix !== null && !isVec(navTransformMatrix, 16)) errors.push('"navTransformMatrix" must be 16 numbers or null');

  const buildOptions = raw.buildOptions ?? {};
  if (buildOptions.extraFlags !== undefined) {
    if (!Array.isArray(buildOptions.extraFlags) || !buildOptions.extraFlags.every((f) => typeof f === 'string' && /^--[a-z][a-z0-9-]*(=[A-Za-z0-9.,_-]*)?$/.test(f))) {
      errors.push('buildOptions.extraFlags must be build-lod flags like "--within-dist=0,0,0,40"');
    } else {
      for (const f of buildOptions.extraFlags) if (RESERVED_EXTRA.some((re) => re.test(f))) errors.push(`buildOptions.extraFlags: ${f} conflicts with the fixed scope flags`);
    }
  }

  const build = raw.build ?? null;
  if (build !== null) {
    if (!isVec(build.transformMatrix, 16)) errors.push('build.transformMatrix must be 16 numbers');
    if (typeof build.radFile !== 'string' || !isSafeSceneRelPath(build.radFile) || build.radFile.includes('/')) errors.push('build.radFile must be a file name');
  }
  const hotspots = raw.hotspots ?? [];
  if (!Array.isArray(hotspots)) errors.push('"hotspots" must be an array');

  if (errors.length) return { scene: null, errors, warnings };
  /** @type {SceneDoc} */
  const scene = {
    ...raw,
    schemaVersion: SCENE_SCHEMA_VERSION,
    name: raw.name,
    source: raw.source,
    transform: /** @type {SceneTransform} */ (transform),
    floorY,
    navigation: { ...navigation },
    camera,
    navTransformMatrix,
    buildOptions: { ...buildOptions },
    build,
    buildAttempt: raw.buildAttempt ?? null,
    hotspots,
  };
  if (scene.navigation.collision === null) delete scene.navigation.collision;
  return { scene, errors, warnings };
}

/** True when the scene transform differs from the one baked into build/ (or there is no build). */
export function transformChangedSinceBuild(scene) {
  if (!scene.build) return false;
  return !matricesEqual(scene.transform.matrix, scene.build.transformMatrix);
}

/** True when the scene has nav assets (floor, collision, spawn, plan exports...). */
export function hasNavAssets(scene, navFileCount = 0) {
  const n = scene.navigation ?? {};
  return scene.floorY !== null || !!n.collision || !!n.spawn || navFileCount > 0;
}

/**
 * Nav assets are authored in scene (aligned) coordinates. If the transform has
 * changed since they were authored they may no longer line up with the splats.
 */
export function navMayBeMisaligned(scene, navFileCount = 0) {
  if (!hasNavAssets(scene, navFileCount)) return false;
  const ref = scene.navTransformMatrix ?? scene.build?.transformMatrix ?? null;
  if (!ref) return false;
  return !matricesEqual(scene.transform.matrix, ref);
}

/**
 * How the viewer should show the scene and with which mesh matrix.
 * @returns {{ mode: 'built'|'source', matrix: number[] }}
 */
export function previewPlan(scene, { builtAvailable = !!scene.build } = {}) {
  if (builtAvailable && scene.build) {
    return { mode: 'built', matrix: deltaMatrix(scene.transform.matrix, scene.build.transformMatrix) };
  }
  return { mode: 'source', matrix: [...scene.transform.matrix] };
}

/** Serialise with stable formatting (2-space JSON + newline). */
export function stringifyScene(scene) {
  return JSON.stringify(scene, null, 2) + '\n';
}
