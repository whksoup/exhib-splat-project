// Spirula Studio region of interest (roi/<name>.json, as written by its ROI
// editor and passed to training as --roi-region) and a point-in-region test.
//
// By default the top-level region is read: what the ROI editor last compiled
// from its enabled outlines, either one "prism" or a "union" of them
// ({ type: "union", children: [prism, ...] }). The "editor" block also keeps
// every outline drawn in the file ({ name, kind, op, enabled, origin, rotation,
// lo, hi, polygon }); one file is often re-used for several trainings with
// different outlines enabled each time, so outlines can be picked by name
// instead (several names: their union). An outline "prism" spans local z
// lo[2]..hi[2] from its origin; it is converted to the top-level form (center
// at the middle of that span). A prism:
//   center       [x, y, z]  world position of the prism's local origin
//   rotation     9 numbers, row-major 3x3, assumed to map local -> world
//                (p_world = center + R p_local). Only near-identity rotations
//                have been seen, so the direction is unverified: a crop with a
//                clearly rotated region prints a warning.
//   half_height  the prism spans local z in [-half_height, +half_height]
//   polygon      flat [x0, y0, x1, y1, ...] outline in local x/y
// Anything else fails with a clear message instead of guessing. Coordinates are
// the training frame of the dataset, i.e. the frame of the exported .ply
// (Spirula's scene_transform.json is identity when centering is "none").
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(finite);

/** Names of the outlines kept in a region file's editor block. */
export function roiOutlines(json) {
  return (json?.editor?.shapes ?? []).map((s) => s?.name).filter((n) => typeof n === 'string');
}

/** One editor outline as a top-level prism ({ type, center, rotation, half_height, polygon }). */
function outlineRegion(json, outline, fail) {
  const shapes = (json?.editor?.shapes ?? []).filter((s) => s?.name === outline);
  if (shapes.length === 0) fail(`no outline named ${JSON.stringify(outline)} (outlines: ${roiOutlines(json).join(', ') || 'none'})`);
  if (shapes.length > 1) fail(`${shapes.length} outlines are named ${JSON.stringify(outline)}; rename them in the ROI editor`);
  const s = shapes[0];
  if (s.kind !== 'prism') fail(`outline ${JSON.stringify(outline)}: kind ${JSON.stringify(s.kind)} is not supported (only "prism" has been seen)`);
  if (s.op !== undefined && s.op !== 'add') fail(`outline ${JSON.stringify(outline)}: op ${JSON.stringify(s.op)} is not supported (only "add")`);
  if (!vec(s.origin, 3) || !vec(s.rotation, 9) || !vec(s.lo, 3) || !vec(s.hi, 3)) fail(`outline ${JSON.stringify(outline)}: origin, rotation, lo and hi must be numbers`);
  if (s.lo[0] !== 0 || s.lo[1] !== 0 || s.hi[0] !== 0 || s.hi[1] !== 0) fail(`outline ${JSON.stringify(outline)}: lo/hi with an x or y offset have not been seen`);
  const R = s.rotation;
  const mid = (s.lo[2] + s.hi[2]) / 2;
  return {
    type: 'prism',
    center: [0, 1, 2].map((i) => s.origin[i] + R[3 * i + 2] * mid), // origin + R (0, 0, mid)
    rotation: R,
    half_height: (s.hi[2] - s.lo[2]) / 2,
    polygon: s.polygon,
  };
}

