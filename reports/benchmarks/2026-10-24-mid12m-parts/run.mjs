#!/usr/bin/env node
// Mid12M: HighRezOculus retrained at a quarter of its density. The same 4 parts
// (outline pairs 1+2, 3+4, 5+6, 7+8), dataset and Spirula settings as A, but a
// 3M cap per part (12M total, against 4 x 12M). Parts are seamed the way A is:
// build-scene crops each part to its own outlines, and the viewer sorts all
// parts together. README.md here.
//
//   node reports/benchmarks/2026-10-24-mid12m-parts/run.mjs <command> [parts...]
//
//   regions          write the 4 training regions (assets/roi/Mid12M/<part>.json)
//   check            parse-check the 4 spirula commands (no training)
//   queue [parts]    train the parts one after another (default: all not yet done),
//                    copying each result to assets/source_ply/Mid12M-<part>.ply
//   scene            create scenes/Mid12M from the 4 PLYs, then: build-scene.bat Mid12M
//   pack-sog         the 4 parts cropped and baked as build-scene does, packed as ONE SOG
//                    level (no LoD, loaded once): assets/rad_output/Mid12M/sog/lod-meta.json
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRoi } from '../../../pipeline/lib/roi.mjs';
import { cropPly } from '../../../pipeline/lib/splat-crop.mjs';
import { readScene, updateScene } from '../../../pipeline/lib/scene-files.mjs';
import { checkTrainArgs, runSplatPly, SPIRULA, trainArgs, writeOutlineUnion } from '../../../pipeline/lib/spirula.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DATASET = 'C:/Users/yangh/HK_Splats/ArtSciLab_1/OculusV1/outputs/OculusV2_Output';
// A's own settings (Parts78 is one of its four runs; the four differ only in name and region).
const REF_CONFIG = 'C:/Users/yangh/HK_Splats/ArtSciLab_1/OculusV1/outputs/ROIExploration/Parts78/config.json';
const OUT_PREFIX = 'C:/Users/yangh/HK_Splats/ArtSciLab_1/OculusV1/outputs/Mid12M';
const SOURCE_REGION = path.join(ROOT, 'assets/roi/HighRezOculus/Oculus6Part.json');
const BASE_SCENE = 'HighRezOculus';
const SCENE = 'Mid12M';
const CAP = 3_000_000;
const ITERATIONS = 80_000;
const PARTS = {
  Parts12: ['Outline 1', 'Outline 2'],
  Parts34: ['Outline 3', 'Outline 4'],
  Parts56: ['Outline 5', 'Outline 6'],
  Parts78: ['Outline 7', 'Outline 8'],
};

const regionOf = (part) => path.join(ROOT, `assets/roi/${SCENE}/${part}.json`);
const plyOf = (part) => path.join(ROOT, `assets/source_ply/${SCENE}-${part}.ply`);
const overrides = (part) => ({ output_dir_prefix: OUT_PREFIX, output_dir_name: part, num_iterations: ITERATIONS, cap_max: CAP, roi_region: regionOf(part), init_ply: null });
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function run(cmd, args) {
  console.log(`> ${path.basename(cmd)} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exited with ${r.status}`);
}

function partsOf(list) {
  for (const p of list) if (!PARTS[p]) throw new Error(`unknown part ${p} (parts: ${Object.keys(PARTS).join(', ')})`);
  return list.length ? list : Object.keys(PARTS);
}

function regions() {
  for (const [part, outlines] of Object.entries(PARTS)) {
    const digest = writeOutlineUnion(SOURCE_REGION, outlines, regionOf(part));
    console.log(`${path.relative(ROOT, regionOf(part))}: ${outlines.join(' + ')} (digest ${digest})`);
  }
}

function check() {
  for (const part of Object.keys(PARTS)) {
    if (!fs.existsSync(regionOf(part))) throw new Error(`missing ${regionOf(part)}: run "regions" first`);
    checkTrainArgs(REF_CONFIG, overrides(part));
    console.log(`${part}: every flag parsed`);
  }
}

