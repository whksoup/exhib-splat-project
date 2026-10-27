#!/usr/bin/env node
// Focus-region pilot: does --roi-outside-weight move splats into the drawn
// focus regions? Two short whole-room runs on A's dataset and settings, 6M cap,
// 20k steps, training region = the 13 focus regions drawn in the editor
// (assets/roi/FocusPilot/regions-2026-10-25.json, from `focus-regions.mjs export LowCap`),
// --roi-mask-pixels 0 so the whole room still trains, and outside weight 0.1 / 0.3.
// README.md here.
//
//   node reports/benchmarks/2026-10-25-focus-pilot/run.mjs <command> [runs...]
//
//   check          parse-check the spirula commands (no training)
//   queue [runs]   train the runs one after another (default: all not yet done),
//                  copying each to assets/source_ply/FocusPilot-<run>.ply
//   scenes         one scene per run (HighRezOculus transform, cropped to the 8 room
//                  outlines like LowCap), so quantify and the viewer can use them
//   quantify       splats per focus region in the runs against B, Mid12M and A
//   pack-sog <run> the run cropped to the room, baked into scene coordinates and packed as
//                  ONE SOG level (assets/rad_output/FocusPilot/<run>/), for online review
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRoi } from '../../../pipeline/lib/roi.mjs';
import { cropPly } from '../../../pipeline/lib/splat-crop.mjs';
import { readScene, updateScene } from '../../../pipeline/lib/scene-files.mjs';
import { checkTrainArgs, runSplatPly, SPIRULA, trainArgs } from '../../../pipeline/lib/spirula.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DATASET = 'C:/Users/yangh/HK_Splats/ArtSciLab_1/OculusV1/outputs/OculusV2_Output';
const REF_CONFIG = 'C:/Users/yangh/HK_Splats/ArtSciLab_1/OculusV1/outputs/ROIExploration/Parts78/config.json';
const OUT_PREFIX = 'C:/Users/yangh/HK_Splats/ArtSciLab_1/OculusV1/outputs/FocusPilot';
const FOCUS_REGION = path.join(ROOT, 'assets/roi/FocusPilot/regions-2026-10-25.json');
// LowCap's crop: the 8 room outlines (the same rest-of-room as B, so shares compare).
const ROOM_REGION = path.join(ROOT, 'assets/roi/LowCap/AllOutlines.json');
const REGIONS_SCENE = 'LowCap';
const BASE_SCENE = 'HighRezOculus';
const CAP = 6_000_000;
const ITERATIONS = 20_000;
// W100 (weight 1: "1 turns the region off") is the unweighted control: same cap, steps and settings.
const RUNS = { W010: 0.1, W030: 0.3, W100: 1 };

const sceneOf = (run) => `FocusPilot-${run}`;
const plyOf = (run) => path.join(ROOT, `assets/source_ply/FocusPilot-${run}.ply`);
const overrides = (run) => ({
  output_dir_prefix: OUT_PREFIX,
  output_dir_name: run,
  num_iterations: ITERATIONS,
  cap_max: CAP,
  roi_region: FOCUS_REGION,
  roi_outside_weight: RUNS[run],
  // Train the whole room: the region only steers where splats are added / relocated.
  roi_mask_pixels: false,
  init_ply: null,
});
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function run(cmd, args) {
  console.log(`> ${path.basename(cmd)} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exited with ${r.status}`);
}

function runsOf(list) {
  for (const r of list) if (!(r in RUNS)) throw new Error(`unknown run ${r} (runs: ${Object.keys(RUNS).join(', ')})`);
  return list.length ? list : Object.keys(RUNS);
}

function check() {
  if (!fs.existsSync(FOCUS_REGION)) throw new Error(`missing ${FOCUS_REGION}: node pipeline/focus-regions.mjs export ${REGIONS_SCENE} --out ${path.relative(ROOT, FOCUS_REGION)}`);
  for (const r of Object.keys(RUNS)) {
    checkTrainArgs(REF_CONFIG, overrides(r));
    console.log(`${r}: every flag parsed (outside weight ${RUNS[r]})`);
  }
}

