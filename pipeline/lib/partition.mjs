// Spirula Studio scene partition (partition.json + partition.bin) reader, and a
// nearest-point labeller built on it.
//
// partition.json  (format "spirula-scene-partition", version 1)
//   num_parts, num_points, num_frames, options{method, parts, ...},
//   frame_names[], frame_parts[], parts[{ core, points, ring: [frame indices] }],
//   binary: "partition.bin"
//
// partition.bin   NO PUBLISHED SPEC: this layout was reverse-engineered from one
// file (OculusV1, 28,496,397 bytes), so everything is validated and anything
// unexpected fails with a clear message instead of guessing. Little-endian.
//   0   char[4] "SSPT"   u32 version (= 2)
//   8   char[4] "SSLF"   u32 version (= 1)
//   16  u64  N           point count (733,309 in OculusV1)
//   24  u32  M           node count of the tree that follows (262,143)
//   28  u32  ?           unknown
//   32  N x 16 bytes     point records: f32 x, f32 y, f32 z, u8 part label (0..num_parts-1), 3 unknown bytes
//   ..  M x 32 bytes     BVH over the points: f32 min[3], i32 a, f32 max[3], i32 c
//                        (leaf: c = point count <= 6, a = first point; inner: c = 0, a = child index)
//   ..  rest             starts with u64 frame count (1240), then floats: unknown, not read
// Points are in the same coordinate frame as the trained .ply (Spirula's merge
// of the parts). We only use the point records; the BVH is not needed because
// we build our own k-d tree (simpler to trust than an undocumented layout).
import fs from 'node:fs';
import path from 'node:path';

export const PARTITION_FORMAT = 'spirula-scene-partition';
const HEADER_BYTES = 32;
const POINT_BYTES = 16;
const NODE_BYTES = 32;

function fail(file, msg) {
  throw new Error(`${path.basename(file)}: ${msg}`);
}

/**
 * Read and check partition.json only (cheap: no binary read).
 * @param {string} jsonPath
 * @returns {{ json: object, numParts: number, binPath: string, binBytes: number }}
 */
export function readPartitionInfo(jsonPath) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    fail(jsonPath, `cannot read: ${e.message}`);
  }
  if (json?.format !== PARTITION_FORMAT) fail(jsonPath, `format is ${JSON.stringify(json?.format)}, expected "${PARTITION_FORMAT}"`);
  if (json.version !== 1) fail(jsonPath, `version ${JSON.stringify(json.version)} is not supported (only 1 has been seen)`);
  const numParts = json.num_parts;
  if (!Number.isInteger(numParts) || numParts < 1 || numParts > 255) fail(jsonPath, `num_parts must be 1..255, got ${JSON.stringify(numParts)}`);
  if (Array.isArray(json.parts) && json.parts.length !== numParts) fail(jsonPath, `parts[] has ${json.parts.length} entries but num_parts is ${numParts}`);
  const binName = json.binary ?? 'partition.bin';
  if (typeof binName !== 'string' || binName !== path.basename(binName) || binName.startsWith('.')) fail(jsonPath, `"binary" must be a plain file name next to the JSON, got ${JSON.stringify(binName)}`);
  const binPath = path.join(path.dirname(path.resolve(jsonPath)), binName);
  if (!fs.existsSync(binPath)) fail(jsonPath, `binary file not found: ${binPath}`);
  return { json, numParts, binPath, binBytes: fs.statSync(binPath).size };
}

/**
 * Read partition.json and its binary point table.
 * @param {string} jsonPath
 * @returns {{ json: object, numParts: number, count: number, positions: Float32Array, labels: Uint8Array, labelCounts: number[], bbox: { min: number[], max: number[] }, binPath: string, unknownHeaderU32: number }}
 */
