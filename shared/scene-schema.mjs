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
// is always relative to the ORIGINAL source files; rebuilds start from the sources.
// Matrices are column-major 4x4 (three.js Matrix4.elements order).
//
// Schema 2: a scene is made of PARTS (`parts: [{ id, source, label?, enabled }]`),
// e.g. the spatial parts a scan was trained in (Spirula Studio). Every part is
// in the same source coordinate frame, so ONE scene transform applies to all of
// them identically. Each part is built to its own .rad (build/<partId>/...),
// one build-lod process at a time, and streamed as its own paged SplatMesh.
// Schema 1 files (single `source`) are migrated on read (migrateScene): the
// source becomes `parts: [{ id: "main", source }]` and the v1 build record
// becomes that part's build. Files are only rewritten when saved or built.
//
// Partition crop (optional): `partition` names a Spirula partition.json and a
// part's `partitionPart` is the partition part it was trained for. Such a part
// is cropped to its own region before the build (splats whose nearest partition
// point has another label are dropped): a Spirula part also reconstructs the
// other parts' regions at low detail, which blurs them when parts are overlaid.
// Region-of-interest crop (optional): the scene's `roi` names a Spirula ROI
// region file (a part's own `roi` overrides it) and a part's `roiOutlines` the
// outlines saved in it that the part was trained on; only splats inside their
// union are built. A part with its own `roi` and no outlines uses the file's
// top-level region; a part with no outlines and no own `roi` is not cropped.
// (`roiOutline`, a single name, is read as `roiOutlines: [name]`.) Both crops
// can apply to one part (a splat must pass both).

export const SCENE_SCHEMA_VERSION = 2;
/** Part id given to the single source of a migrated schema-1 scene. */
export const DEFAULT_PART_ID = 'main';
/** Part ids: letters, digits, "_" and "-", 1-48 chars (they become folder names under build/). */
export const PART_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
/**
 * Unbuilt preview loads source files WHOLE into the browser (no LoD paging).
 * Above this total the viewer does not auto-load them (configurable in the viewer).
 */
