#!/usr/bin/env node
// Down-res a scene into ONE small splat .ply (a "miniature") for editing in
// LichtFeld / showing as a small object, by MERGING nearby splats rather than
// dropping them, so surfaces stay closed.
//
//   node pipeline/miniature.mjs <scene> [--target 1500000] [--sh 3] [--out <file.ply>] [--overwrite]
//
// Every enabled part is cropped to its ROI exactly like build-scene.mjs
// (lib/roi.mjs, source frame), and the merged result stays in the parts' SOURCE
// frame: the scene transform is NOT baked, so the file lines up with the
// original .ply files and ROI outlines.
//
// Merging: each splat goes to a cell of an adaptive grid. Its level
// L = ceil(log2(2 sigma_max / c)) (0 at least) picks a cell size c * 2^L, so a
// splat is only merged with splats about its own size or smaller, never a big
// background splat with fine detail. c is binary-searched until the number of
// non-empty cells is close to --target. A cell becomes one Gaussian:
//   weight    w_i = alpha_i * area_i, area_i = s1 s2 + s2 s3 + s3 s1 (~ mean projected area)
//   mean      sum w_i mu_i / W
//   cov       sum w_i (Sigma_i + mu_i mu_i^T) / W - mu mu^T   (moment matching)
//   colour    sum w_i f_i / W for f_dc and every f_rest
//   opacity   min(sum w_i / area_merged, 0.999)   (a lone splat comes back unchanged)
// Two streaming passes per source (positions/sizes, then full records), so RAM
// is ~20 bytes per kept splat plus ~470 bytes per output splat.
import fs from 'node:fs';
import path from 'node:path';

import { readRoi } from './lib/roi.mjs';
import { openSplatPly } from './lib/splat-crop.mjs';
import { scenePaths, readScene } from './lib/scene-files.mjs';
import { partCrop } from '../shared/scene-schema.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const READ_BYTES = 64 * 1024 * 1024;
const MIN_ALPHA = 1 / 255; // invisible splats are dropped before merging
const MIN_SIGMA = 1e-7;

const USAGE = `Usage:
  node pipeline/miniature.mjs <scene> [options]

Options:
  --target <n>     Splats in the output (default 1500000).
  --sh <0-3>       SH degree written (default: the sources' degree).
  --out <file>     Output .ply (default assets/source_ply/<scene>-mini-<n>k.ply).
  --overwrite      Replace an existing output.
  -h, --help       Show this help.`;

function parseArgs(argv) {
  const o = { scene: null, target: 1_500_000, sh: null, out: null, overwrite: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '--target': o.target = Math.round(Number(value())); break;
      case '--sh': o.sh = Number(value()); break;
      case '--out': o.out = value(); break;
      case '--overwrite': o.overwrite = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
        if (o.scene) throw new Error(`Expected one scene, got ${o.scene} and ${a}`);
        o.scene = a;
    }
  }
  if (o.help) return o;
  if (!o.scene) throw new Error('Missing <scene>');
  if (!(o.target >= 1000)) throw new Error('--target must be at least 1000');
  if (o.sh !== null && ![0, 1, 2, 3].includes(o.sh)) throw new Error('--sh must be 0, 1, 2 or 3');
  return o;
}

/** Calls fn(f32, base, index) for every record of a splat .ply, in 64 MB reads. */
function forEachRecord(ply, fn, label) {
  const floats = ply.stride / 4;
  const records = Math.floor(READ_BYTES / ply.stride);
  const buf = Buffer.alloc(records * ply.stride);
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const fd = fs.openSync(ply.input, 'r');
  try {
    for (let done = 0; done < ply.total;) {
      const want = Math.min(records, ply.total - done);
      const got = fs.readSync(fd, buf, 0, want * ply.stride, ply.header.headerBytes + done * ply.stride);
      if (got !== want * ply.stride) throw new Error(`short read at splat ${done}`);
      for (let i = 0; i < want; i++) fn(f32, i * floats, done + i);
      done += want;
      process.stdout.write(`\r  ${label}: ${((done / ply.total) * 100).toFixed(0)}%   `);
    }
    process.stdout.write('\n');
  } finally {
    fs.closeSync(fd);
  }
}

/** Float offsets of the 3DGS properties; every one must be float32. */
function layout(ply) {
  const vertex = ply.header.elements[0];
  const at = {};
  for (const p of vertex.properties) {
    if (!['float', 'float32'].includes(p.type)) throw new Error(`${path.basename(ply.input)}: property ${p.name} is ${p.type}, expected float`);
    at[p.name] = p.offset / 4;
  }
  const need = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  for (const k of need) if (at[k] === undefined) throw new Error(`${path.basename(ply.input)}: missing property ${k}`);
  return at;
}

