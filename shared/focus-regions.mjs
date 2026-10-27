// Focus regions: named, tiered boxes drawn in the scene editor (Regions panel)
// that say where a model needs more (or less) detail. Stored in scene.json as
// `focusRegions`, in SCENE coordinates (the aligned frame the viewer shows, like
// `camera` and `navigation.spawn`), so they survive rebuilds and are shared by
// every scene with the same transform.
//
// Used by the viewer (drawing, picking) and the pipeline (focus-regions.mjs:
// splat counts per region, export as a Spirula --roi-region file).
//
//   region = { id, name, tier, center: [x,y,z], size: [sx,sy,sz], quaternion: [x,y,z,w] }
//
// `size` is the full box extent along its own axes; the box is rotated by
// `quaternion` about its centre. Pure: no DOM, no Node, no imports (scene-schema.mjs
// imports this file for validation).

/** Detail tiers, highest first. */
export const FOCUS_TIERS = /** @type {const} */ (['hero', 'high', 'low']);
export const FOCUS_TIER_INFO = {
  hero: { label: 'Hero', color: 0xff6b6b, note: 'artworks and text to see up close: the most detail' },
  high: { label: 'High', color: 0xffc94d, note: 'exhibits and furniture: more detail than the room' },
  low: { label: 'Low', color: 0x5cc8ff, note: 'glass, reflective floor, bare walls: less detail than the room' },
};
export const FOCUS_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

/**
 * @typedef {object} FocusRegion
 * @property {string} id
 * @property {string} name
 * @property {'hero'|'high'|'low'} tier
 * @property {[number, number, number]} center
 * @property {[number, number, number]} size
 * @property {[number, number, number, number]} quaternion
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum);

/** Errors for a `focusRegions` value (empty when valid). */
export function validateFocusRegions(list) {
  const errors = [];
  if (!Array.isArray(list)) return ['"focusRegions" must be an array'];
  if (list.length > 500) errors.push('"focusRegions" holds more than 500 regions');
  const ids = new Set();
  list.forEach((r, i) => {
    const at = `focusRegions[${i}]`;
    if (!r || typeof r !== 'object') return void errors.push(`${at} must be an object`);
    if (typeof r.id !== 'string' || !FOCUS_ID_RE.test(r.id)) errors.push(`${at}.id ${JSON.stringify(r.id)} is invalid (letters, digits, _ and -, max 48)`);
    else if (ids.has(r.id)) errors.push(`${at}.id "${r.id}" is used twice`);
    else ids.add(r.id);
    if (typeof r.name !== 'string' || r.name.length > 120) errors.push(`${at}.name must be a string of at most 120 characters`);
    if (!FOCUS_TIERS.includes(r.tier)) errors.push(`${at}.tier must be one of ${FOCUS_TIERS.join(', ')}`);
    if (!isVec(r.center, 3)) errors.push(`${at}.center must be [x, y, z]`);
    if (!isVec(r.size, 3) || !r.size.every((s) => s > 0)) errors.push(`${at}.size must be three positive numbers`);
    if (!isVec(r.quaternion, 4) || Math.abs(Math.hypot(...r.quaternion) - 1) > 1e-3) errors.push(`${at}.quaternion must be a unit quaternion [x, y, z, w]`);
  });
  return errors;
}

/** Row-major 3x3 rotation of a unit quaternion [x, y, z, w]; its columns are the box axes. */
export function quatToMat3([x, y, z, w]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** contains(x, y, z) for a region, in scene coordinates. */
export function regionContains(region) {
  const R = quatToMat3(region.quaternion);
  const [cx, cy, cz] = region.center;
  const [hx, hy, hz] = region.size.map((s) => s / 2);
  return (x, y, z) => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    // p_local = R^T (p - center)
    return Math.abs(R[0] * dx + R[3] * dy + R[6] * dz) <= hx
      && Math.abs(R[1] * dx + R[4] * dy + R[7] * dz) <= hy
      && Math.abs(R[2] * dx + R[5] * dy + R[8] * dz) <= hz;
  };
}

export function regionVolume(region) {
  return region.size[0] * region.size[1] * region.size[2];
}