export const PREVIEW_SOURCE_CAP_BYTES = 3e9;
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
 * @typedef {object} ScenePart  One source file of the scene.
 * @property {string} id  unique in the scene (PART_ID_RE); build output goes to build/<id>/
 * @property {string} source  repo-relative path of the original source (never modified)
 * @property {string} [label]  free text for people
 * @property {boolean} enabled  disabled parts are neither built nor shown
 * @property {number} [partitionPart]  partition part (label) this source was trained for; cropped to it when the scene has a `partition`
 * @property {string} [roi]  repo-relative Spirula ROI region file for this part (default: the scene's `roi`)
 * @property {string[]} [roiOutlines]  outlines of that file this part was trained on; only splats inside their union are built
 */

/**
 * @typedef {object} PartCrop  Crop applied before a part's build (partition part and/or ROI).
 * @property {string} [partition]  repo-relative partition.json
 * @property {number} [part]  partition part (label) kept
 * @property {string} [roi]  repo-relative ROI region file
 * @property {string[]} [roiOutlines]  outlines of that file, sorted (absent: its top-level region)
 * @property {number} [partitionBytes]  partition.bin size when built (incremental builds compare it)
 * @property {string} [roiDigest]  hash of the region geometry when built (incremental builds compare it)
 * @property {number} [keptSplats]
 * @property {number} [droppedSplats]
 * @property {number} [seconds]
 */

/**
 * @typedef {object} ScenePartBuild  What build/ holds for one part.
 * @property {string} id
 * @property {'ok'} status
 * @property {string} radFile  path inside build/, e.g. "p0/oculus-p0-lod.rad" (schema-1 builds: "oculus-lod.rad")
 * @property {number[]} transformMatrix  scene transform baked into this part's .rad
 * @property {string} source
 * @property {number} [sourceBytes]  source size when built (incremental builds compare it)
 * @property {string} [sourceModified]  source mtime (ISO) when built
 * @property {string[]} buildLodFlags
 * @property {string|null} [sparkTag]
 * @property {string} [startedAt]
 * @property {string} [finishedAt]
 * @property {number} [wallClockSeconds]
 * @property {number|null} [peakMemoryBytes]  build-lod peak working set
 * @property {{ input: number|null, final: number|null }} [splatCount]
 * @property {{ bboxMin: Vec3, bboxMax: Vec3 } | null} [bounds]  bbox of the transformed build input
 * @property {number} [chunkCount]
 * @property {number} [totalBytes]
 * @property {object|null} [transformStep]
 * @property {PartCrop|null} [crop]  crop applied to the source before the transform (null: none)
 * @property {string} [reusedFrom]  set when an incremental build carried this output over unchanged (finishedAt of the build that made it)
 */

/**
 * @typedef {object} SceneBuild  Describes what is in scenes/<name>/build/ (last successful build).
 * @property {'ok'|'partial'} status  partial: some enabled parts have no output or an outdated transform
 * @property {number[]} transformMatrix  scene transform the build was made for (column-major)
 * @property {ScenePartBuild[]} parts  one entry per part that has output in build/
 * @property {string} [startedAt]
 * @property {string} finishedAt
 * @property {number} [wallClockSeconds]
 * @property {{ input: number|null, final: number|null }} [splatCount]  sums over parts
 * @property {{ bboxMin: Vec3, bboxMax: Vec3 } | null} [bounds]  union over parts
 * @property {string[]} buildLodFlags
 * @property {string|null} [sparkTag]
 * @property {number} [chunkCount]
 * @property {number} [totalBytes]
 * @property {number|null} [peakMemoryBytes]  max over the parts built in this run
 */

/**
 * @typedef {object} SceneBuildAttempt  The most recent build attempt (ok or failed).
 * @property {'ok'|'failed'} status
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {string|null} error
 * @property {{ id: string, status: string, error?: string|null, seconds?: number, peakMemoryBytes?: number|null }[]} [parts]
 */

/**
 * @typedef {object} SceneCamera
 * @property {Vec3} position
 * @property {Vec3} target
 * @property {number} [fov]
 */

/**
 * @typedef {object} SceneDoc
 * @property {2} schemaVersion
 * @property {string} name
 * @property {ScenePart[]} parts  source files (all in one coordinate frame)
 * @property {string|null} [partition]  repo-relative Spirula partition.json; parts with a `partitionPart` are cropped to it
 * @property {string|null} [roi]  repo-relative Spirula ROI region file whose outlines parts pick in `roiOutlines`
 * @property {SceneTransform} transform  applies identically to every part
 * @property {number|null} floorY  floor height in scene (aligned) coordinates
 * @property {Record<string, any>} navigation  v1 navigation block; `collision` is relative to the scene folder
 * @property {SceneCamera|null} camera  start viewpoint
 * @property {number[]|null} navTransformMatrix  scene transform when nav assets were last authored
 * @property {{ extraFlags?: string[], maxSh?: number }} buildOptions  maxSh: SH degree build-lod keeps (default 1; Spirula trains 3)
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

/** Folder region files are copied to: assets/roi/<scene>/<file>.json. */
export const ROI_DIR = 'assets/roi';

/** Validate a region file path as the editor writes it: assets/roi/<scene>/<file>.json. */
export function isSafeRoiPath(p) {
  if (typeof p !== 'string' || p.length > 300) return false;
  const segs = p.split('/');
  return segs.length === 4 && `${segs[0]}/${segs[1]}` === ROI_DIR && isValidSceneName(segs[2]) && /^[A-Za-z0-9_-][A-Za-z0-9._ -]{0,99}\.json$/.test(segs[3]) && !segs[3].includes('..');
}

// --- parts ------------------------------------------------------------------

export function isValidPartId(id) {
  return typeof id === 'string' && PART_ID_RE.test(id);
}

/** File name of a repo-relative path ("assets/source_ply/a.ply" -> "a.ply"). */
export function sourceFileName(source) {
  const s = String(source);
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
}

/**
 * A part id derived from the source file name ("parts/OculusV1/part0.ply" -> "part0"),
 * made unique against `taken` (lower-case ids) by appending _2, _3, ...
 */
export function partIdFromSource(source, taken = new Set()) {
  let base = sourceFileName(source)
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[_-]+/, '')
    .slice(0, 40);
  if (!base) base = 'part';
  let id = base;
  for (let i = 2; taken.has(id.toLowerCase()); i++) id = `${base}_${i}`;
  return id;
}

