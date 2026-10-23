#!/usr/bin/env node
// Set (or remove) the region of interest of a scene's parts, so build-scene.mjs
// builds only the splats inside it.
//
//   node pipeline/scene-roi.mjs <scene> --roi <region.json> [--outline <name>]... [--part <id>]... [--overwrite] [--dry-run]
//   node pipeline/scene-roi.mjs <scene> --off [--part <id>]...
//
// Why: a Spirula ROI training (--roi-region) reconstructs the region it was
// given, but its export still holds the rest of the scene, faded and at low
// detail. The region file is Spirula's ROI editor output (<dataset>/roi/*.json,
// see lib/roi.mjs). Spirula overwrites that file when the region is edited and
// does not keep a copy per training run, so a region outside the repo is first
// copied to assets/roi/<scene>/<file name> and the scene points at the copy.
// Without --part every part gets the region. --outline picks outlines saved
// in the file's editor block (several: their union) instead of its top-level
// region: one region file often holds every variant drawn, with different ones
// enabled for each training.
// Only scene.json (and the copy) is written; run build-scene.mjs afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_ROOT, SCENES_ROOT } from './lib/config.mjs';
import { readScene, scenePaths, updateScene } from './lib/scene-files.mjs';
import { readRoi, readRoiJson, roiOutlines } from './lib/roi.mjs';
import { openSplatPly } from './lib/splat-crop.mjs';
import { isValidPartId, isValidSceneName } from '../shared/scene-schema.mjs';

export const SCENE_ROI_USAGE = `Usage:
  node pipeline/scene-roi.mjs <scene> --roi <region.json> [--outline <name>]... [--part <id>]... [--overwrite] [--dry-run]
  node pipeline/scene-roi.mjs <scene> --off [--part <id>]...

  --roi <json>     Spirula ROI region file (e.g. <dataset>/roi/region6.json). Outside the repo it is
                   copied to assets/roi/<scene>/ first (Spirula overwrites its own copy).
  --outline <name> Use this outline saved in the file (e.g. "Outline 2") instead of its top-level region.
                   Repeat for a part trained on several outlines (their union).
  --part <id>      Only these parts (repeatable). Default: every part.
  --overwrite      Replace an existing copy in assets/roi/<scene>/ that holds a different region.
  --off            Remove the region: the parts are built whole again.
  --dry-run        Print what would be set; write nothing.`;

export function parseSceneRoiArgs(argv) {
  const opts = { name: null, roi: null, outlines: [], parts: [], off: false, overwrite: false, dryRun: false, help: false };
  const errors = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const flag = a.startsWith('--') ? a.split('=')[0] : a;
    const takeValue = () => {
      const eq = a.indexOf('=');
      if (a.startsWith('--') && eq > 0) return a.slice(eq + 1);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { errors.push(`${flag} needs a value`); return null; }
      i++;
      return v;
    };
    switch (flag) {
      case '-h': case '--help': opts.help = true; break;
      case '--roi': opts.roi = takeValue(); break;
      case '--outline': { const v = takeValue(); if (v && !opts.outlines.includes(v)) opts.outlines.push(v); break; }
      case '--off': opts.off = true; break;
      case '--overwrite': opts.overwrite = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--part': {
        const v = takeValue();
        if (v === null) break;
        if (!isValidPartId(v)) errors.push(`Invalid part id "${v}"`);
        else if (!opts.parts.includes(v)) opts.parts.push(v);
        break;
      }
      default:
        if (a.startsWith('-')) errors.push(`Unknown option: ${a}`);
        else positional.push(a);
    }
  }
  if (opts.help) return { opts, errors: [] };
  if (positional.length !== 1) errors.push('Expected one scene name');
  else if (!isValidSceneName(positional[0])) errors.push(`Invalid scene name "${positional[0]}"`);
  opts.name = positional[0] ?? null;
  if (opts.off && (opts.roi || opts.outlines.length)) errors.push('--off takes no --roi or --outline');
  if (!opts.off && !opts.roi) errors.push('Missing --roi <region.json> (or --off)');
  if (opts.roi && !opts.roi.toLowerCase().endsWith('.json')) errors.push('--roi must be a .json region file');
  return { opts, errors };
}

/**
 * Repo-relative path of the region to store in scene.json. A file inside the
 * repo is used where it is; one outside is copied to assets/roi/<scene>/.
 * @returns {{ rel: string, copyFrom: string|null }}
 */
export function roiTarget(file, sceneName, { root = PROJECT_ROOT, overwrite = false } = {}) {
  const abs = path.resolve(root, file);
  const json = readRoiJson(abs); // must parse before anything is copied
  const inRepo = path.relative(root, abs);
  if (inRepo && !inRepo.startsWith('..') && !path.isAbsolute(inRepo)) return { rel: inRepo.split(path.sep).join('/'), copyFrom: null };
  const rel = `assets/roi/${sceneName}/${path.basename(abs)}`;
  const dest = path.resolve(root, rel);
  if (fs.existsSync(dest)) {
    // Whole content, outlines included: a re-saved file may only have new outlines.
    if (JSON.stringify(readRoiJson(dest)) === JSON.stringify(json)) return { rel, copyFrom: null };
    if (!overwrite) throw new Error(`${rel} already holds a different region file (pass --overwrite to replace it; parts built from the old one are rebuilt only where their region changed)`);
  }
  return { rel, copyFrom: abs };
}

