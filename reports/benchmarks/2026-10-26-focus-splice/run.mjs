#!/usr/bin/env node
// Focus splice: no training. A's splats inside the focus boxes, a lower-resolution
// model's outside them, packed as ONE SOG level (loaded once, no LoD). README.md here.
//
//   node reports/benchmarks/2026-10-26-focus-splice/run.mjs <command> [--scale <s>] [--margin <m>] [--back <m>]
//
//   prep        W010 cropped to the room (8 outlines) and baked into scene coordinates
//   cut         A inside the boxes (from its 4 parts, each already cropped to its own
//               outlines and baked: ../2026-10-24-hybrid-lod), B and W010 outside them
//   pack        single-SOG arms: a-in-b (A boxes + B rest), a-in-w010 (A boxes + W010 rest),
//               w010 (W010 alone, the like-for-like control for the format)
//
// --scale s grows every box by s along all three of its axes, about its own centre
// (1.5 = 1.5x each side, 3.4x the volume), so A also covers the edges around each
// object. --margin m (metres) adds m to every face instead (after any --scale): a
// fixed band that costs little on large boxes. --back m (default 0) extrudes each
// one-sided box up to m metres behind itself, into the wall: A's splats there, the
// base's dropped. It stops at the next surface (backingDepths). A panel's surface splats are semi-transparent and rely on the backing
// trained behind them; without it the base's blobs in the wall show through (the ghost
// on r3). The camera side comes from the training cameras (regionFacing); boxes seen
// from both sides are not extruded. Files and arms get "-x<s>" / "-m<m>" / "-b<m>"
// suffixes (a-in-b-x1.5-b1); the w010 control is only packed with none of them.
//
// Every cut is by splat CENTRE in scene coordinates (shared/focus-regions.mjs), the
// boxes from scenes/LowCap (the 13 drawn there; same transform as A, B and W010).
// View: http://localhost:5174/?config=/models/Splice/<arm>/viewer.json&renderer=gsl&budget=10M
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quatToMat3, regionBackContains, regionContains, regionFacing } from '../../../shared/focus-regions.mjs';
import { readColmapImages } from '../../../pipeline/lib/colmap.mjs';
import { readRoi } from '../../../pipeline/lib/roi.mjs';
import { readScene } from '../../../pipeline/lib/scene-files.mjs';
import { cropPly, openSplatPly } from '../../../pipeline/lib/splat-crop.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const PLY = (f) => path.join(ROOT, 'assets/source_ply', f);
const REGIONS_SCENE = 'LowCap';
const BASE_SCENE = 'HighRezOculus';
const ROOM_REGION = path.join(ROOT, 'assets/roi/LowCap/AllOutlines.json');
const A_PARTS = ['Oculus12', 'Oculus34', 'Oculus56', 'Oculus78'].map((p) => PLY(`Hybrid-A-${p}-scene.ply`));
const B_SCENE = PLY('LowCap-L0-scene.ply');
const W010_SCENE = PLY('FocusPilot-W010-scene.ply');
const PACK_DIR = path.join(ROOT, 'assets/rad_output/Splice');
// The training cameras of A, B and W010 (one dataset; trained in its own frame).
const CAMERAS = 'C:/Users/yangh/HK_Splats/ArtSciLab_1/OculusV1/outputs/OculusV2_Output/sparse/0/images.bin';

const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const SCALE = option('--scale', 1);
const MARGIN = option('--margin', 0);
const BACK = option('--back', 0);
if (!(SCALE > 0)) throw new Error('--scale must be a positive number');
if (!(MARGIN >= 0)) throw new Error('--margin must be a distance in metres, 0 or more');
if (!(BACK >= 0)) throw new Error('--back must be a distance in metres, 0 or more');
const SUFFIX = `${SCALE === 1 ? '' : `-x${SCALE}`}${MARGIN === 0 ? '' : `-m${MARGIN}`}${BACK === 0 ? '' : `-b${BACK}`}`;
/** A box after --scale (about its centre) and --margin (added to every face). */
const grow = (r) => ({ ...r, size: r.size.map((s) => s * SCALE + 2 * MARGIN) });
const inName = (f) => PLY(`Splice${SUFFIX}-in-${path.basename(f)}`);
const outName = (f) => PLY(`Splice${SUFFIX}-out-${path.basename(f)}`);