/** Parts for a list of sources (ids from the file names, all enabled). */
export function partsFromSources(sources) {
  const taken = new Set();
  return sources.map((source) => {
    const id = partIdFromSource(source, taken);
    taken.add(id.toLowerCase());
    return { id, source, enabled: true };
  });
}

/** @returns {ScenePart[]} */
export function enabledParts(scene) {
  return (scene.parts ?? []).filter((p) => p.enabled !== false);
}

/** The build record of one part, or null. @returns {ScenePartBuild|null} */
export function partBuild(scene, id) {
  return scene.build?.parts?.find((b) => b.id === id) ?? null;
}

/**
 * Build state of one part, for lists and badges:
 *   disabled   part is switched off (not built, not shown)
 *   not-built  no output in build/
 *   outdated   built, but with a different scene transform, source file or partition crop
 *   built      up to date as far as scene.json can tell (the pipeline also checks the source's size/mtime)
 * @returns {'disabled'|'not-built'|'outdated'|'built'}
 */
export function partState(scene, part) {
  if (part.enabled === false) return 'disabled';
  const b = partBuild(scene, part.id);
  if (!b) return 'not-built';
  if (b.source !== part.source || !matricesEqual(scene.transform.matrix, b.transformMatrix)) return 'outdated';
  if (!sameCrop(partCrop(scene, part), b.crop ?? null)) return 'outdated';
  return 'built';
}

/** Outline names sorted naturally ("Outline 2" before "Outline 10"), duplicates removed. */
export function sortOutlines(names) {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** A part's (or crop record's) outlines; the single-name `roiOutline` of older files counts as one. */
export function outlinesOf(x) {
  if (Array.isArray(x?.roiOutlines)) return sortOutlines(x.roiOutlines);
  return typeof x?.roiOutline === 'string' && x.roiOutline ? [x.roiOutline] : [];
}

/**
 * The crop a part's build should apply: { partition, part } when the scene has
 * a partition and the part a partitionPart; { roi, roiOutlines? } when the part
 * has outlines (in its own `roi` or the scene's) or its own `roi` (top-level
 * region); both; or null.
 * @returns {{ partition?: string, part?: number, roi?: string, roiOutlines?: string[] } | null}
 */
export function partCrop(scene, part) {
  const c = {};
  if (scene.partition && Number.isInteger(part.partitionPart)) {
    c.partition = scene.partition;
    c.part = part.partitionPart;
  }
  const file = part.roi || scene.roi || null;
  const outlines = outlinesOf(part);
  if (file && (part.roi || outlines.length)) {
    c.roi = file;
    if (outlines.length) c.roiOutlines = outlines;
  }
  return Object.keys(c).length ? c : null;
}

/** Same partition file, partition part, ROI file and outlines (other recorded fields are ignored). */
export function sameCrop(a, b) {
  if (!a || !b) return !a && !b;
  return ['partition', 'part', 'roi'].every((k) => (a[k] ?? null) === (b[k] ?? null)) && outlinesOf(a).join('\n') === outlinesOf(b).join('\n');
}

// --- scene documents --------------------------------------------------------

/**
 * New scene document. Pass `sources` (one part per file) or `parts`; `source` is
 * the single-file shorthand.
 * @param {{ name: string, source?: string, sources?: string[], parts?: ScenePart[], transform?: object, now?: string }} o
 * @returns {SceneDoc}
 */
