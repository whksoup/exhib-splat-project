#!/usr/bin/env node
// Low-cap experiment driver (README.md here). Every step is one subcommand, run
// from the repo root; nothing runs on its own.
//
//   node reports/benchmarks/2026-10-23-lowcap-retrained-lod/run.mjs <command> [args]
//
//   region                 write the training region: the union of all 8 HighRezOculus outlines
//   args <stage> [--check] print the spirula command for L0..L3; --check parses it against a missing dataset
//   train <stage>          run that spirula training (hours for L0)
//   scene                  create scenes/LowCap from LowCap-L0.ply (HighRezOculus transform, region crop)
//   init <stage>           merge the cropped L0 down to the stage's count: the start of its retrain
//   prep <stage>           crop a trained level to the region and bake the scene transform (SOG arms)
//   prep-init <stage>      bake a merge-only init (the "merged" control arm)
//   downsample [count]     merge HighRezOculus (44.5M) down to L0's count (or count) and bake it (the "downsampled" arm)
//   pack <retrained|merged|l0|downsampled|downsampled-<n>k|smoke>   splat-transform the levels into assets/rad_output/LowCap/<arm>/lod-meta.json
//
// The comparison itself (screenshots + stats per arm, view and budget) is compare.mjs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRoi, readRoiJson } from '../../../pipeline/lib/roi.mjs';
import { readScene, updateScene } from '../../../pipeline/lib/scene-files.mjs';
import { cropPly } from '../../../pipeline/lib/splat-crop.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SPIRULA = 'C:/Users/yangh/Spirula/spirula.exe';
const DATASET = 'C:/Users/yangh/HK_Splats/ArtSciLab_1/OculusV1/outputs/OculusV2_Output';
// The settings every HighRezOculus part was trained with (the GUI's, not the CLI defaults).
const REF_CONFIG = 'C:/Users/yangh/HK_Splats/ArtSciLab_1/OculusV1/outputs/ROIExploration/Parts78/config.json';
const OUT_PREFIX = 'C:/Users/yangh/HK_Splats/ArtSciLab_1/OculusV1/outputs/LowCap';
const SOURCE_REGION = path.join(ROOT, 'assets/roi/HighRezOculus/Oculus6Part.json');
const REGION = path.join(ROOT, 'assets/roi/LowCap/AllOutlines.json');
const OUTLINES = Array.from({ length: 8 }, (_, i) => `Outline ${i + 1}`);
const BASE_SCENE = 'HighRezOculus';
const SCENE = 'LowCap';
const PLY_DIR = path.join(ROOT, 'assets/source_ply');
const PACK_DIR = path.join(ROOT, 'assets/rad_output/LowCap');

// Halving levels, like the reference (1.58M / 750k / 375k / 187.5k).
const STAGES = {
  L0: { splats: 4_000_000, iterations: 80_000 },
  L1: { splats: 2_000_000, iterations: 20_000 },
  L2: { splats: 1_000_000, iterations: 20_000 },
  L3: { splats: 500_000, iterations: 20_000 },
};
// Retrains start from a merged copy of L0 that already has the final count: no
// growth, MCMC only relocates dead splats. Less position noise and a slower
// mean step so the start isn't scrambled; SH steps up at once (the start has SH3).
// These are a first guess: check L1 before running L2/L3.
const FINETUNE = { noise_lr: 8, means_lr: 3.2e-5, sh_degree_warmup_every: 1 };