/** Validate one prism; returns its geometry (for the digest) and a contains test. */
function prism(json, fail) {
  if (json?.type !== 'prism') fail(`region type ${JSON.stringify(json?.type)} is not supported (only "prism" and "union" have been seen)`);
  if (!vec(json.center, 3)) fail('"center" must be [x, y, z]');
  if (!vec(json.rotation, 9)) fail('"rotation" must be 9 numbers (row-major 3x3)');
  if (!finite(json.half_height) || json.half_height <= 0) fail('"half_height" must be a positive number');
  const P = json.polygon;
  if (!Array.isArray(P) || P.length < 6 || P.length % 2 !== 0 || !P.every(finite)) fail('"polygon" must be at least 3 x/y pairs');
  const R = json.rotation;
  // Orthonormal (rows unit length and orthogonal) with determinant +1.
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const dot = R[3 * i] * R[3 * j] + R[3 * i + 1] * R[3 * j + 1] + R[3 * i + 2] * R[3 * j + 2];
      if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-6) fail('"rotation" is not a rotation matrix');
    }
  }
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  if (det < 0) fail('"rotation" contains a reflection');
  const [cx, cy, cz] = json.center;
  const h = json.half_height;
  const n = P.length / 2;
  return {
    geometry: { type: 'prism', center: json.center, rotation: R, half_height: h, polygon: P },
    center: [...json.center],
    rotation: [...R],
    halfHeight: h,
    polygon: [...P],
    rotated: [0, 4, 8].some((i) => Math.abs(R[i] - 1) > 1e-3),
    contains(x, y, z) {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      // p_local = R^T (p - center)
      const lz = R[2] * dx + R[5] * dy + R[8] * dz;
      if (lz < -h || lz > h) return false;
      const lx = R[0] * dx + R[3] * dy + R[6] * dz;
      const ly = R[1] * dx + R[4] * dy + R[7] * dz;
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = P[2 * i], yi = P[2 * i + 1], xj = P[2 * j], yj = P[2 * j + 1];
        if ((yi > ly) !== (yj > ly) && lx < ((xj - xi) * (ly - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    },
  };
}

/**
 * Validate a parsed region and return it with a contains(x, y, z) test.
 * The single-prism fields (center, rotation, halfHeight, polygon) describe the first prism.
 * @param {object} json
 * @param {string} [name]  for error messages
 * @param {string|string[]|null} [outlines]  use these editor outlines (their union) instead of the top-level region
 * @returns {{ type: 'prism'|'union', prisms: object[], center: number[], rotation: number[], halfHeight: number, polygon: number[], digest: string, rotated: boolean, contains: (x: number, y: number, z: number) => boolean }}
 */
export function parseRoi(json, name = 'region', outlines = null) {
  const fail = (msg) => { throw new Error(`${name}: ${msg}`); };
  if (!json || typeof json !== 'object') fail('not a JSON object');
  const list = outlines === null || outlines === undefined ? [] : Array.isArray(outlines) ? outlines : [outlines];
  let shapes;
  if (list.length) {
    if (new Set(list).size !== list.length) fail('an outline is listed twice');
    shapes = list.map((o) => outlineRegion(json, o, fail));
  } else if (json.type === 'union') {
    if (!Array.isArray(json.children) || json.children.length === 0) fail('"union" needs a non-empty "children" list');
    shapes = json.children;
  } else {
    shapes = [json];
  }
  const prisms = shapes.map((s, i) => prism(s, shapes.length > 1 ? (msg) => fail(`prism ${i + 1}: ${msg}`) : fail));
  // Identifies the region itself; editor-only changes do not change it.
  const geometry = prisms.length === 1 ? prisms[0].geometry : prisms.map((p) => p.geometry);
  const first = prisms[0];
  return {
    type: prisms.length === 1 ? 'prism' : 'union',
    prisms,
    center: first.center,
    rotation: first.rotation,
    halfHeight: first.halfHeight,
    polygon: first.polygon,
    digest: crypto.createHash('sha256').update(JSON.stringify(geometry)).digest('hex').slice(0, 16),
    rotated: prisms.some((p) => p.rotated),
    contains: prisms.length === 1 ? first.contains : (x, y, z) => prisms.some((p) => p.contains(x, y, z)),
  };
}

/** Read a region file (parsed JSON). */
export function readRoiJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${path.basename(file)}: cannot read: ${e.message}`);
  }
}

/** Read and validate a region file: its top-level region, or the union of the editor outlines named in `outlines`. */
export function readRoi(file, outlines = null) {
  return parseRoi(readRoiJson(file), path.basename(file), outlines);
}