/**
 * Which side of its thinnest axis a region is viewed from: the training cameras that
 * have the region's centre within `maxAngleDeg` of their view direction, counted by the
 * side of the box they stand on. `cameras`: [{ center, forward }] in scene coordinates.
 * front is +1 / -1 (the camera side, along the thin axis), or 0 when the region is seen
 * from both sides (the smaller side has `twoSided` of the larger's cameras or more) or
 * by fewer than `minCameras`.
 * @returns {{ axis: number, normal: number[], front: number, counts: number[] }} counts: [minus side, plus side]
 */
export function regionFacing(region, cameras, { maxAngleDeg = 50, minCameras = 5, twoSided = 0.2 } = {}) {
  const R = quatToMat3(region.quaternion);
  const axis = region.size.indexOf(Math.min(...region.size));
  const normal = [R[axis], R[3 + axis], R[6 + axis]];
  const half = region.size[axis] / 2;
  const cos = Math.cos((maxAngleDeg * Math.PI) / 180);
  const counts = [0, 0];
  for (const cam of cameras) {
    const v = region.center.map((c, i) => c - cam.center[i]);
    const len = Math.hypot(...v);
    if (!(len > 0) || (cam.forward[0] * v[0] + cam.forward[1] * v[1] + cam.forward[2] * v[2]) / len < cos) continue;
    const side = -(normal[0] * v[0] + normal[1] * v[1] + normal[2] * v[2]);
    if (Math.abs(side) > half) counts[side > 0 ? 1 : 0]++;
  }
  const [lo, hi] = [Math.min(...counts), Math.max(...counts)];
  const front = hi < minCameras || lo >= twoSided * hi ? 0 : counts[1] > counts[0] ? 1 : -1;
  return { axis, normal, front, counts };
}

/**
 * contains(x, y, z) for the region's footprint extruded `depth` behind it: on the side of
 * its thin axis away from `front` (+1 / -1, as regionFacing), from the box face outwards.
 * Surfaces such as wall panels are trained with their backing behind them; this is it.
 */
export function regionBackContains(region, front, depth) {
  const R = quatToMat3(region.quaternion);
  const axis = region.size.indexOf(Math.min(...region.size));
  const half = region.size.map((s) => s / 2);
  const [cx, cy, cz] = region.center;
  return (x, y, z) => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    for (let a = 0; a < 3; a++) {
      const l = R[a] * dx + R[3 + a] * dy + R[6 + a] * dz;
      if (a !== axis) {
        if (Math.abs(l) > half[a]) return false;
      } else {
        const back = -front * l;
        if (back <= half[a] || back > half[a] + depth) return false;
      }
    }
    return true;
  };
}

/**
 * The region as a Spirula prism in the SOURCE (training) frame of a scene whose
 * transform is `sceneMatrix` (column-major T * R * uniform S, as scene.transform.matrix):
 * p_source = M^-1 p_scene. Prism convention (pipeline/lib/roi.mjs): p_local = R^T (p - center),
 * `polygon` in local x/y, extruded over local z by +-half_height.
 */
export function regionToSourcePrism(region, sceneMatrix) {
  const m = sceneMatrix;
  const s = Math.hypot(m[0], m[1], m[2]);
  const t = [m[12], m[13], m[14]];
  // Row-major rotation from the column-major matrix with the uniform scale divided out.
  const Rm = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => m[4 * c + r] / s));
  const Rb = quatToMat3(region.quaternion);
  const d = region.center.map((v, i) => v - t[i]);
  // center = (1/s) Rm^T (c - t)
  const center = [0, 1, 2].map((i) => (Rm[i] * d[0] + Rm[3 + i] * d[1] + Rm[6 + i] * d[2]) / s);
  // rotation = Rm^T Rb (row-major)
  const rotation = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) rotation.push(Rm[i] * Rb[j] + Rm[3 + i] * Rb[3 + j] + Rm[6 + i] * Rb[6 + j]);
  const [hx, hy, hz] = region.size.map((v) => v / 2 / s);
  return { type: 'prism', center, rotation, half_height: hz, polygon: [-hx, -hy, hx, -hy, hx, hy, -hx, hy] };
}

/** A Spirula region file (top-level union of prisms, source frame) for some regions. */
export function regionsToSpirula(regions, sceneMatrix) {
  return { type: 'union', children: regions.map((r) => regionToSourcePrism(r, sceneMatrix)) };
}

/** A fresh region id not in `taken` ("r1", "r2", ...). */
export function nextRegionId(taken) {
  const ids = new Set(taken);
  for (let i = 1; ; i++) if (!ids.has(`r${i}`)) return `r${i}`;
}