export function createScene({ name, source, sources, parts, transform, now = new Date().toISOString() }) {
  if (!isValidSceneName(name)) throw new Error(`invalid scene name "${name}" (letters, digits, _ and -, max 64)`);
  const list = parts
    ? parts.map((p) => ({ ...p, enabled: p.enabled !== false }))
    : partsFromSources(sources ?? (source !== undefined ? [source] : []));
  if (list.length === 0) throw new Error('a scene needs at least one source');
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    name,
    parts: list,
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
  if (raw.schemaVersion === 1) {
    raw = migrateScene(raw);
    warnings.push('schema 1 scene migrated to schema 2 in memory (written as schema 2 on the next save or build)');
  }
  if (raw.schemaVersion !== SCENE_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)} (expected 1 or ${SCENE_SCHEMA_VERSION})`);
  }
  if (!isValidSceneName(raw.name)) errors.push(`invalid name ${JSON.stringify(raw.name)}`);
  let parts = [];
  if (!Array.isArray(raw.parts) || raw.parts.length === 0) errors.push('"parts" must be a non-empty array of { id, source, enabled }');
  else {
    const seen = new Set();
    raw.parts.forEach((p, i) => {
      if (!p || typeof p !== 'object') return void errors.push(`parts[${i}] must be an object`);
      if (!isValidPartId(p.id)) errors.push(`parts[${i}].id ${JSON.stringify(p.id)} is invalid (letters, digits, _ and -, max 48)`);
      else if (seen.has(p.id.toLowerCase())) errors.push(`parts[${i}].id "${p.id}" is used twice`);
      else seen.add(p.id.toLowerCase());
      if (typeof p.source !== 'string' || !p.source) errors.push(`parts[${i}].source must be a path`);
      if (p.enabled !== undefined && typeof p.enabled !== 'boolean') errors.push(`parts[${i}].enabled must be true or false`);
      if (p.label !== undefined && p.label !== null && (typeof p.label !== 'string' || p.label.length > 200)) errors.push(`parts[${i}].label must be a short string`);
      if (p.partitionPart !== undefined && p.partitionPart !== null && !(Number.isInteger(p.partitionPart) && p.partitionPart >= 0 && p.partitionPart < 255)) {
        errors.push(`parts[${i}].partitionPart must be a partition part number (0..254) or null`);
      }
      if (p.roi !== undefined && p.roi !== null && (typeof p.roi !== 'string' || !p.roi.toLowerCase().endsWith('.json'))) {
        errors.push(`parts[${i}].roi must be the path of a Spirula ROI region .json or null`);
      }
      if (p.roiOutline !== undefined && p.roiOutline !== null && (typeof p.roiOutline !== 'string' || !p.roiOutline || p.roiOutline.length > 200)) {
        errors.push(`parts[${i}].roiOutline must be an outline name or null`);
      }
      if (p.roiOutlines !== undefined && p.roiOutlines !== null
        && (!Array.isArray(p.roiOutlines) || p.roiOutlines.length > 64 || !p.roiOutlines.every((n) => typeof n === 'string' && n && n.length <= 200))) {
        errors.push(`parts[${i}].roiOutlines must be a list of outline names or null`);
      }
    });
    parts = raw.parts.map((p) => {
      const out = { ...p, enabled: p?.enabled !== false };
      if (out.label === null || out.label === '') delete out.label;
      if (out.partitionPart === null) delete out.partitionPart;
      if (out.roi === null || out.roi === '') delete out.roi;
      const outlines = outlinesOf(out);
      delete out.roiOutline;
      if (outlines.length) out.roiOutlines = outlines;
      else delete out.roiOutlines;
      return out;
    });
    if (!errors.length && parts.every((p) => !p.enabled)) warnings.push('every part is disabled');
  }
  const partition = raw.partition ?? null;
  if (partition !== null && (typeof partition !== 'string' || !partition.toLowerCase().endsWith('.json'))) {
    errors.push('"partition" must be the path of a Spirula partition.json or null');
  } else if (partition === null && parts.some((p) => Number.isInteger(p.partitionPart))) {
    warnings.push('parts have a partitionPart but the scene has no "partition": they are built uncropped');
  }
  const roi = raw.roi ?? null;
  if (roi !== null && (typeof roi !== 'string' || !roi.toLowerCase().endsWith('.json'))) {
    errors.push('"roi" must be the path of a Spirula ROI region .json or null');
  } else if (roi === null && parts.some((p) => !p.roi && outlinesOf(p).length)) {
    warnings.push('parts have roiOutlines but neither they nor the scene have a "roi" file: they are built uncropped');
  }
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
      for (const f of buildOptions.extraFlags) if (RESERVED_EXTRA.some((re) => re.test(f))) errors.push(`buildOptions.extraFlags: ${f} conflicts with the fixed scope flags (set buildOptions.maxSh for the SH degree)`);
    }
  }
  if (buildOptions.maxSh !== undefined && !(Number.isInteger(buildOptions.maxSh) && buildOptions.maxSh >= 0 && buildOptions.maxSh <= 3)) {
    errors.push('buildOptions.maxSh must be 0, 1, 2 or 3 (spherical-harmonics degree kept by build-lod)');
  }

  const build = raw.build ?? null;
  if (build !== null) {
    if (typeof build !== 'object' || Array.isArray(build)) errors.push('"build" must be an object or null');
    else {
      if (!isVec(build.transformMatrix, 16)) errors.push('build.transformMatrix must be 16 numbers');
      if (!Array.isArray(build.parts)) errors.push('build.parts must be an array');
      else {
        build.parts.forEach((b, i) => {
          if (!b || !isValidPartId(b.id)) return void errors.push(`build.parts[${i}].id is invalid`);
          if (typeof b.radFile !== 'string' || !isSafeSceneRelPath(b.radFile) || !b.radFile.endsWith('.rad')) errors.push(`build.parts[${i}].radFile must be a .rad path inside build/`);
          if (!isVec(b.transformMatrix, 16)) errors.push(`build.parts[${i}].transformMatrix must be 16 numbers`);
        });
      }
    }
  }
  const hotspots = raw.hotspots ?? [];
  if (!Array.isArray(hotspots)) errors.push('"hotspots" must be an array');

  if (errors.length) return { scene: null, errors, warnings };
  const { source: _legacySource, ...rest } = raw;
  /** @type {SceneDoc} */
  const scene = {
    ...rest,
    schemaVersion: SCENE_SCHEMA_VERSION,
    name: raw.name,
    parts,
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

/**
 * Schema 1 -> 2 (pure; returns a new object). `source` becomes the single part
 * "main"; a v1 build record (radFile directly in build/) becomes that part's build.
 * Other fields are kept as they are.
 */
export function migrateScene(raw) {
  if (!raw || raw.schemaVersion !== 1) return raw;
  const { source, build, ...rest } = raw;
  const out = { ...rest, schemaVersion: SCENE_SCHEMA_VERSION, parts: [{ id: DEFAULT_PART_ID, source, enabled: true }] };
  if (build && typeof build === 'object') {
    const partFields = [
      'radFile', 'transformMatrix', 'source', 'sourceBytes', 'sourceModified', 'buildLodFlags', 'sparkTag', 'startedAt',
      'finishedAt', 'wallClockSeconds', 'peakMemoryBytes', 'splatCount', 'bounds', 'chunkCount', 'totalBytes', 'transformStep',
    ];
    const part = { id: DEFAULT_PART_ID, status: 'ok' };
    for (const k of partFields) if (build[k] !== undefined) part[k] = build[k];
    part.source ??= source;
    const { radFile: _r, source: _s, sourceBytes: _b, sourceModified: _m, transformStep: _t, ...top } = build;
    out.build = { ...top, status: 'ok', parts: [part] };
  } else {
    out.build = build ?? null;
  }
  return out;
}

/** True when the transform differs from the one baked into any enabled part's build (false when nothing is built). */
export function transformChangedSinceBuild(scene) {
  if (!scene.build) return false;
  if (!matricesEqual(scene.transform.matrix, scene.build.transformMatrix)) return true;
  return enabledParts(scene).some((p) => {
    const b = partBuild(scene, p.id);
    return !!b && !matricesEqual(scene.transform.matrix, b.transformMatrix);
  });
}

/**
 * Per-part build summary for badges.
 * @returns {{ total: number, enabled: number, built: number, outdated: number, notBuilt: number, complete: boolean }}
 */
export function buildSummary(scene) {
  const out = { total: scene.parts.length, enabled: 0, built: 0, outdated: 0, notBuilt: 0, complete: false };
  for (const p of scene.parts) {
    const s = partState(scene, p);
    if (s === 'disabled') continue;
    out.enabled++;
    if (s === 'built') out.built++;
    else if (s === 'outdated') out.outdated++;
    else out.notBuilt++;
  }
  out.complete = out.enabled > 0 && out.built === out.enabled;
  return out;
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
 * @typedef {object} PartLoad  How the viewer shows one part.
 * @property {string} id
 * @property {string} source
 * @property {string} [label]
 * @property {'built'|'source'|'blocked'|'missing'|'disabled'} mode
 *   built: stream build/<radFile> (paged); source: load the source whole (unbuilt preview);
 *   blocked: unbuilt and over the preview size cap; missing: no build and no source; disabled: switched off
 * @property {string|null} radFile  path inside build/ (mode built)
 * @property {number[]|null} loadedMatrix  transform baked into what is loaded (null = raw source coordinates)
 * @property {number[]} localMatrix  matrix of the part's mesh inside the scene root (identity in the normal case)
 * @property {number|null} sourceBytes
 * @property {'disabled'|'not-built'|'outdated'|'built'} state
 */

/**
 * What the viewer loads for every part, and with which matrices. All part meshes
 * hang under one root object:
 *   root  = T_new * T_ref^-1   (T_ref: the build's transform when any part is shown built, else identity)
 *   child = T_ref * B_i^-1     (B_i: transform baked into what part i loads; identity for a raw source)
 * so root * child * p_loaded = T_new * p_source for every part, and the editor
 * (Align) only ever moves the root. Normally every built part has B_i = T_ref,
 * so the children are identity.
 *
 * Unbuilt parts preview their source loaded whole. When the enabled unbuilt
 * sources add up to more than `capBytes` they are 'blocked' (not auto-loaded),
 * except the parts listed in `previewParts` while those fit under the cap.
 *
 * @param {SceneDoc} scene
 * @param {{ builtOnDisk?: (id: string) => boolean, sourceBytes?: Record<string, number|null>, capBytes?: number, previewParts?: string[]|null }} [o]
 * @returns {{ refMatrix: number[]|null, rootMatrix: number[], parts: PartLoad[], unbuiltBytes: number, overCap: boolean }}
 */
export function loadPlan(scene, o = {}) {
  const builtOnDisk = o.builtOnDisk ?? ((id) => !!partBuild(scene, id));
  const bytesOf = (id) => {
    const v = o.sourceBytes ? o.sourceBytes[id] : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const cap = o.capBytes ?? PREVIEW_SOURCE_CAP_BYTES;
  const parts = scene.parts.map((p) => {
    const b = partBuild(scene, p.id);
    const state = partState(scene, p);
    const base = { id: p.id, source: p.source, ...(p.label && { label: p.label }), sourceBytes: bytesOf(p.id), state, radFile: null, loadedMatrix: null, localMatrix: [...IDENTITY] };
    if (state === 'disabled') return { ...base, mode: 'disabled' };
    if (b && b.source === p.source && builtOnDisk(p.id)) return { ...base, mode: 'built', radFile: b.radFile, loadedMatrix: [...b.transformMatrix] };
    // When the dev server reported sizes, a part without one has no source file.
    if (o.sourceBytes && base.sourceBytes === null) return { ...base, mode: 'missing' };
    return { ...base, mode: 'source' };
  });
  const unbuilt = parts.filter((p) => p.mode === 'source');
  const unbuiltBytes = unbuilt.reduce((s, p) => s + (p.sourceBytes ?? 0), 0);
  const overCap = unbuiltBytes > cap;
  if (overCap) {
    const wanted = new Set(o.previewParts ?? []);
    let used = 0;
    for (const p of unbuilt) {
      const size = p.sourceBytes ?? 0;
      if (wanted.has(p.id) && used + size <= cap) used += size;
      else p.mode = 'blocked';
    }
  }
  const built = parts.find((p) => p.mode === 'built');
  const refMatrix = built ? (scene.build?.transformMatrix ? [...scene.build.transformMatrix] : [...built.loadedMatrix]) : null;
  for (const p of parts) {
    if (p.mode !== 'built' && p.mode !== 'source') continue;
    const ref = refMatrix ?? IDENTITY;
    const local = p.loadedMatrix ? mat4Multiply(ref, mat4Invert(p.loadedMatrix)) : [...ref];
    p.localMatrix = isIdentityMatrix(local, 1e-12) ? [...IDENTITY] : local;
  }
  const rootMatrix = refMatrix ? deltaMatrix(scene.transform.matrix, refMatrix) : [...scene.transform.matrix];
  return { refMatrix, rootMatrix, parts, unbuiltBytes, overCap };
}

/**
 * Short form of loadPlan for the whole scene.
 * @returns {{ mode: 'built'|'source', matrix: number[] }}
 */
export function previewPlan(scene, { builtAvailable = !!scene.build } = {}) {
  const plan = loadPlan(scene, { builtOnDisk: (id) => builtAvailable && !!partBuild(scene, id) });
  return { mode: plan.refMatrix ? 'built' : 'source', matrix: plan.rootMatrix };
}

/** Serialise with stable formatting (2-space JSON + newline). */
export function stringifyScene(scene) {
  return JSON.stringify(scene, null, 2) + '\n';
}
