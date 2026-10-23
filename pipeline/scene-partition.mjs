#!/usr/bin/env node
// Set (or remove) a scene's Spirula partition, so build-scene.mjs crops every
// part to its own partition region before building it.
//
//   node pipeline/scene-partition.mjs <scene> --partition <partition.json> [--part <id>=<n>]... [--dry-run]
//   node pipeline/scene-partition.mjs <scene> --off
//
// Why: Spirula trains each partition part with its "ring" cameras, which also
// see the other parts' regions (across the room, through glass). Each part
// export therefore holds a low-detail copy of the others; overlaid, those
// splats blur the other parts' sharp ones. The crop keeps only the splats whose
// nearest partition point carries the part's own label (the same rule as
// partition-split.mjs, which matches Spirula's own merge).
//
// Each part's partition part number is detected by labelling 20,000 sampled
// splats (a part export holds ~99% of its splats in its own region); --part
// <id>=<n> sets it by hand. Only scene.json is written; run build-scene.mjs
// afterwards (the cropped parts show as outdated until then).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_ROOT, SCENES_ROOT } from './lib/config.mjs';
import { readScene, scenePaths, updateScene } from './lib/scene-files.mjs';
import { readPartitionInfo } from './lib/partition.mjs';
import { detectPartitionPart, loadPartitionTree } from './partition-split.mjs';
import { isValidPartId, isValidSceneName } from '../shared/scene-schema.mjs';

export const SCENE_PARTITION_USAGE = `Usage:
  node pipeline/scene-partition.mjs <scene> --partition <partition.json> [--part <id>=<n>]... [--dry-run]
  node pipeline/scene-partition.mjs <scene> --off

  --partition <json>   Spirula partition.json (partition.bin next to it), repo-relative,
                       e.g. assets/partitions/OculusV1/partition.json.
  --part <id>=<n>      Partition part number of a scene part (repeatable). Parts not named
                       here are detected from their splats.
  --off                Remove the partition: parts are built uncropped again.
  --dry-run            Print what would be set; write nothing.`;

export function parseScenePartitionArgs(argv) {
  const opts = { name: null, partition: null, parts: {}, off: false, dryRun: false, help: false };
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
      case '--partition': opts.partition = takeValue(); break;
      case '--off': opts.off = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--part': {
        const v = takeValue();
        if (v === null) break;
        const m = /^([^=]+)=(\d{1,3})$/.exec(v);
        if (!m || !isValidPartId(m[1]) || Number(m[2]) > 254) errors.push(`--part must be <part id>=<partition part number>, got "${v}"`);
        else opts.parts[m[1]] = Number(m[2]);
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
  if (opts.off && (opts.partition || Object.keys(opts.parts).length)) errors.push('--off takes no --partition or --part');
  if (!opts.off && !opts.partition) errors.push('Missing --partition <partition.json> (or --off)');
  return { opts, errors };
}

/** Repo-relative, forward-slash path of a partition.json inside the repo (throws otherwise). */
export function repoRelativePartition(p, root = PROJECT_ROOT) {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`the partition must be inside the repo (copy partition.json + partition.bin to assets/partitions/<scan>/), got ${p}`);
  }
  return rel.split(path.sep).join('/');
}

/**
 * Partition part number of every part: `explicit[id]` where given, else detected
 * from the part's source splats.
 * @param {{ parts: { id: string, source: string }[] }} scene
 * @param {string} partitionAbs
 * @param {Record<string, number>} [explicit]
 * @returns {{ id: string, part: number, how: 'set'|'detected', share?: number }[]}
 */
export function assignPartitionParts(scene, partitionAbs, explicit = {}, root = PROJECT_ROOT) {
  const info = readPartitionInfo(partitionAbs);
  for (const id of Object.keys(explicit)) {
    if (!scene.parts.some((p) => p.id === id)) throw new Error(`no part "${id}" in the scene (parts: ${scene.parts.map((p) => p.id).join(', ')})`);
    if (explicit[id] >= info.numParts) throw new Error(`--part ${id}=${explicit[id]}: the partition has parts 0..${info.numParts - 1}`);
  }
  let loaded = null;
  return scene.parts.map((p) => {
    if (Number.isInteger(explicit[p.id])) return { id: p.id, part: explicit[p.id], how: 'set' };
    loaded ??= loadPartitionTree(partitionAbs);
    const d = detectPartitionPart(path.resolve(root, p.source), loaded);
    return { id: p.id, part: d.part, how: 'detected', share: d.share };
  });
}

async function main() {
  const { opts, errors } = parseScenePartitionArgs(process.argv.slice(2));
  if (opts.help) { console.log(SCENE_PARTITION_USAGE); return 0; }
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`\n${SCENE_PARTITION_USAGE}`);
    return 2;
  }
  const paths = scenePaths(SCENES_ROOT, opts.name);
  if (!fs.existsSync(paths.file)) {
    console.error(`error: scene not found: ${paths.file}`);
    return 2;
  }
  if (opts.off) {
    if (opts.dryRun) { console.log(`Would remove the partition from ${opts.name}.`); return 0; }
    updateScene(paths.file, (s) => {
      delete s.partition;
      for (const p of s.parts) delete p.partitionPart;
      return s;
    });
    console.log(`Removed the partition from ${opts.name}: parts are built uncropped. Rebuild with: node pipeline/build-scene.mjs ${opts.name}`);
    return 0;
  }

  let rel;
  let assigned;
  try {
    rel = repoRelativePartition(opts.partition);
    assigned = assignPartitionParts(readScene(paths.file), path.resolve(PROJECT_ROOT, rel), opts.parts);
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }
  console.log(`Partition: ${rel}`);
  for (const a of assigned) console.log(`  part ${a.id.padEnd(16)} -> partition part ${a.part}  (${a.how === 'set' ? 'set by hand' : `detected: ${(a.share * 100).toFixed(1)}% of sampled splats`})`);
  const dupes = assigned.filter((a, i) => assigned.findIndex((b) => b.part === a.part) !== i);
  if (dupes.length) console.log(`WARNING: several parts map to the same partition part (${[...new Set(dupes.map((d) => d.part))].join(', ')}); check with --part <id>=<n>`);
  if (opts.dryRun) { console.log('Dry run, scene.json not written.'); return 0; }
  updateScene(paths.file, (s) => {
    s.partition = rel;
    for (const p of s.parts) {
      const a = assigned.find((x) => x.id === p.id);
      if (a) p.partitionPart = a.part;
    }
    return s;
  });
  console.log(`Saved ${path.relative(PROJECT_ROOT, paths.file)}. Rebuild with: node pipeline/build-scene.mjs ${opts.name}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