const plyOf = (stage) => path.join(PLY_DIR, `LowCap-${stage}.ply`);
const croppedOf = (stage) => path.join(PLY_DIR, `LowCap-${stage}-cropped.ply`);
const initOf = (stage) => path.join(PLY_DIR, `LowCap-${stage}-init.ply`);
/** Cropped and baked into scene coordinates (the SOG arms). */
const sceneOf = (stage) => path.join(PLY_DIR, `LowCap-${stage}-scene.ply`);
/** HighRezOculus merged down to n splats (the "downsampled" arms), before and after baking. */
const miniOf = (n) => path.join(PLY_DIR, `${BASE_SCENE}-mini-${n / 1000}k.ply`);
const miniSceneOf = (n) => miniOf(n).replace(/\.ply$/, '-scene.ply');

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exited with ${r.status}`);
}

function stageOf(name) {
  if (!STAGES[name]) throw new Error(`stage must be one of ${Object.keys(STAGES).join(', ')}`);
  return STAGES[name];
}

/** One region holding all 8 outlines, as Spirula's ROI editor writes a union (editor block kept, all enabled). */
function region() {
  const src = readRoiJson(SOURCE_REGION);
  const all = readRoi(SOURCE_REGION, OUTLINES);
  const children = src.editor.shapes.filter((s) => OUTLINES.includes(s.name)).map((s) => {
    const R = s.rotation;
    const mid = (s.lo[2] + s.hi[2]) / 2;
    return { type: 'prism', center: [0, 1, 2].map((i) => s.origin[i] + R[3 * i + 2] * mid), rotation: R, half_height: (s.hi[2] - s.lo[2]) / 2, polygon: s.polygon };
  });
  const json = { type: 'union', children, editor: { ...src.editor, shapes: src.editor.shapes.map((s) => ({ ...s, enabled: OUTLINES.includes(s.name) })) } };
  fs.mkdirSync(path.dirname(REGION), { recursive: true });
  fs.writeFileSync(REGION, JSON.stringify(json, null, 2));
  const back = readRoi(REGION);
  if (back.digest !== all.digest) throw new Error(`region digest ${back.digest} != the 8 outlines' ${all.digest}`);
  console.log(`${path.relative(ROOT, REGION)}: union of ${children.length} outlines (digest ${back.digest}, same as the outlines in ${path.relative(ROOT, SOURCE_REGION)})`);
}

/** Flags `spirula train --help-all` lists, as snake_case. */
function spirulaFlags() {
  const r = spawnSync(SPIRULA, ['train', '--help-all'], { encoding: 'utf8' });
  return new Set([...(r.stdout + r.stderr).matchAll(/^ {2}--([a-z0-9-]+)/gm)].map((m) => m[1].replace(/-/g, '_')));
}

function trainArgs(name, data = DATASET) {
  const st = stageOf(name);
  // Spirula writes infinite values as a bare Infinity (not JSON); the CLI spells them inf.
  const ref = JSON.parse(fs.readFileSync(REF_CONFIG, 'utf8').replace(/:\s*(-?)Infinity\b/g, ': "$1inf"'));
  const flags = spirulaFlags();
  const set = {
    ...ref,
    output_dir_prefix: OUT_PREFIX,
    output_dir_name: name,
    num_iterations: st.iterations,
    cap_max: st.splats,
    roi_region: REGION,
    init_ply: name === 'L0' ? null : initOf(name),
    resume: null,
    ...(name === 'L0' ? {} : FINETUNE),
  };
  const args = [ref.preset ?? '3dgs', '--data', data];
  const skipped = [];
  for (const [k, v] of Object.entries(set)) {
    if (k === 'preset' || k === 'data') continue;
    if (!flags.has(k)) {
      skipped.push(k);
      continue;
    }
    const value = v === null ? ['none'] : v === true ? ['1'] : v === false ? ['0'] : Array.isArray(v) ? v.map(String) : [String(v)];
    args.push(`--${k.replace(/_/g, '-')}`, ...value);
  }
  return { args, skipped };
}

function args(name, check) {
  const { args: a, skipped } = trainArgs(name, check ? 'C:/lowcap-check-no-such-dataset' : DATASET);
  if (skipped.length) console.log(`not CLI flags, left out: ${skipped.join(', ')}`);
  console.log([SPIRULA, 'train', ...a].join(' '));
  if (!check) return;
  const r = spawnSync(SPIRULA, ['train', ...a], { encoding: 'utf8' });
  const out = (r.stdout + r.stderr).trim().split(/\r?\n/).at(-1);
  // Spirula checks the init PLY before the dataset: a retrain stage checked before its "init" stops there.
  const missingInit = name !== 'L0' && !fs.existsSync(initOf(name)) && /no splat\.ply found under/.test(out);
  if (!/dataset path does not exist/.test(out) && !missingInit) throw new Error(`flags rejected: ${out}`);
  console.log(`check: every flag parsed (stopped at the missing ${missingInit ? 'init PLY' : 'dataset'}, as intended)`);
}

