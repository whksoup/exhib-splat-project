#!/usr/bin/env node
// Where a model's splats sit along a focus box's thin axis: the splats inside the
// box's footprint (its two long axes), binned by signed distance from the box's
// centre plane. Negative = the side the camera views from; the wall is behind.
//
//   node depth-profile.mjs <region id> [--from -3] [--to 3] [--step 0.1]
//
// Reads the baked scene-coordinate plys the splice uses (A's 4 parts, B).
import fs from 'node:fs';
import path from 'node:path';
import { quatToMat3 } from '../../../shared/focus-regions.mjs';
import { readScene } from '../../../pipeline/lib/scene-files.mjs';
import { openSplatPly } from '../../../pipeline/lib/splat-crop.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const PLY = (f) => path.join(ROOT, 'assets/source_ply', f);
const MODELS = {
  A: ['Oculus12', 'Oculus34', 'Oculus56', 'Oculus78'].map((p) => PLY(`Hybrid-A-${p}-scene.ply`)),
  B: [PLY('LowCap-L0-scene.ply')],
};
const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const id = process.argv[2];
const FROM = option('--from', -3), TO = option('--to', 3), STEP = option('--step', 0.1);
const region = readScene(path.join(ROOT, 'scenes/LowCap/scene.json')).focusRegions.find((r) => r.id === id);
if (!region) throw new Error(`no region ${id}`);
const R = quatToMat3(region.quaternion); // row-major; local = Rᵀ(p - c)
const thin = region.size.indexOf(Math.min(...region.size));
const plane = [0, 1, 2].filter((k) => k !== thin);
const half = region.size.map((s) => s / 2);
// Which side of the plane the room is on: the side nearer the scene origin (where the tour starts).
const toOrigin = [0, 1, 2].reduce((s, i) => s + R[i * 3 + thin] * -region.center[i], 0);
const facing = Math.sign(toOrigin) || 1;
const nBins = Math.round((TO - FROM) / STEP);
const sigmoid = (v) => 1 / (1 + Math.exp(-v));

function profile(files) {
  const bins = Array.from({ length: nBins }, () => ({ n: 0, opacity: 0, sizes: [] }));
  for (const file of files) {
    const ply = openSplatPly(file, () => {});
    const { props, stride, total, header } = ply;
    const off = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'opacity'].map((k) => props[k].offset);
    const fd = fs.openSync(file, 'r');
    const records = 1 << 16;
    const buf = Buffer.alloc(records * stride);
    for (let done = 0; done < total;) {
      const want = Math.min(records, total - done);
      fs.readSync(fd, buf, 0, want * stride, header.headerBytes + done * stride);
      for (let i = 0; i < want; i++) {
        const b = i * stride;
        const d = [0, 1, 2].map((k) => buf.readFloatLE(b + off[k]) - region.center[k]);
        const local = [0, 1, 2].map((a) => R[a] * d[0] + R[3 + a] * d[1] + R[6 + a] * d[2]);
        if (plane.some((k) => Math.abs(local[k]) > half[k])) continue;
        const depth = -facing * local[thin]; // > 0: behind the box's centre plane, away from the room
        const bin = Math.floor((depth - FROM) / STEP);
        if (bin < 0 || bin >= nBins) continue;
        const s = bins[bin];
        s.n++;
        s.opacity += sigmoid(buf.readFloatLE(b + off[6]));
        s.sizes.push(Math.exp(Math.max(buf.readFloatLE(b + off[3]), buf.readFloatLE(b + off[4]), buf.readFloatLE(b + off[5]))));
      }
      done += want;
    }
    fs.closeSync(fd);
  }
  return bins.map((s) => {
    s.sizes.sort((a, b) => a - b);
    return { n: s.n, opacity: s.n ? s.opacity / s.n : 0, sizeMm: s.n ? s.sizes[s.sizes.length >> 1] * 1000 : 0 };
  });
}

const result = Object.fromEntries(Object.entries(MODELS).map(([k, files]) => [k, profile(files)]));
console.log(`${id}: footprint ${plane.map((k) => region.size[k].toFixed(2)).join(' x ')} m, box depth ${region.size[thin].toFixed(2)} m (±${half[thin].toFixed(2)})`);
console.log('depth m        ' + Object.keys(MODELS).map((k) => `${k} splats  opac  size mm`.padStart(28)).join(''));
for (let i = 0; i < nBins; i++) {
  const d = FROM + i * STEP;
  if (Object.values(result).every((r) => r[i].n === 0)) continue;
  const mark = Math.abs(d + STEP / 2) <= half[thin] ? ' in box' : '';
  console.log(`${d.toFixed(2).padStart(6)}..${(d + STEP).toFixed(2).padEnd(6)}` + Object.values(result).map((r) => `${String(r[i].n).padStart(14)}  ${r[i].opacity.toFixed(2)}  ${r[i].sizeMm.toFixed(1).padStart(7)}`).join('') + mark);
}
fs.writeFileSync(path.join(import.meta.dirname, `depth-${id}.json`), `${JSON.stringify({ region: id, from: FROM, to: TO, step: STEP, ...result }, null, 1)}\n`);