const sigmoid = (v) => 1 / (1 + Math.exp(-v));

/** Symmetric 3x3 eigen-decomposition (cyclic Jacobi). a = [xx, yy, zz, xy, xz, yz]; returns values + column vectors. */
function eigenSym3(a) {
  const A = [[a[0], a[3], a[4]], [a[3], a[1], a[5]], [a[4], a[5], a[2]]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = A[0][1] ** 2 + A[0][2] ** 2 + A[1][2] ** 2;
    if (off < 1e-30 * (A[0][0] ** 2 + A[1][1] ** 2 + A[2][2] ** 2) || off === 0) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (A[p][q] === 0) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { // A = A J
        const akp = A[k][p], akq = A[k][q];
        A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) { // A = J^T A
        const apk = A[p][k], aqk = A[q][k];
        A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [A[0][0], A[1][1], A[2][2]], V };
}

/** Rotation matrix (columns = axes, det +1) to a unit quaternion [w, x, y, z]. */
function matToQuat(V) {
  const [m00, m01, m02] = V[0], [m10, m11, m12] = V[1], [m20, m21, m22] = V[2];
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  const n = Math.hypot(w, x, y, z);
  return [w / n, x / n, y / n, z / n];
}

/** A growable Float32Array. */
class F32List {
  constructor(n = 1 << 20) { this.a = new Float32Array(n); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return; }
  const t0 = Date.now();
  const scene = readScene(scenePaths(path.join(PROJECT_ROOT, 'scenes'), o.scene).file);
  const parts = scene.parts.filter((p) => p.enabled !== false);
  if (parts.length === 0) throw new Error(`scene ${o.scene} has no enabled parts`);
  const out = path.resolve(PROJECT_ROOT, o.out ?? `assets/source_ply/${o.scene}-mini-${Math.round(o.target / 1000)}k.ply`);
  if (fs.existsSync(out) && !o.overwrite) throw new Error(`${out} exists (use --overwrite)`);

  const sources = parts.map((part) => {
    const crop = partCrop(scene, part);
    if (crop?.partition) throw new Error(`part ${part.id}: partition crops are not supported here`);
    const roi = crop?.roi ? readRoi(path.resolve(PROJECT_ROOT, crop.roi), crop.roiOutlines ?? null) : null;
    const ply = openSplatPly(path.resolve(PROJECT_ROOT, part.source));
    return { part, roi, ply, at: layout(ply) };
  });
  const srcSh = Math.min(...sources.map((s) => s.ply.header.shDegree));
  const sh = o.sh ?? srcSh;
  if (sh > srcSh) throw new Error(`--sh ${sh} is above the sources' SH degree ${srcSh}`);
  const restPer = (sh + 1) ** 2 - 1; // f_rest coefficients per channel written
  const srcRestPer = (srcSh + 1) ** 2 - 1;
  console.log(`Scene ${o.scene}: ${parts.length} part(s), SH ${srcSh} -> ${sh}, target ${o.target.toLocaleString()} splats`);

  // Pass 1: ROI crop + per-splat position, size and visibility.
  const px = new F32List(), py = new F32List(), pz = new F32List(), ps = new F32List();
  const keep = []; // per source: Uint8Array, 1 = merged
  let total = 0, droppedRoi = 0, droppedAlpha = 0;
  for (const src of sources) {
    const { at, roi } = src;
    const k = new Uint8Array(src.ply.total);
    forEachRecord(src.ply, (f, b, i) => {
      const x = f[b + at.x], y = f[b + at.y], z = f[b + at.z];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      if (roi && !roi.contains(x, y, z)) { droppedRoi++; return; }
      if (!(sigmoid(f[b + at.opacity]) >= MIN_ALPHA)) { droppedAlpha++; return; }
      k[i] = 1;
      px.push(x); py.push(y); pz.push(z);
      ps.push(Math.exp(Math.max(f[b + at.scale_0], f[b + at.scale_1], f[b + at.scale_2])));
    }, `${src.part.id} pass 1/2 (crop)`);
    keep.push(k);
    total += src.ply.total;
  }
  const n = px.n;
  console.log(`Kept ${n.toLocaleString()} of ${total.toLocaleString()} splats (${droppedRoi.toLocaleString()} outside ROI, ${droppedAlpha.toLocaleString()} near-invisible)`);
  if (n <= o.target) throw new Error(`only ${n} splats survive the crop; nothing to merge for --target ${o.target}`);

  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const v = [px.a[i], py.a[i], pz.a[i]];
    for (let j = 0; j < 3; j++) { if (v[j] < lo[j]) lo[j] = v[j]; if (v[j] > hi[j]) hi[j] = v[j]; }
  }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);

  // Cell key: level (6 bits) and ix, iy, iz (15 bits each) packed into one exact double.
  const keys = new Float64Array(n);
  const makeKeys = (c) => {
    for (let i = 0; i < n; i++) {
      const L = Math.max(0, Math.min(40, Math.ceil(Math.log2((2 * ps.a[i]) / c))));
      let size = c * 2 ** L;
      while (extent / size >= 32768) size *= 2; // keep indices in 15 bits
      const ix = Math.floor((px.a[i] - lo[0]) / size), iy = Math.floor((py.a[i] - lo[1]) / size), iz = Math.floor((pz.a[i] - lo[2]) / size);
      keys[i] = ((L * 32768 + ix) * 32768 + iy) * 32768 + iz;
    }
  };
  const sorted = new Float64Array(n);
  const countCells = (c) => {
    makeKeys(c);
    sorted.set(keys);
    sorted.sort();
    let cells = 1;
    for (let i = 1; i < n; i++) if (sorted[i] !== sorted[i - 1]) cells++;
    return cells;
  };

  // Binary search (in log space) for the base cell size giving ~target cells.
  let cLo = extent / 32768, cHi = extent / 4, c = 0, cells = 0;
  for (let it = 0; it < 24; it++) {
    c = Math.sqrt(cLo * cHi);
    cells = countCells(c);
    process.stdout.write(`\r  cell size ${c.toExponential(3)}: ${cells.toLocaleString()} cells          `);
    if (Math.abs(cells - o.target) / o.target < 0.01) break;
    if (cells > o.target) cLo = c; else cHi = c;
  }
  process.stdout.write('\n');
  makeKeys(c);
  sorted.set(keys);
  sorted.sort();
  const cellOf = new Map();
  for (let i = 0; i < n; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) cellOf.set(sorted[i], cellOf.size);
  const m = cellOf.size;
  const cellIdx = new Int32Array(n);
  for (let i = 0; i < n; i++) cellIdx[i] = cellOf.get(keys[i]);
  cellOf.clear();
  console.log(`Base cell ${c.toExponential(3)} (extent ${extent.toFixed(3)}): ${m.toLocaleString()} output splats`);

  // Pass 2: accumulate moments per cell.
  const nCol = 3 * (1 + restPer);
  const W = new Float64Array(m);
  const mu = new Float64Array(m * 3);
  const mom = new Float64Array(m * 6); // xx yy zz xy xz yz of Sigma + mu mu^T
  const col = new Float64Array(m * nCol); // dc0..2, then rest in file order (channel-major)
  let k = 0;
  for (let si = 0; si < sources.length; si++) {
    const { at } = sources[si];
    const kept = keep[si];
    const rest0 = at.f_rest_0;
    forEachRecord(sources[si].ply, (f, b, i) => {
      if (!kept[i]) return;
      const cell = cellIdx[k++];
      const s0 = Math.exp(f[b + at.scale_0]), s1 = Math.exp(f[b + at.scale_1]), s2 = Math.exp(f[b + at.scale_2]);
      const w = sigmoid(f[b + at.opacity]) * (s0 * s1 + s1 * s2 + s2 * s0);
      let qw = f[b + at.rot_0], qx = f[b + at.rot_1], qy = f[b + at.rot_2], qz = f[b + at.rot_3];
      const qn = Math.hypot(qw, qx, qy, qz) || 1;
      qw /= qn; qx /= qn; qy /= qn; qz /= qn;
      // R columns are the splat's axes; Sigma = R diag(s^2) R^T.
      const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qw * qz), r02 = 2 * (qx * qz + qw * qy);
      const r10 = 2 * (qx * qy + qw * qz), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qw * qx);
      const r20 = 2 * (qx * qz - qw * qy), r21 = 2 * (qy * qz + qw * qx), r22 = 1 - 2 * (qx * qx + qy * qy);
      const a0 = s0 * s0, a1 = s1 * s1, a2 = s2 * s2;
      const x = f[b + at.x], y = f[b + at.y], z = f[b + at.z];
      W[cell] += w;
      mu[cell * 3] += w * x; mu[cell * 3 + 1] += w * y; mu[cell * 3 + 2] += w * z;
      const o6 = cell * 6;
      mom[o6] += w * (r00 * r00 * a0 + r01 * r01 * a1 + r02 * r02 * a2 + x * x);
      mom[o6 + 1] += w * (r10 * r10 * a0 + r11 * r11 * a1 + r12 * r12 * a2 + y * y);
      mom[o6 + 2] += w * (r20 * r20 * a0 + r21 * r21 * a1 + r22 * r22 * a2 + z * z);
      mom[o6 + 3] += w * (r00 * r10 * a0 + r01 * r11 * a1 + r02 * r12 * a2 + x * y);
      mom[o6 + 4] += w * (r00 * r20 * a0 + r01 * r21 * a1 + r02 * r22 * a2 + x * z);
      mom[o6 + 5] += w * (r10 * r20 * a0 + r11 * r21 * a1 + r12 * r22 * a2 + y * z);
      const oc = cell * nCol;
      col[oc] += w * f[b + at.f_dc_0]; col[oc + 1] += w * f[b + at.f_dc_1]; col[oc + 2] += w * f[b + at.f_dc_2];
      for (let ch = 0; ch < 3; ch++) {
        for (let j = 0; j < restPer; j++) col[oc + 3 + ch * restPer + j] += w * f[b + rest0 + ch * srcRestPer + j];
      }
    }, `${sources[si].part.id} pass 2/2 (merge)`);
  }
  if (k !== n) throw new Error(`internal error: merged ${k} of ${n} splats`);

  // Solve each cell and write the .ply.
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2',
    ...Array.from({ length: 3 * restPer }, (_, j) => `f_rest_${j}`),
    'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = ['ply', 'format binary_little_endian 1.0',
    `comment miniature of scene ${o.scene} (${parts.map((p) => p.id).join(', ')}), ${n} splats merged to ${m}, source frame`,
    `element vertex ${m}`, ...props.map((p) => `property float ${p}`), 'end_header', ''].join('\n');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, header);
    const stride = props.length;
    const batch = 65536;
    const obuf = new Float32Array(batch * stride);
    let used = 0;
    for (let cIdx = 0; cIdx < m; cIdx++) {
      const w = W[cIdx];
      const mx = mu[cIdx * 3] / w, my = mu[cIdx * 3 + 1] / w, mz = mu[cIdx * 3 + 2] / w;
      const o6 = cIdx * 6;
      const cov = [mom[o6] / w - mx * mx, mom[o6 + 1] / w - my * my, mom[o6 + 2] / w - mz * mz,
        mom[o6 + 3] / w - mx * my, mom[o6 + 4] / w - mx * mz, mom[o6 + 5] / w - my * mz];
      const { values, V } = eigenSym3(cov);
      const det = V[0][0] * (V[1][1] * V[2][2] - V[1][2] * V[2][1]) - V[0][1] * (V[1][0] * V[2][2] - V[1][2] * V[2][0]) + V[0][2] * (V[1][0] * V[2][1] - V[1][1] * V[2][0]);
      if (det < 0) for (let r = 0; r < 3; r++) V[r][2] = -V[r][2];
      const sg = values.map((v) => Math.sqrt(Math.max(v, MIN_SIGMA * MIN_SIGMA)));
      const area = sg[0] * sg[1] + sg[1] * sg[2] + sg[2] * sg[0];
      const alpha = Math.min(w / area, 0.999);
      const q = matToQuat(V);
      const b = used * stride;
      obuf[b] = mx; obuf[b + 1] = my; obuf[b + 2] = mz;
      obuf[b + 3] = 0; obuf[b + 4] = 0; obuf[b + 5] = 0;
      const oc = cIdx * nCol;
      for (let j = 0; j < nCol; j++) obuf[b + 6 + j] = col[oc + j] / w;
      const t = b + 6 + nCol;
      obuf[t] = Math.log(alpha / (1 - alpha));
      obuf[t + 1] = Math.log(sg[0]); obuf[t + 2] = Math.log(sg[1]); obuf[t + 3] = Math.log(sg[2]);
      obuf[t + 4] = q[0]; obuf[t + 5] = q[1]; obuf[t + 6] = q[2]; obuf[t + 7] = q[3];
      if (++used === batch || cIdx === m - 1) {
        fs.writeSync(fd, new Uint8Array(obuf.buffer, 0, used * stride * 4));
        used = 0;
      }
    }
    fs.closeSync(fd);
    fs.renameSync(tmp, out);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  const bytes = fs.statSync(out).size;
  console.log(`Wrote ${path.relative(PROJECT_ROOT, out)}: ${m.toLocaleString()} splats, SH ${sh}, ${(bytes / 1e6).toFixed(0)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(`Bounds (source frame): ${lo.map((v) => v.toFixed(3)).join(', ')} .. ${hi.map((v) => v.toFixed(3)).join(', ')}`);
}

try {
  main();
} catch (e) {
  console.error(`miniature: ${e.message}`);
  process.exit(1);
}