/** Train each part in turn; a part whose PLY is already in place is skipped, so the queue can be re-run after a failure. */
function queue(list) {
  for (const part of partsOf(list)) {
    if (fs.existsSync(plyOf(part))) {
      console.log(`[${stamp()}] ${part}: ${path.relative(ROOT, plyOf(part))} exists, skipped`);
      continue;
    }
    let ply = runSplatPly(path.join(OUT_PREFIX, part));
    if (!ply) {
      console.log(`[${stamp()}] ${part}: training (${CAP / 1e6}M cap, ${ITERATIONS} steps, ${PARTS[part].join(' + ')})`);
      run(SPIRULA, ['train', ...trainArgs(REF_CONFIG, DATASET, overrides(part)).args]);
      ply = runSplatPly(path.join(OUT_PREFIX, part));
      if (!ply) throw new Error(`${part}: training finished but no step-*.ckpt/splat.ply in ${path.join(OUT_PREFIX, part)}`);
    }
    fs.copyFileSync(ply, plyOf(part));
    console.log(`[${stamp()}] ${part}: done -> ${path.relative(ROOT, plyOf(part))}`);
  }
  console.log(`[${stamp()}] queue finished. Next: node ${path.relative(ROOT, import.meta.filename)} scene`);
}

function scene() {
  for (const part of Object.keys(PARTS)) if (!fs.existsSync(plyOf(part))) throw new Error(`missing ${plyOf(part)}`);
  run(process.execPath, ['pipeline/new-scene.mjs', SCENE, ...Object.keys(PARTS).flatMap((p) => ['--source', path.relative(ROOT, plyOf(p))]), '--transform-from', BASE_SCENE]);
  const ids = readScene(path.join(ROOT, `scenes/${SCENE}/scene.json`)).parts.map((p) => p.id);
  // Each part is cropped to the outlines it trained on: the seam is the outline boundary, as in A.
  for (const [part, outlines] of Object.entries(PARTS)) {
    const id = ids.find((i) => i.endsWith(part));
    run(process.execPath, ['pipeline/scene-roi.mjs', SCENE, '--roi', path.relative(ROOT, SOURCE_REGION), '--part', id, ...outlines.flatMap((o) => ['--outline', o])]);
  }
  // Same build-lod options (SH 3), start camera and spawn as A.
  const base = readScene(path.join(ROOT, `scenes/${BASE_SCENE}/scene.json`));
  updateScene(path.join(ROOT, `scenes/${SCENE}/scene.json`), (s) => {
    s.buildOptions = base.buildOptions;
    s.camera = base.camera;
    s.navigation = base.navigation;
    s.floorY = base.floorY;
  });
  console.log(`Next: build-scene.bat ${SCENE}`);
}

/**
 * Mid12M as a single SOG level: every part cropped to its outlines and baked into scene
 * coordinates (GSL draws SOG streams under a scaled group wrongly), then one splat-transform
 * pack with every part at level 0. With one level nothing switches or is released: it loads
 * once, like ../2026-10-23-streaming-vs-count's "single SOG" arms.
 */
function packSog() {
  const base = readScene(path.join(ROOT, `scenes/${BASE_SCENE}/scene.json`));
  const tf = path.join(os.tmpdir(), `mid12m-transform-${process.pid}.json`);
  fs.writeFileSync(tf, JSON.stringify(base.transform));
  const baked = [];
  try {
    for (const [part, outlines] of Object.entries(PARTS)) {
      const out = path.join(ROOT, `assets/source_ply/${SCENE}-${part}-scene.ply`);
      baked.push(out);
      if (fs.existsSync(out)) continue;
      const roi = readRoi(SOURCE_REGION, outlines);
      const cropped = out.replace(/-scene\.ply$/, '-cropped.ply');
      const r = cropPly({ input: plyOf(part), out: cropped, labelOf: (x, y, z) => (roi.contains(x, y, z) ? 1 : 0), numLabels: 2, keep: 1 });
      console.log(`${part}: kept ${r.keptSplats} of ${r.totalSplats}`);
      try {
        run(process.execPath, ['pipeline/transform.mjs', cropped, '--transform', tf, '--out', out, '--overwrite']);
      } finally {
        fs.rmSync(cropped, { force: true });
      }
    }
  } finally {
    fs.rmSync(tf, { force: true });
  }
  const dir = path.join(ROOT, `assets/rad_output/${SCENE}/sog`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  run(process.execPath, [path.join(ROOT, 'pipeline/node_modules/@playcanvas/splat-transform/bin/cli.mjs'), '-w', ...baked.flatMap((f) => [f, '-l', '0']), path.join(dir, 'lod-meta.json')]);
  fs.writeFileSync(path.join(dir, 'viewer.json'), `${JSON.stringify({ renderer: 'gsl', models: [{ url: `/models/${SCENE}/sog/lod-meta.json` }], camera: base.camera }, null, 2)}\n`);
  console.log(`view: http://localhost:5174/?config=/models/${SCENE}/sog/viewer.json`);
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = { regions, check, queue: () => queue(rest), scene, 'pack-sog': packSog };
if (!commands[cmd]) {
  const lines = fs.readFileSync(import.meta.filename, 'utf8').split('\n');
  console.log(lines.slice(1, lines.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
commands[cmd]();
