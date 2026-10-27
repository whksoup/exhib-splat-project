#!/usr/bin/env node
// Which splats make the ghost on a glossy panel in the splice? Small local models
// around one focus box (everything within --radius of its centre), split four ways:
//   box     inside the box (grown --scale, as in the splice)
//   column  the box's footprint extruded --depth metres out into the room (not the box)
//   back    the same extruded the other way, behind the box (into the wall)
//   rest    everything else nearby
// and packed as single-SOG arms under assets/rad_output/Probe/<region>-<arm>:
//   a, b             A or B alone (references)
//   splice           A box + B everywhere else (what the splice does)
//   a-back           A box + A back, B column and rest (A's backing behind the panel kept)
//   a-back-b-too     the same with B's back added as well (does B's backing hurt?)
//
//   node probe.mjs <region id> [--scale 1.5] [--depth 1.5] [--radius 3]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { quatToMat3 } from '../../../shared/focus-regions.mjs';
import { readScene } from '../../../pipeline/lib/scene-files.mjs';
import { headerWithCount, labelSplats, openSplatPly, PartWriter, readHeaderText, writeByLabel } from '../../../pipeline/lib/splat-crop.mjs';

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
const SCALE = option('--scale', 1.5), DEPTH = option('--depth', 1.5), RADIUS = option('--radius', 3);
const base = readScene(path.join(ROOT, 'scenes/HighRezOculus/scene.json'));
const region = readScene(path.join(ROOT, 'scenes/LowCap/scene.json')).focusRegions.find((r) => r.id === id);
if (!region) throw new Error(`no region ${id}`);
const R = quatToMat3(region.quaternion);
const thin = region.size.indexOf(Math.min(...region.size));
const half = region.size.map((s) => (s * SCALE) / 2);
const facing = Math.sign([0, 1, 2].reduce((s, i) => s + R[i * 3 + thin] * -region.center[i], 0)) || 1;
const LABELS = ['far', 'box', 'column', 'rest', 'back'];
function labelOf(x, y, z) {
  const d = [x - region.center[0], y - region.center[1], z - region.center[2]];
  if (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] > RADIUS * RADIUS) return 0;
  const l = [0, 1, 2].map((a) => R[a] * d[0] + R[3 + a] * d[1] + R[6 + a] * d[2]);
  if ([0, 1, 2].some((k) => k !== thin && Math.abs(l[k]) > half[k])) return 3;
  const out = facing * l[thin]; // > 0: out into the room
  if (Math.abs(l[thin]) <= half[thin]) return 1;
  if (out > 0) return out <= half[thin] + DEPTH ? 2 : 3;
  return -out <= half[thin] + DEPTH ? 4 : 3;
}

const piece = (m, label) => PLY(`Probe-${id}-${m}-${label}.ply`);
const counts = {};
for (const [m, files] of Object.entries(MODELS)) {
  const writers = Object.fromEntries(LABELS.slice(1).map((l) => [l, []]));
  counts[m] = { box: 0, column: 0, rest: 0, back: 0 };
  for (const [fi, file] of files.entries()) {
    const ply = openSplatPly(file, () => {});
    const fd = fs.openSync(file, 'r');
    const records = Math.floor((32 << 20) / ply.stride);
    const buf = Buffer.alloc(records * ply.stride);
    const { labels, counts: c } = labelSplats(fd, ply, labelOf, LABELS.length, buf, records, () => {});
    const header = readHeaderText(fd, ply.header.headerBytes);
    const ws = LABELS.map((l, k) => (k === 0 || c[k] === 0 ? null : new PartWriter(PLY(`Probe-${id}-${m}${fi}-${l}.ply`), Buffer.from(headerWithCount(header, c[k]), 'latin1'), ply.stride)));
    writeByLabel(fd, ply, labels, ws, buf, records, () => {});
    fs.closeSync(fd);
    ws.forEach((w, k) => {
      if (!w) return;
      w.close();
      fs.renameSync(w.tmp, PLY(`Probe-${id}-${m}${fi}-${LABELS[k]}.ply`));
      writers[LABELS[k]].push(PLY(`Probe-${id}-${m}${fi}-${LABELS[k]}.ply`));
      counts[m][LABELS[k]] += c[k];
    });
  }
  Object.assign(counts[m], { files: writers });
}
console.log(Object.fromEntries(Object.entries(counts).map(([m, c]) => [m, { box: c.box, column: c.column, back: c.back, rest: c.rest }])));

const A = counts.A.files, B = counts.B.files;
const arms = {
  a: [...A.box, ...A.column, ...A.back, ...A.rest],
  b: [...B.box, ...B.column, ...B.back, ...B.rest],
  splice: [...A.box, ...B.column, ...B.back, ...B.rest],
  'a-back': [...A.box, ...A.back, ...B.column, ...B.rest],
  'a-back-b-too': [...A.box, ...A.back, ...B.back, ...B.column, ...B.rest],
};
const navigation = { ...base.navigation, ...(typeof base.floorY === 'number' && { fallbackFloorY: base.floorY }) };
for (const [arm, files] of Object.entries(arms)) {
  const name = `${id}-${arm}`;
  const dir = path.join(ROOT, 'assets/rad_output/Probe', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'pipeline/node_modules/@playcanvas/splat-transform/bin/cli.mjs'), '-w', ...files.flatMap((f) => [f, '-l', '0']), path.join(dir, 'lod-meta.json')], { stdio: ['ignore', 'ignore', 'inherit'], cwd: ROOT });
  if (r.status !== 0) throw new Error(`pack ${name} failed`);
  fs.writeFileSync(path.join(dir, 'viewer.json'), `${JSON.stringify({ renderer: 'gsl', models: [{ url: `/models/Probe/${name}/lod-meta.json` }], camera: base.camera, navigation }, null, 2)}\n`);
  console.log(`packed ${name}`);
}