function train(name) {
  if (name !== 'L0' && !fs.existsSync(initOf(name))) throw new Error(`missing ${initOf(name)}: run "init ${name}" first`);
  run(SPIRULA, ['train', ...trainArgs(name).args]);
  const dir = path.join(OUT_PREFIX, name);
  const found = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.ply'));
  console.log(found.length
    ? `PLY in the run folder: ${found.join(', ')}. Copy it to ${plyOf(name)}.`
    : `No .ply in ${dir}: export the run from Spirula Studio to ${plyOf(name)} (as for Oculus12..78).`);
}

function scene() {
  if (!fs.existsSync(plyOf('L0'))) throw new Error(`missing ${plyOf('L0')}`);
  run(process.execPath, ['pipeline/new-scene.mjs', SCENE, '--source', path.relative(ROOT, plyOf('L0')), '--transform-from', BASE_SCENE]);
  run(process.execPath, ['pipeline/scene-roi.mjs', SCENE, '--roi', path.relative(ROOT, REGION)]);
  // Same build-lod options as the base scene (HighRezOculus keeps SH 3; a new scene would build at SH 1),
  // and the same start camera and spawn, so arm B differs from arm A only in its source.
  const base = readScene(path.join(ROOT, `scenes/${BASE_SCENE}/scene.json`));
  updateScene(path.join(ROOT, `scenes/${SCENE}/scene.json`), (s) => {
    s.buildOptions = base.buildOptions;
    s.camera = base.camera;
    s.navigation = base.navigation;
    s.floorY = base.floorY;
  });
  console.log(`Next: build-scene.bat ${SCENE} (build-lod arm), then "init L1".`);
}

function init(name) {
  if (name === 'L0') throw new Error('L0 trains from the dataset');
  run(process.execPath, ['pipeline/miniature.mjs', SCENE, '--target', String(stageOf(name).splats), '--out', path.relative(ROOT, initOf(name)), '--overwrite']);
}

/**
 * Bake HighRezOculus's transform into a source-frame PLY (pipeline/transform.mjs, verified).
 * The SOG arms must be packed in scene coordinates: GSL 1.4.0 draws a SOG stream under a
 * scaled group as blurred blobs (seen in the smoke test), so they can't take a model matrix.
 */
function bake(input, out) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, `scenes/${BASE_SCENE}/scene.json`), 'utf8'));
  const tf = path.join(os.tmpdir(), `lowcap-transform-${process.pid}.json`);
  fs.writeFileSync(tf, JSON.stringify(base.transform));
  try {
    run(process.execPath, ['pipeline/transform.mjs', input, '--transform', tf, '--out', out, '--overwrite']);
  } finally {
    fs.rmSync(tf, { force: true });
  }
}

/** A trained level, cropped to the region and baked into scene coordinates: what the SOG arms pack. */
function prep(name) {
  stageOf(name);
  const roi = readRoi(REGION);
  const r = cropPly({ input: plyOf(name), out: croppedOf(name), labelOf: (x, y, z) => (roi.contains(x, y, z) ? 1 : 0), numLabels: 2, keep: 1, emptyHint: 'nothing inside the region' });
  console.log(`${path.basename(r.out)}: kept ${r.keptSplats} of ${r.totalSplats} (${r.seconds.toFixed(1)} s)`);
  bake(croppedOf(name), sceneOf(name));
  fs.rmSync(croppedOf(name));
}

/** A merge-only init (already cropped by miniature.mjs), baked: the "merged" control's level. */
function prepInit(name) {
  if (name === 'L0') throw new Error('L0 has no init');
  bake(initOf(name), sceneOf(`${name}-init`));
}

/**
 * The 44.5M build merged straight down to L0's count at SH 3, no training: is a
 * model trained at 4M (arm E) better than the big model downsampled to 4M?
 * miniature.mjs crops each part to its own outlines, the same region as AllOutlines.
 * Skips the merge when its output exists; delete it to redo. Another count (10000000:
 * a single 10M file, the frame-time control in ../2026-10-23-streaming-vs-count) packs as
 * "downsampled-<n/1000>k".
 */