export function readPartition(jsonPath) {
  const { json, numParts, binPath, binBytes: size } = readPartitionInfo(jsonPath);
  if (size < HEADER_BYTES) fail(binPath, `too small (${size} bytes) for the 32-byte header`);
  const fd = fs.openSync(binPath, 'r');
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    fs.readSync(fd, head, 0, HEADER_BYTES, 0);
    if (head.toString('latin1', 0, 4) !== 'SSPT') fail(binPath, `bad magic ${JSON.stringify(head.toString('latin1', 0, 4))} at offset 0 (expected "SSPT")`);
    const v1 = head.readUInt32LE(4);
    if (v1 !== 2) fail(binPath, `SSPT version ${v1} is not supported (only 2 has been seen)`);
    if (head.toString('latin1', 8, 12) !== 'SSLF') fail(binPath, `bad magic ${JSON.stringify(head.toString('latin1', 8, 12))} at offset 8 (expected "SSLF")`);
    const v2 = head.readUInt32LE(12);
    if (v2 !== 1) fail(binPath, `SSLF version ${v2} is not supported (only 1 has been seen)`);
    const nBig = head.readBigUInt64LE(16);
    if (nBig === 0n || nBig > 2n ** 31n) fail(binPath, `implausible point count ${nBig}`);
    const count = Number(nBig);
    const nodes = head.readUInt32LE(24);
    const need = HEADER_BYTES + count * POINT_BYTES + nodes * NODE_BYTES;
    if (need > size) fail(binPath, `header says ${count} points + ${nodes} tree nodes (${need} bytes) but the file has ${size} bytes`);
    if (Number.isInteger(json.num_points) && count > json.num_points) fail(binPath, `${count} points in the binary but num_points is ${json.num_points}`);

    const raw = Buffer.alloc(count * POINT_BYTES);
    const got = fs.readSync(fd, raw, 0, raw.length, HEADER_BYTES);
    if (got !== raw.length) fail(binPath, `short read of the point table (${got} of ${raw.length} bytes)`);
    const positions = new Float32Array(count * 3);
    const labels = new Uint8Array(count);
    const labelCounts = new Array(numParts).fill(0);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      const o = i * POINT_BYTES;
      const x = raw.readFloatLE(o);
      const y = raw.readFloatLE(o + 4);
      const z = raw.readFloatLE(o + 8);
      const l = raw[o + 12];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) fail(binPath, `point ${i} has a non-finite position: layout not as expected`);
      if (l >= numParts) fail(binPath, `point ${i} has part label ${l} but num_parts is ${numParts}: layout not as expected`);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      labels[i] = l;
      labelCounts[l]++;
      if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
    }
    const empty = labelCounts.findIndex((c) => c === 0);
    if (empty >= 0) fail(binPath, `no points carry part label ${empty}: layout not as expected`);
    return { json, numParts, count, positions, labels, labelCounts, bbox: { min, max }, binPath, unknownHeaderU32: head.readUInt32LE(28) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Static 3-d tree over points for nearest-neighbour queries. Implicit balanced
 * layout: the range [lo, hi) splits at mid = (lo + hi) >> 1 on axis[mid];
 * points are reordered so each subtree is contiguous. Memory: 13 bytes/point
 * on top of the input.
 */
export class KdTree {
  /**
   * @param {Float32Array} positions  x, y, z per point
   * @param {Uint8Array} labels  carried along with the points
   */
  constructor(positions, labels) {
    const n = labels.length;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    this.n = n;
    this.axis = new Uint8Array(n);
    this.build(positions, idx, 0, n);
    // Reorder into tree order for cache-friendly queries.
    this.pos = new Float32Array(n * 3);
    this.lab = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const i = idx[k];
      this.pos[k * 3] = positions[i * 3];
      this.pos[k * 3 + 1] = positions[i * 3 + 1];
      this.pos[k * 3 + 2] = positions[i * 3 + 2];
      this.lab[k] = labels[i];
    }
    this.bestD = Infinity;
    this.bestK = -1;
  }

  build(p, idx, lo0, hi0) {
    const stack = [lo0, hi0];
    while (stack.length) {
      const hi = stack.pop();
      const lo = stack.pop();
      if (hi - lo <= 1) continue;
      // Split on the axis of largest extent.
      let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      for (let k = lo; k < hi; k++) {
        const i = idx[k] * 3;
        const x = p[i], y = p[i + 1], z = p[i + 2];
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
      const ex = mxx - mnx, ey = mxy - mny, ez = mxz - mnz;
      const ax = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const mid = (lo + hi) >>> 1;
      this.select(p, idx, lo, hi - 1, mid, ax);
      this.axis[mid] = ax;
      stack.push(lo, mid, mid + 1, hi);
    }
  }

  /** Quickselect (Hoare partition) so idx[k] holds the k-th smallest along `ax` in [left, right]. */
  select(p, idx, left, right, k, ax) {
    while (right > left) {
      const pivot = p[idx[(left + right) >>> 1] * 3 + ax];
      let i = left;
      let j = right;
      while (i <= j) {
        while (p[idx[i] * 3 + ax] < pivot) i++;
        while (p[idx[j] * 3 + ax] > pivot) j--;
        if (i <= j) {
          const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
          i++; j--;
        }
      }
      if (k <= j) right = j;
      else if (k >= i) left = i;
      else return;
    }
  }

  /** Index (tree order) of the nearest point; distance squared in this.bestD. */
  nearest(x, y, z) {
    this.bestD = Infinity;
    this.bestK = -1;
    this.search(x, y, z, 0, this.n);
    return this.bestK;
  }

  search(x, y, z, lo, hi) {
    const pos = this.pos;
    while (hi - lo > 8) {
      const mid = (lo + hi) >>> 1;
      const o = mid * 3;
      const dx = x - pos[o], dy = y - pos[o + 1], dz = z - pos[o + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < this.bestD) { this.bestD = d; this.bestK = mid; }
      const ax = this.axis[mid];
      const diff = (ax === 0 ? x : ax === 1 ? y : z) - pos[o + ax];
      if (diff < 0) {
        this.search(x, y, z, lo, mid);
        if (diff * diff >= this.bestD) return;
        lo = mid + 1;
      } else {
        this.search(x, y, z, mid + 1, hi);
        if (diff * diff >= this.bestD) return;
        hi = mid;
      }
    }
    for (let k = lo; k < hi; k++) {
      const o = k * 3;
      const dx = x - pos[o], dy = y - pos[o + 1], dz = z - pos[o + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < this.bestD) { this.bestD = d; this.bestK = k; }
    }
  }

  /** Part label of the nearest point. */
  label(x, y, z) {
    return this.lab[this.nearest(x, y, z)];
  }
}