function queue(list) {
  for (const r of runsOf(list)) {
    if (fs.existsSync(plyOf(r))) {
      console.log(`[${stamp()}] ${r}: ${path.relative(ROOT, plyOf(r))} exists, skipped`);
      continue;
    }
    let ply = runSplatPly(path.join(OUT_PREFIX, r));
    if (!ply) {
      console.log(`[${stamp()}] ${r}: training (${CAP / 1e6}M cap, ${ITERATIONS} steps, outside weight ${RUNS[r]})`);
      run(SPIRULA, ['train', ...trainArgs(REF_CONFIG, DATASET, overrides(r)).args]);
      ply = runSplatPly(path.join(OUT_PREFIX, r));
      if (!ply) throw new Error(`${r}: no step-*.ckpt/splat.ply in ${path.join(OUT_PREFIX, r)}`);
    }
    fs.copyFileSync(ply, plyOf(r));
    console.log(`[${stamp()}] ${r}: done -> ${path.relative(ROOT, plyOf(r))}`);
  }
  console.log(`[${stamp()}] queue finished`);
}

function scenes() {
  const base = readScene(path.join(ROOT, `scenes/${BASE_SCENE}/scene.json`));
  for (const r of Object.keys(RUNS)) {
    if (!fs.existsSync(plyOf(r))) throw new Error(`missing ${plyOf(r)}`);
    const file = path.join(ROOT, `scenes/${sceneOf(r)}/scene.json`);
    if (!fs.existsSync(file)) {
      run(process.execPath, ['pipeline/new-scene.mjs', sceneOf(r), '--source', path.relative(ROOT, plyOf(r)), '--transform-from', BASE_SCENE]);
      run(process.execPath, ['pipeline/scene-roi.mjs', sceneOf(r), '--roi', path.relative(ROOT, ROOM_REGION)]);
    }
    updateScene(file, (s) => {
      s.buildOptions = base.buildOptions;
      s.camera = base.camera;
      s.navigation = base.navigation;
      s.floorY = base.floorY;
    });
  }
}

function quantify() {
  const compare = [...Object.keys(RUNS).map(sceneOf), 'Mid12M', BASE_SCENE].flatMap((s) => ['--compare', s]);
  run(process.execPath, ['pipeline/focus-regions.mjs', 'quantify', REGIONS_SCENE, ...compare, '--json', path.relative(ROOT, path.join(import.meta.dirname, 'quantify.json'))]);
}

/** One run as a single SOG level in scene coordinates, with HighRezOculus's camera, spawn and floor. */
function packSog(r) {
  if (!(r in RUNS)) throw new Error(`pack-sog <run> (runs: ${Object.keys(RUNS).join(', ')})`);
  if (!fs.existsSync(plyOf(r))) throw new Error(`missing ${plyOf(r)}: train it first`);
  const base = readScene(path.join(ROOT, `scenes/${BASE_SCENE}/scene.json`));
  const cropped = plyOf(r).replace(/\.ply$/, '-cropped.ply');
  const baked = plyOf(r).replace(/\.ply$/, '-scene.ply');
  if (!fs.existsSync(baked)) {
    const roi = readRoi(ROOM_REGION);
    const c = cropPly({ input: plyOf(r), out: cropped, labelOf: (x, y, z) => (roi.contains(x, y, z) ? 1 : 0), numLabels: 2, keep: 1 });
    console.log(`${r}: kept ${c.keptSplats} of ${c.totalSplats} inside the room`);
    const tf = path.join(os.tmpdir(), `focus-pilot-transform-${process.pid}.json`);
    fs.writeFileSync(tf, JSON.stringify(base.transform));
    try {
      run(process.execPath, ['pipeline/transform.mjs', cropped, '--transform', tf, '--out', baked, '--overwrite']);
    } finally {
      fs.rmSync(tf, { force: true });
      fs.rmSync(cropped, { force: true });
    }
  }
  const dir = path.join(ROOT, `assets/rad_output/FocusPilot/${r}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  run(process.execPath, [path.join(ROOT, 'pipeline/node_modules/@playcanvas/splat-transform/bin/cli.mjs'), '-w', baked, '-l', '0', path.join(dir, 'lod-meta.json')]);
  const navigation = { ...base.navigation, ...(typeof base.floorY === 'number' && { fallbackFloorY: base.floorY }) };
  fs.writeFileSync(path.join(dir, 'viewer.json'), `${JSON.stringify({ renderer: 'gsl', models: [{ url: `/models/FocusPilot/${r}/lod-meta.json` }], camera: base.camera, navigation }, null, 2)}\n`);
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = { check, queue: () => queue(rest), scenes, quantify, 'pack-sog': () => packSog(rest[0]) };
if (!commands[cmd]) {
  const lines = fs.readFileSync(import.meta.filename, 'utf8').split('\n');
  console.log(lines.slice(1, lines.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
commands[cmd]();
