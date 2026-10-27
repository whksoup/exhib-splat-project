#!/usr/bin/env node
// Hybrid LoD (option 3): A's full detail as the finest level, B as the coarse
// level, in one streamed SOG (splat-transform lod-meta.json). GSL picks a level
// per chunk by distance, so near chunks draw A (44.5M, 4 parts) and far chunks
// draw B (the 4M whole-room run, ../2026-10-23-lowcap-retrained-lod). README.md here.
//
//   node reports/benchmarks/2026-10-24-hybrid-lod/run.mjs <command>
//
//   prep            crop A's 4 parts to their outline pairs and bake the scene transform
//                   (assets/source_ply/Hybrid-A-<part>-scene.ply, ~2.8 GB each)
//   pack [extent] [--cpu]   A at level 0 + B at level 1 -> assets/rad_output/Hybrid/ab/lod-meta.json;
//                   chunks ~extent m wide (default 4). SOG compression (SH k-means) runs on
//                   the GPU; --cpu forces the CPU, which is far too slow at this size (6.5 h
//                   got through 1 of 78 files), so run it when no training holds the GPU.
//
// View: http://localhost:5174/?config=/models/Hybrid/ab/viewer.json
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRoi } from '../../../pipeline/lib/roi.mjs';
import { cropPly } from '../../../pipeline/lib/splat-crop.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const BASE_SCENE = 'HighRezOculus';
const SOURCE_REGION = path.join(ROOT, 'assets/roi/HighRezOculus/Oculus6Part.json');
const PLY_DIR = path.join(ROOT, 'assets/source_ply');
const PACK_DIR = path.join(ROOT, 'assets/rad_output/Hybrid');
// A's parts and the outlines each was trained on and is cropped to (scenes/HighRezOculus/scene.json).
const A_PARTS = {
  Oculus12: ['Outline 1', 'Outline 2'],
  Oculus34: ['Outline 3', 'Outline 4'],
  Oculus56: ['Outline 5', 'Outline 6'],
  Oculus78: ['Outline 7', 'Outline 8'],
};
// B: the 4M whole-room run, cropped to all 8 outlines and baked (lowcap run.mjs "prep L0").
const B_SCENE_PLY = path.join(PLY_DIR, 'LowCap-L0-scene.ply');

const aSceneOf = (part) => path.join(PLY_DIR, `Hybrid-A-${part}-scene.ply`);

function run(cmd, args) {
  console.log(`> ${path.basename(cmd)} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exited with ${r.status}`);
}

/** HighRezOculus's transform baked into a source-frame PLY (verified by transform.mjs). */
function bake(input, out) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, `scenes/${BASE_SCENE}/scene.json`), 'utf8'));
  const tf = path.join(os.tmpdir(), `hybrid-transform-${process.pid}.json`);
  fs.writeFileSync(tf, JSON.stringify(base.transform));
  try {
    run(process.execPath, ['pipeline/transform.mjs', input, '--transform', tf, '--out', out, '--overwrite']);
  } finally {
    fs.rmSync(tf, { force: true });
  }
}

/** Each A part cropped exactly as build-scene crops it, then baked. Skips parts already done. */
function prep() {
  for (const [part, outlines] of Object.entries(A_PARTS)) {
    if (fs.existsSync(aSceneOf(part))) {
      console.log(`${path.basename(aSceneOf(part))} exists, skipped`);
      continue;
    }
    const roi = readRoi(SOURCE_REGION, outlines);
    const cropped = path.join(PLY_DIR, `Hybrid-A-${part}-cropped.ply`);
    const r = cropPly({ input: path.join(PLY_DIR, `${part}.ply`), out: cropped, labelOf: (x, y, z) => (roi.contains(x, y, z) ? 1 : 0), numLabels: 2, keep: 1 });
    console.log(`${part}: kept ${r.keptSplats} of ${r.totalSplats} (${outlines.join(' + ')}, ${r.seconds.toFixed(1)} s)`);
    try {
      bake(cropped, aSceneOf(part));
    } finally {
      fs.rmSync(cropped, { force: true });
    }
  }
}

function pack(extent = 4, cpu = false) {
  const a = Object.keys(A_PARTS).map(aSceneOf);
  for (const f of [...a, B_SCENE_PLY]) if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
  const out = path.join(PACK_DIR, 'ab', 'lod-meta.json');
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ['-w', ...(cpu ? ['-g', 'cpu'] : []), '--lod-chunk-extent', String(extent)];
  for (const f of a) args.push(f, '-l', '0');
  args.push(B_SCENE_PLY, '-l', '1', out);
  const t0 = Date.now();
  run(process.execPath, ['--max-old-space-size=40000', path.join(ROOT, 'pipeline/node_modules/@playcanvas/splat-transform/bin/cli.mjs'), ...args]);
  console.log(`packed in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, `scenes/${BASE_SCENE}/scene.json`), 'utf8'));
  fs.writeFileSync(path.join(PACK_DIR, 'ab', 'viewer.json'), `${JSON.stringify({ renderer: 'gsl', models: [{ url: '/models/Hybrid/ab/lod-meta.json' }], camera: base.camera }, null, 2)}\n`);
  console.log('view: http://localhost:5174/?config=/models/Hybrid/ab/viewer.json');
}

const [cmd, ...rest] = process.argv.slice(2);
const extentArg = rest.find((a) => !a.startsWith('--'));
const commands = { prep, pack: () => pack(extentArg === undefined ? undefined : Number(extentArg), rest.includes('--cpu')) };
if (!commands[cmd]) {
  const lines = fs.readFileSync(import.meta.filename, 'utf8').split('\n');
  console.log(lines.slice(1, lines.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
commands[cmd]();
