#!/usr/bin/env node
// Create scenes/<name>/scene.json for one or more source files (one part each).
//
//   node pipeline/new-scene.mjs <name> --source <file|folder|glob> [--source ...] [--transform a.json ...] [--transform-from <scene>] [--force]
//
// Every --source becomes one or more parts, in the order given:
//   a file      assets/source_ply/scan.ply
//   a folder    assets/source_ply/parts/OculusV1        (every splat file in it, natural sort)
//   a glob      "assets/source_ply/parts/OculusV1/part*.ply"  (* and ? in the file name only)
// Part ids come from the file names (part0.ply -> "part0"). All parts must be in
// the same source coordinate frame (e.g. Spirula Studio part exports): one scene
// transform is applied to all of them.
//
// --transform takes v1 Align transform JSONs (assets/transforms/<stem>.json).
// Several are composed in the order given, each applied after the previous one
// (M = Mn * ... * M2 * M1). That is how a chain of v1 bakes
// (scan.ply -> scan-aligned.ply -> scan-aligned-aligned.ply) becomes a single
// scene transform relative to the original source.
// --transform-from <scene> copies the transform of an existing scene instead
// (e.g. split parts of a merged file that already has an aligned scene).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_ROOT, SCENES_ROOT } from './lib/config.mjs';
import { readScene, scenePaths, writeSceneAtomic } from './lib/scene-files.mjs';
import {
  SOURCE_EXTS, composeTransforms, createScene, isSafeSourcePath, isValidSceneName, partsFromSources,
} from '../shared/scene-schema.mjs';

export const NEW_SCENE_USAGE = `Usage:
  node pipeline/new-scene.mjs <name> --source <file|folder|glob> [--source ...] [options]

  --source <path>          Original splat file, a folder of them, or a glob ("dir/part*.ply"), relative
                           to the repo root. Repeat for more parts. Sources are never modified.
  --transform <json>       v1 Align transform JSON. Repeat to compose (applied in the order given).
  --transform-from <scene> Use the transform of an existing scene (scenes/<scene>/scene.json).
  --force                  Overwrite an existing scene.json (nav/ and build/ are left alone).`;

export function parseNewSceneArgs(argv) {
  const opts = { name: null, sources: [], transforms: [], transformFrom: null, force: false, help: false };
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
      case '--source': { const v = takeValue(); if (v) opts.sources.push(v.split(path.sep).join('/')); break; }
      case '--transform': { const v = takeValue(); if (v) opts.transforms.push(v); break; }
      case '--transform-from': opts.transformFrom = takeValue(); break;
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
  if (opts.sources.length === 0) errors.push('Missing --source');
  for (const s of opts.sources) {
    if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').some((seg) => seg === '..')) errors.push(`--source must be a repo-relative path, got "${s}"`);
  }
  if (opts.transformFrom !== null && !isValidSceneName(opts.transformFrom)) errors.push(`--transform-from: invalid scene name "${opts.transformFrom}"`);
  if (opts.transformFrom && opts.transforms.length) errors.push('Use either --transform or --transform-from, not both');
  return { opts, errors };
}

/** "part10" sorts after "part9". */
const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

function globToRegExp(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${esc}$`, 'i');
}

/**
 * Expand --source values (files, folders, globs in the last path segment) into
 * repo-relative source paths, de-duplicated, in the order given.
 * @returns {{ sources: string[], errors: string[] }}
 */
export function expandSources(values, root = PROJECT_ROOT) {
  const out = [];
  const errors = [];
  const add = (rel) => {
    if (!isSafeSourcePath(rel)) errors.push(`not a usable source path: "${rel}" (repo-relative ${SOURCE_EXTS.join(' ')} file, no dot folders)`);
    else if (!out.includes(rel)) out.push(rel);
  };
  for (const v of values) {
    const clean = v.replace(/\/+$/, '');
    const last = clean.slice(clean.lastIndexOf('/') + 1);
    if (/[*?]/.test(last)) {
      const dirRel = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '.';
      if (/[*?]/.test(dirRel)) { errors.push(`wildcards are only supported in the file name: "${v}"`); continue; }
      const dir = path.resolve(root, dirRel);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { errors.push(`folder not found: ${dirRel}`); continue; }
      const re = globToRegExp(last);
      const hits = fs.readdirSync(dir).filter((f) => re.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort(natural);
      if (hits.length === 0) errors.push(`no files match "${v}"`);
      for (const f of hits) add(dirRel === '.' ? f : `${dirRel}/${f}`);
      continue;
    }
    const abs = path.resolve(root, clean);
    if (!fs.existsSync(abs)) { errors.push(`source not found: ${clean}`); continue; }
    if (fs.statSync(abs).isDirectory()) {
      const hits = fs.readdirSync(abs)
        .filter((f) => !f.startsWith('.') && SOURCE_EXTS.some((e) => f.toLowerCase().endsWith(e)) && fs.statSync(path.join(abs, f)).isFile())
        .sort(natural);
      if (hits.length === 0) errors.push(`no splat files (${SOURCE_EXTS.join(' ')}) in ${clean}/`);
      for (const f of hits) add(`${clean}/${f}`);
    } else {
      add(clean);
    }
  }
  return { sources: out, errors };
}

async function main() {
  const { opts, errors } = parseNewSceneArgs(process.argv.slice(2));
  if (opts.help) { console.log(NEW_SCENE_USAGE); return 0; }
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`\n${NEW_SCENE_USAGE}`);
    return 2;
  }
  const { sources, errors: srcErrors } = expandSources(opts.sources);
  if (srcErrors.length || sources.length === 0) {
    for (const e of srcErrors) console.error(`error: ${e}`);
    if (!srcErrors.length) console.error('error: no sources');
    return 2;
  }
  const p = scenePaths(SCENES_ROOT, opts.name);
  if (fs.existsSync(p.file) && !opts.force) {
    console.error(`error: ${p.file} already exists (pass --force to overwrite)`);
    return 2;
  }
  let transform;
  let migratedFrom = null;
  if (opts.transformFrom) {
    const from = scenePaths(SCENES_ROOT, opts.transformFrom);
    if (!fs.existsSync(from.file)) {
      console.error(`error: scene not found: ${opts.transformFrom}`);
      return 2;
    }
    transform = readScene(from.file).transform;
  } else {
    const jsons = opts.transforms.map((f) => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')));
    transform = composeTransforms(jsons);
    if (jsons.length) migratedFrom = opts.transforms.map((f) => path.relative(PROJECT_ROOT, path.resolve(f)).split(path.sep).join('/'));
  }
  const scene = createScene({ name: opts.name, parts: partsFromSources(sources), transform });
  if (migratedFrom) scene.migratedFrom = migratedFrom;
  if (opts.transformFrom) scene.transformFrom = opts.transformFrom;
  fs.mkdirSync(p.nav, { recursive: true });
  writeSceneAtomic(p.file, scene);
  console.log(`Created ${path.relative(PROJECT_ROOT, p.file)}`);
  for (const part of scene.parts) console.log(`  part ${part.id.padEnd(16)} ${part.source}`);
  console.log(`  position    ${JSON.stringify(scene.transform.position)}`);
  console.log(`  rotationDeg ${JSON.stringify(scene.transform.rotationDeg)}  scale ${scene.transform.scale}`);
  console.log(`Build it with: node pipeline/build-scene.mjs ${opts.name}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