/** Share of `samples` evenly spaced splats of a .ply that lie inside the region. */
export function shareInside(plyPath, region, samples = 20000) {
  const ply = openSplatPly(plyPath, () => {});
  const { header, props, stride, total } = ply;
  const n = Math.min(samples, total);
  const rec = Buffer.alloc(stride);
  let inside = 0;
  let sampled = 0;
  const fd = fs.openSync(ply.input, 'r');
  try {
    for (let s = 0; s < n; s++) {
      fs.readSync(fd, rec, 0, stride, header.headerBytes + Math.floor(((s + 0.5) * total) / n) * stride);
      const x = rec.readFloatLE(props.x.offset), y = rec.readFloatLE(props.y.offset), z = rec.readFloatLE(props.z.offset);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      sampled++;
      if (region.contains(x, y, z)) inside++;
    }
  } finally {
    fs.closeSync(fd);
  }
  return sampled ? inside / sampled : 0;
}

async function main() {
  const { opts, errors } = parseSceneRoiArgs(process.argv.slice(2));
  if (opts.help) { console.log(SCENE_ROI_USAGE); return 0; }
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`\n${SCENE_ROI_USAGE}`);
    return 2;
  }
  const paths = scenePaths(SCENES_ROOT, opts.name);
  if (!fs.existsSync(paths.file)) {
    console.error(`error: scene not found: ${paths.file}`);
    return 2;
  }
  const scene = readScene(paths.file);
  const missing = opts.parts.filter((id) => !scene.parts.some((p) => p.id === id));
  if (missing.length) {
    console.error(`error: no part ${missing.map((m) => `"${m}"`).join(', ')} in the scene (parts: ${scene.parts.map((p) => p.id).join(', ')})`);
    return 2;
  }
  const ids = opts.parts.length ? opts.parts : scene.parts.map((p) => p.id);

  if (opts.off) {
    if (opts.dryRun) { console.log(`Would remove the ROI from: ${ids.join(', ')}`); return 0; }
    updateScene(paths.file, (s) => {
      for (const p of s.parts) {
        if (!ids.includes(p.id)) continue;
        delete p.roi;
        delete p.roiOutline;
        delete p.roiOutlines;
      }
      return s;
    });
    console.log(`Removed the ROI from ${ids.join(', ')}. Rebuild with: node pipeline/build-scene.mjs ${opts.name}`);
    return 0;
  }

  let target;
  let region;
  try {
    target = roiTarget(opts.roi, opts.name, { overwrite: opts.overwrite });
    region = readRoi(path.resolve(PROJECT_ROOT, opts.roi), opts.outlines);
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }
  console.log(`ROI: ${target.rel}${target.copyFrom ? ` (copied from ${target.copyFrom})` : ''}`);
  const outlines = roiOutlines(readRoiJson(path.resolve(PROJECT_ROOT, opts.roi)));
  console.log(`  ${opts.outlines.length ? `outline${opts.outlines.length > 1 ? 's' : ''} ${opts.outlines.map((o) => `"${o}"`).join(' + ')}` : 'top-level region'}${outlines.length ? ` (outlines in the file: ${outlines.join(', ')})` : ''}`);
  for (const p of region.prisms) console.log(`  prism, centre ${p.center.map((v) => v.toFixed(3)).join(', ')}, height ${(2 * p.halfHeight).toFixed(3)}, ${p.polygon.length / 2}-point outline`);
  console.log(`  digest ${region.digest}`);
  if (region.rotated) console.log('  WARNING: the region is rotated; the direction of Spirula\'s ROI rotation is unverified. Check the crop in the viewer.');
  for (const id of ids) {
    const part = scene.parts.find((p) => p.id === id);
    let share = null;
    try {
      share = shareInside(path.resolve(PROJECT_ROOT, part.source), region);
    } catch (e) {
      console.log(`  part ${id.padEnd(16)} (could not sample: ${e.message})`);
      continue;
    }
    console.log(`  part ${id.padEnd(16)} ${(share * 100).toFixed(1)}% of sampled splats inside${share < 0.02 ? '  WARNING: almost nothing inside; another coordinate frame?' : ''}`);
  }
  if (opts.dryRun) { console.log('Dry run, nothing written.'); return 0; }
  if (target.copyFrom) {
    const dest = path.resolve(PROJECT_ROOT, target.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(target.copyFrom, dest);
  }
  updateScene(paths.file, (s) => {
    for (const p of s.parts) {
      if (!ids.includes(p.id)) continue;
      p.roi = target.rel;
      delete p.roiOutline;
      if (opts.outlines.length) p.roiOutlines = opts.outlines;
      else delete p.roiOutlines;
    }
    return s;
  });
  console.log(`Saved ${path.relative(PROJECT_ROOT, paths.file)}. Rebuild with: node pipeline/build-scene.mjs ${opts.name}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
