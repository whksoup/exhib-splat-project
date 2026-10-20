#!/usr/bin/env node
// Create scenes/<name>/scene.json for a source file.
//
//   node pipeline/new-scene.mjs <name> --source assets/source_ply/scan.ply [--transform a.json [--transform b.json ...]] [--force]
//
// --transform takes v1 Align transform JSONs (assets/transforms/<stem>.json).
// Several are composed in the order given, each applied after the previous one
// (M = Mn * ... * M2 * M1). That is how a chain of v1 bakes
// (scan.ply -> scan-aligned.ply -> scan-aligned-aligned.ply) becomes a single
// scene transform relative to the original source.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_ROOT, SCENES_ROOT } from './lib/config.mjs';
import { scenePaths, writeSceneAtomic } from './lib/scene-files.mjs';
import { composeTransforms, createScene, isSafeSourcePath, isValidSceneName } from '../shared/scene-schema.mjs';

export const NEW_SCENE_USAGE = `Usage:
  node pipeline/new-scene.mjs <name> --source <repo-relative source> [--transform <json>]... [--force]

  --source <path>      Original splat file, relative to the repo root (e.g. assets/source_ply/scan.ply). Never modified.
  --transform <json>   v1 Align transform JSON. Repeat to compose (applied in the order given).
  --force              Overwrite an existing scene.json (nav/ and build/ are left alone).`;

export function parseNewSceneArgs(argv) {
  const opts = { name: null, source: null, transforms: [], force: false, help: false };
  const errors = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const flag = a.startsWith('--') ? a.split('=')[0] : a;
    const takeValue = () => {
      const eq = a.indexOf('=');
      if (a.startsWith('--') && eq > 0) return a.slice(eq + 1);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { errors.push(`${a} needs a value`); return null; }
      i++;
      return v;
    };
    switch (flag) {
      case '-h': case '--help': opts.help = true; break;
      case '--source': opts.source = takeValue(); break;
      case '--transform': { const v = takeValue(); if (v) opts.transforms.push(v); break; }
      case '--force': opts.force = true; break;
      default:
        if (a.startsWith('-')) errors.push(`Unknown option: ${a}`);
        else positional.push(a);
    }
  }
  if (opts.help) return { opts, errors: [] };
  if (positional.length !== 1) errors.push('Expected one scene name');
  else if (!isValidSceneName(positional[0])) errors.push(`Invalid scene name "${positional[0]}"`);
  opts.name = positional[0] ?? null;
  if (!opts.source) errors.push('Missing --source');
  else {
    opts.source = opts.source.split(path.sep).join('/');
    if (!isSafeSourcePath(opts.source)) errors.push(`--source must be a repo-relative splat file path, got "${opts.source}"`);
  }
  return { opts, errors };
}

async function main() {
  const { opts, errors } = parseNewSceneArgs(process.argv.slice(2));
  if (opts.help) { console.log(NEW_SCENE_USAGE); return 0; }
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`\n${NEW_SCENE_USAGE}`);
    return 2;
  }
  if (!fs.existsSync(path.resolve(PROJECT_ROOT, opts.source))) {
    console.error(`error: source not found: ${opts.source}`);
    return 2;
  }
  const p = scenePaths(SCENES_ROOT, opts.name);
  if (fs.existsSync(p.file) && !opts.force) {
    console.error(`error: ${p.file} already exists (pass --force to overwrite)`);
    return 2;
  }
  const jsons = opts.transforms.map((f) => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')));
  const transform = composeTransforms(jsons);
  const scene = createScene({ name: opts.name, source: opts.source, transform });
  if (jsons.length) scene.migratedFrom = opts.transforms.map((f) => path.relative(PROJECT_ROOT, path.resolve(f)).split(path.sep).join('/'));
  fs.mkdirSync(p.nav, { recursive: true });
  writeSceneAtomic(p.file, scene);
  console.log(`Created ${path.relative(PROJECT_ROOT, p.file)}`);
  console.log(`  source     ${scene.source}`);
  console.log(`  position   ${JSON.stringify(scene.transform.position)}`);
  console.log(`  rotationDeg ${JSON.stringify(scene.transform.rotationDeg)}  scale ${scene.transform.scale}`);
  console.log(`Build it with: node pipeline/build-scene.mjs ${opts.name}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
