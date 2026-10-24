// Closed triangle meshes as solids: a point-in-solid test fast enough for tens
// of millions of splat centres.
//
// contains(x, y, z) casts one ray along +x, +y and +z and counts the triangles
// each crosses (odd = inside). A ray that hits an edge or vertex exactly, or
// slips through a small gap in a not-quite-closed mesh, can miscount; taking
// the majority of the three axes absorbs one bad ray. Each axis has a uniform
// grid over the other two coordinates, so a ray only tests the triangles whose
// projection overlaps its cell.
//
// Closedness is checked by welding vertices (tolerance 1e-6 of the bounding
// box diagonal) and counting edges not shared by exactly two triangles.

const AXES = [[1, 2, 0], [2, 0, 1], [0, 1, 2]]; // [u, v, ray] coordinate indices

/** Grid over (u, v) of the triangles' projections, for rays along `ray`. */
function axisGrid(tri, n, lo, hi, [u, v, ray]) {
  const g = Math.max(1, Math.min(1024, Math.round(Math.sqrt(n) * 1.5)));
  const u0 = lo[u], v0 = lo[v];
  const du = (hi[u] - u0) / g || 1, dv = (hi[v] - v0) / g || 1;
  const cell = (val, o, d) => Math.max(0, Math.min(g - 1, Math.floor((val - o) / d)));
  const counts = new Uint32Array(g * g + 1);
  const span = (t) => {
    const b = t * 9;
    const us = [tri[b + u], tri[b + 3 + u], tri[b + 6 + u]], vs = [tri[b + v], tri[b + 3 + v], tri[b + 6 + v]];
    return [cell(Math.min(...us), u0, du), cell(Math.max(...us), u0, du), cell(Math.min(...vs), v0, dv), cell(Math.max(...vs), v0, dv)];
  };
  for (let t = 0; t < n; t++) {
    const [a, b, c, d] = span(t);
    for (let i = a; i <= b; i++) for (let j = c; j <= d; j++) counts[i * g + j + 1]++;
  }
  for (let k = 1; k <= g * g; k++) counts[k] += counts[k - 1];
  const items = new Uint32Array(counts[g * g]);
  const fill = counts.slice(0, g * g);
  for (let t = 0; t < n; t++) {
    const [a, b, c, d] = span(t);
    for (let i = a; i <= b; i++) for (let j = c; j <= d; j++) items[fill[i * g + j]++] = t;
  }
  return { u, v, ray, g, u0, v0, du, dv, start: counts, items };
}

// Sign of an edge function at p + (e, e^2) for an infinitesimal e: its value,
// else its u slope, else its v slope. Every triangle sees the same nudged
// point, so a ray through a shared edge or vertex counts exactly once.
const side = (w, du, dv) => (w !== 0 ? Math.sign(w) : du !== 0 ? Math.sign(du) : Math.sign(dv));

/** Number of triangles crossed by the ray from p along +ray (simulated-simplicity ties, see side()). */
function crossings(tri, grid, p) {
  const { u, v, ray, g } = grid;
  const pu = p[u], pv = p[v];
  const i = Math.floor((pu - grid.u0) / grid.du), j = Math.floor((pv - grid.v0) / grid.dv);
  if (i < 0 || j < 0 || i >= g || j >= g) return 0;
  let hits = 0;
  for (let k = grid.start[i * g + j], end = grid.start[i * g + j + 1]; k < end; k++) {
    const b = grid.items[k] * 9;
    const au = tri[b + u] - pu, av = tri[b + v] - pv;
    const bu = tri[b + 3 + u] - pu, bv = tri[b + 3 + v] - pv;
    const cu = tri[b + 6 + u] - pu, cv = tri[b + 6 + v] - pv;
    const w0 = bu * cv - bv * cu, w1 = cu * av - cv * au, w2 = au * bv - av * bu;
    const s0 = side(w0, bv - cv, cu - bu);
    if (s0 === 0 || side(w1, cv - av, au - cu) !== s0 || side(w2, av - bv, bu - au) !== s0) continue;
    const s = w0 + w1 + w2;
    if (s === 0) continue; // edge-on triangle
    const along = (w0 * tri[b + ray] + w1 * tri[b + 3 + ray] + w2 * tri[b + 6 + ray]) / s;
    if (along > p[ray]) hits++;
  }
  return hits;
}

/** Edges used by other than exactly two triangles, after welding nearby vertices. */
export function openEdgeCount(tri, n, tol) {
  const ids = new Map();
  const vid = (b) => {
    const key = `${Math.round(tri[b] / tol)},${Math.round(tri[b + 1] / tol)},${Math.round(tri[b + 2] / tol)}`;
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = ids.size));
    return id;
  };
  const edges = new Map();
  for (let t = 0; t < n; t++) {
    const a = vid(t * 9), b = vid(t * 9 + 3), c = vid(t * 9 + 6);
    if (a === b || b === c || c === a) continue; // degenerate after welding
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? `${p},${q}` : `${q},${p}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const uses of edges.values()) if (uses !== 2) open++;
  return open;
}

/**
 * A solid from triangles (9 numbers each: x0 y0 z0 x1 y1 z1 x2 y2 z2).
 * @returns {{ name: string, triangles: number, bboxMin: number[], bboxMax: number[], openEdges: number, contains: (x: number, y: number, z: number) => boolean }}
 */
export function makeSolid(triangles, name = 'solid') {
  const tri = Float64Array.from(triangles);
  const n = tri.length / 9;
  if (!Number.isInteger(n) || n < 4) throw new Error(`${name}: a solid needs at least 4 triangles`);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < tri.length; k++) {
    const a = k % 3;
    if (!Number.isFinite(tri[k])) throw new Error(`${name}: non-finite vertex`);
    if (tri[k] < lo[a]) lo[a] = tri[k];
    if (tri[k] > hi[a]) hi[a] = tri[k];
  }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const grids = AXES.map((axes) => axisGrid(tri, n, lo, hi, axes));
  const p = [0, 0, 0];
  return {
    name,
    triangles: n,
    bboxMin: lo,
    bboxMax: hi,
    openEdges: openEdgeCount(tri, n, diag * 1e-6 || 1e-9),
    contains(x, y, z) {
      if (x < lo[0] || x > hi[0] || y < lo[1] || y > hi[1] || z < lo[2] || z > hi[2]) return false;
      p[0] = x; p[1] = y; p[2] = z;
      let votes = 0;
      for (const g of grids) votes += crossings(tri, g, p) & 1;
      return votes >= 2;
    },
  };
}