function run(cmd, args) {
  console.log(`> ${path.basename(cmd)} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exited with ${r.status}`);
}

function prep() {
  if (fs.existsSync(W010_SCENE)) return console.log(`${path.basename(W010_SCENE)} exists`);
  const roi = readRoi(ROOM_REGION);
  const cropped = PLY('FocusPilot-W010-cropped.ply');
  const r = cropPly({ input: PLY('FocusPilot-W010.ply'), out: cropped, labelOf: (x, y, z) => (roi.contains(x, y, z) ? 1 : 0), numLabels: 2, keep: 1 });
  console.log(`W010: kept ${r.keptSplats} of ${r.totalSplats} inside the room`);
  const tf = path.join(os.tmpdir(), `splice-transform-${process.pid}.json`);
  fs.writeFileSync(tf, JSON.stringify(readScene(path.join(ROOT, `scenes/${BASE_SCENE}/scene.json`)).transform));
  try {
    run(process.execPath, ['pipeline/transform.mjs', cropped, '--transform', tf, '--out', W010_SCENE, '--overwrite']);
  } finally {
    fs.rmSync(tf, { force: true });
    fs.rmSync(cropped, { force: true });
  }
}

/** The training cameras in scene coordinates (BASE_SCENE's transform). */
function sceneCameras() {
  const M = readScene(path.join(ROOT, `scenes/${BASE_SCENE}/scene.json`)).transform.matrix;
  const apply = (p, w) => [0, 1, 2].map((r) => M[r] * p[0] + M[4 + r] * p[1] + M[8 + r] * p[2] + w * M[12 + r]);
  const unit = (v) => v.map((x) => x / Math.hypot(...v));
  return readColmapImages(CAMERAS).map((c) => ({ center: apply(c.center, 1), forward: unit(apply(c.forward, 0)) }));
}

/**
 * How deep each one-sided box's backing goes: A's splats behind the box, in 2.5 cm slabs
 * over its footprint, up to the first slab at a tenth of the box's own density or more.
 * Backing is sparse (r3: ~9k splats/m³ against ~0.5M in the box); a denser slab is the
 * next surface (the floor under a flat screen, a wall behind a free-standing board),
 * which stays the base model's.
 */