function downsample(n = STAGES.L0.splats) {
  if (!Number.isInteger(n) || n <= 0) throw new Error('count must be a positive integer');
  if (!fs.existsSync(miniOf(n))) {
    run(process.execPath, ['pipeline/miniature.mjs', BASE_SCENE, '--target', String(n), '--sh', '3', '--out', path.relative(ROOT, miniOf(n))]);
  }
  bake(miniOf(n), miniSceneOf(n));
}

/**
 * retrained: trained levels L0..L3.  merged: L0 plus the merge-only inits (same
 * counts, no retrain: the control).  l0: L0 alone (SOG compression vs the RAD
 * build of the same splats).  downsampled: HighRezOculus merged to L0's count,
 * alone (downsampled big model vs trained small model, against l0).  smoke: the two HighRezOculus miniatures as L0/L1,
 * to test packaging and the viewer before any training.
 */
function pack(arm) {
  const smokeIn = ['3000k', '1500k'].map((k) => path.join(PLY_DIR, `HighRezOculus-mini-${k}.ply`));
  const levels = {
    retrained: ['L0', 'L1', 'L2', 'L3'].map(sceneOf),
    merged: [sceneOf('L0'), ...['L1', 'L2', 'L3'].map((s) => sceneOf(`${s}-init`))],
    l0: [sceneOf('L0')],
    downsampled: [miniSceneOf(STAGES.L0.splats)],
    smoke: smokeIn.map((f) => path.join(os.tmpdir(), `lowcap-smoke-${path.basename(f)}`)),
  }[arm] ?? (/^downsampled-\d+k$/.test(arm) ? [miniSceneOf(Number(arm.slice(12, -1)) * 1000)] : null);
  if (!levels) throw new Error('arm must be retrained, merged, l0, downsampled, downsampled-<n>k or smoke');
  if (arm === 'smoke') smokeIn.forEach((f, i) => bake(f, levels[i]));
  for (const f of levels) if (!fs.existsSync(f)) throw new Error(`missing ${f}: run "prep" / "prep-init" first`);
  const out = path.join(PACK_DIR, arm, 'lod-meta.json');
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const a = ['-w'];
  // Levels must share the SH band count; the 3M miniature was written at SH 1.
  levels.forEach((f, i) => a.push(f, ...(arm === 'smoke' ? ['-H', '1'] : []), '-l', String(i)));
  a.push(out);
  try {
    run(process.execPath, [path.join(ROOT, 'pipeline/node_modules/@playcanvas/splat-transform/bin/cli.mjs'), ...a]);
  } finally {
    if (arm === 'smoke') for (const f of levels) fs.rmSync(f, { force: true });
  }
  writeConfig(arm);
}

/**
 * Debug-viewer config of a packed arm, beside it (dev server: ?config=/models/LowCap/<arm>/viewer.json),
 * not in viewer-v2/public, which the static publish copies. Scene coordinates, so no model matrix.
 */
function writeConfig(arm) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, `scenes/${BASE_SCENE}/scene.json`), 'utf8'));
  const cfg = { renderer: 'gsl', models: [{ url: `/models/LowCap/${arm}/lod-meta.json` }], camera: base.camera };
  const file = path.join(PACK_DIR, arm, 'viewer.json');
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`${path.relative(ROOT, file)} -> http://localhost:5174/?config=/models/LowCap/${arm}/viewer.json`);
}

const [cmd, a1, ...rest] = process.argv.slice(2);
const commands = {
  region: () => region(),
  args: () => args(a1, rest.includes('--check')),
  train: () => train(a1),
  scene: () => scene(),
  init: () => init(a1),
  prep: () => prep(a1),
  'prep-init': () => prepInit(a1),
  downsample: () => downsample(a1 === undefined ? undefined : Number(a1)),
  pack: () => pack(a1),
};
if (!commands[cmd]) {
  const lines = fs.readFileSync(import.meta.filename, 'utf8').split('\n');
  console.log(lines.slice(1, lines.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
commands[cmd]();