function backingDepths(sided) {
  const SLAB = 0.025;
  const slabs = Math.ceil(BACK / SLAB);
  const prof = sided.map(({ region, front }) => ({
    R: quatToMat3(region.quaternion),
    c: region.center,
    axis: region.size.indexOf(Math.min(...region.size)),
    half: region.size.map((s) => s / 2),
    front,
    box: 0,
    slabs: new Array(slabs).fill(0),
  }));
  for (const file of A_PARTS) {
    const ply = openSplatPly(file, () => {});
    const o = ['x', 'y', 'z'].map((k) => ply.props[k].offset);
    const records = Math.floor((32 << 20) / ply.stride);
    const buf = Buffer.alloc(records * ply.stride);
    const fd = fs.openSync(file, 'r');
    try {
      for (let done = 0; done < ply.total;) {
        const want = Math.min(records, ply.total - done);
        fs.readSync(fd, buf, 0, want * ply.stride, ply.header.headerBytes + done * ply.stride);
        for (let i = 0; i < want; i++) {
          const b = i * ply.stride;
          const x = buf.readFloatLE(b + o[0]), y = buf.readFloatLE(b + o[1]), z = buf.readFloatLE(b + o[2]);
          for (const p of prof) {
            const dx = x - p.c[0], dy = y - p.c[1], dz = z - p.c[2];
            let t = 0, out = false;
            for (let a = 0; a < 3 && !out; a++) {
              const l = p.R[a] * dx + p.R[3 + a] * dy + p.R[6 + a] * dz;
              if (a === p.axis) t = -p.front * l;
              else out = Math.abs(l) > p.half[a];
            }
            if (out) continue;
            const h = p.half[p.axis];
            if (Math.abs(t) <= h) p.box++;
            else if (t > h && t <= h + BACK) p.slabs[Math.min(slabs - 1, Math.floor((t - h) / SLAB))]++;
          }
        }
        done += want;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return prof.map((p) => {
    const area = p.half.reduce((s, v, a) => (a === p.axis ? s : s * 2 * v), 1);
    const limit = (0.1 * p.box) / (area * 2 * p.half[p.axis]); // a tenth of the box's density, splats/m³
    let k = 0;
    while (k < slabs && p.slabs[k] / (area * SLAB) < limit) k++;
    return { depth: Math.min(BACK, k * SLAB), splats: p.slabs.slice(0, k).reduce((s, v) => s + v, 0) };
  });
}

function cut() {
  const regions = readScene(path.join(ROOT, `scenes/${REGIONS_SCENE}/scene.json`)).focusRegions.map(grow);
  const tests = regions.map(regionContains);
  const facing = {};
  if (BACK > 0) {
    const cameras = sceneCameras();
    const sided = [];
    for (const r of regions) {
      const f = regionFacing(r, cameras);
      facing[r.id] = { front: f.front, cameras: f.counts };
      if (f.front !== 0) sided.push({ region: r, front: f.front });
    }
    backingDepths(sided).forEach((d, i) => {
      const { region, front } = sided[i];
      Object.assign(facing[region.id], d);
      if (d.depth > 0) tests.push(regionBackContains(region, front, d.depth));
    });
    for (const [id, f] of Object.entries(facing)) {
      console.log(`${id}: ${f.front === 0 ? 'seen from both sides (or unclear), not extruded' : `backing ${f.depth.toFixed(3)} m deep, ${f.splats} of A's splats`} (cameras ${f.cameras.join(' / ')})`);
    }
  }
  const inside = (x, y, z) => tests.some((t) => t(x, y, z));
  const report = { regions: regions.length, scale: SCALE, margin: MARGIN, back: BACK, volume: regions.reduce((s, r) => s + r.size[0] * r.size[1] * r.size[2], 0), facing, inside: {}, outside: {} };
  for (const f of A_PARTS) {
    const r = cropPly({ input: f, out: inName(f), labelOf: (x, y, z) => (inside(x, y, z) ? 1 : 0), numLabels: 2, keep: 1, emptyHint: 'no splat of this part is in a box' });
    report.inside[path.basename(f)] = r.keptSplats;
    console.log(`${path.basename(f)}: ${r.keptSplats} in the boxes`);
  }
  for (const f of [B_SCENE, W010_SCENE]) {
    const r = cropPly({ input: f, out: outName(f), labelOf: (x, y, z) => (inside(x, y, z) ? 0 : 1), numLabels: 2, keep: 1 });
    report.outside[path.basename(f)] = r.keptSplats;
    console.log(`${path.basename(f)}: ${r.keptSplats} outside the boxes`);
  }
  fs.writeFileSync(path.join(import.meta.dirname, `cut${SUFFIX}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

function pack() {
  const base = readScene(path.join(ROOT, `scenes/${BASE_SCENE}/scene.json`));
  const arms = {
    [`a-in-b${SUFFIX}`]: [...A_PARTS.map(inName), outName(B_SCENE)],
    [`a-in-w010${SUFFIX}`]: [...A_PARTS.map(inName), outName(W010_SCENE)],
    ...(SUFFIX === '' && { w010: [W010_SCENE] }),
  };
  for (const [arm, files] of Object.entries(arms)) {
    for (const f of files) if (!fs.existsSync(f)) throw new Error(`missing ${f}: run prep and cut first`);
    const dir = path.join(PACK_DIR, arm);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    run(process.execPath, [path.join(ROOT, 'pipeline/node_modules/@playcanvas/splat-transform/bin/cli.mjs'), '-w', ...files.flatMap((f) => [f, '-l', '0']), path.join(dir, 'lod-meta.json')]);
    // HighRezOculus's start camera, spawn and floor (it has no collision mesh: walk uses the flat floor).
    const navigation = { ...base.navigation, ...(typeof base.floorY === 'number' && { fallbackFloorY: base.floorY }) };
    fs.writeFileSync(path.join(dir, 'viewer.json'), `${JSON.stringify({ renderer: 'gsl', models: [{ url: `/models/Splice/${arm}/lod-meta.json` }], camera: base.camera, navigation }, null, 2)}\n`);
  }
}

const [cmd] = process.argv.slice(2);
const commands = { prep, cut, pack };
if (!commands[cmd]) {
  const lines = fs.readFileSync(import.meta.filename, 'utf8').split('\n');
  console.log(lines.slice(1, lines.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
commands[cmd]();
