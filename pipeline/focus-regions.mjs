#!/usr/bin/env node
// Focus regions (shared/focus-regions.mjs): the boxes drawn in the scene
// editor's Regions panel (I), saved in scene.json as `focusRegions` in scene
// coordinates.
//
//   node pipeline/focus-regions.mjs list <scene>
//   node pipeline/focus-regions.mjs quantify <scene> [--compare <scene>]... [--json <file>]
//   node pipeline/focus-regions.mjs export <scene> --out <region.json> [--tier hero,high]
//
// quantify: for the regions of <scene>, how many splats each model holds in each
// region, and how big they are. The models are <scene> itself plus every
// --compare scene (e.g. quantify HighRezOculus --compare Mid12M --compare LowCap).
// Each model is read from its enabled parts' SOURCE files, cropped exactly as
// build-scene.mjs crops them (region of interest / partition part), and moved
// into scene coordinates with that scene's transform, so models with the same
// transform are compared in the same boxes. "Size" is the median of each splat's
// largest standard deviation, in mm (scene units are metres): the resolution a
// region was trained to. One streaming pass per part (64 MB reads).
//
// export: the regions (optionally only some tiers) as a Spirula --roi-region file
// in <scene>'s source (training) frame: a top-level union of box prisms.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FOCUS_TIERS, regionContains, regionsToSpirula, regionVolume } from '../shared/focus-regions.mjs';
import { mat4ApplyPoint, partCrop } from '../shared/scene-schema.mjs';
import { PROJECT_ROOT, SCENES_ROOT } from './lib/config.mjs';
import { parseRoi, readRoi } from './lib/roi.mjs';
import { readScene, scenePaths } from './lib/scene-files.mjs';
import { openSplatPly } from './lib/splat-crop.mjs';
import { loadPartitionTree } from './partition-split.mjs';

const READ_BYTES = 64 * 1024 * 1024;
/** Splat sizes kept per region and model for the median (reservoir sample). */
const SIZE_SAMPLES = 50_000;

const USAGE = `Usage:
  node pipeline/focus-regions.mjs list <scene>
  node pipeline/focus-regions.mjs quantify <scene> [--compare <scene>]... [--json <file>]
  node pipeline/focus-regions.mjs export <scene> --out <region.json> [--tier hero,high]`;

export function parseArgs(argv) {
  const o = { command: argv[0], scene: null, compare: [], json: null, out: null, tiers: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--compare') o.compare.push(value());
    else if (a === '--json') o.json = value();
    else if (a === '--out') o.out = value();
    else if (a === '--tier') o.tiers = value().split(',').map((t) => t.trim());
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (o.scene) throw new Error(`expected one scene, got ${o.scene} and ${a}`);
    else o.scene = a;
  }
  if (!['list', 'quantify', 'export'].includes(o.command)) throw new Error(`command must be list, quantify or export`);
  if (!o.scene) throw new Error('missing <scene>');
  if (o.tiers) for (const t of o.tiers) if (!FOCUS_TIERS.includes(t)) throw new Error(`--tier: ${t} is not one of ${FOCUS_TIERS.join(', ')}`);
  if (o.command === 'export' && !o.out) throw new Error('export needs --out <region.json>');
  return o;
}

function loadScene(name) {
  return readScene(scenePaths(SCENES_ROOT, name).file);
}

function regionsOf(scene) {
  const regions = scene.focusRegions ?? [];
  if (!regions.length) throw new Error(`scene "${scene.name}" has no focus regions: draw them in the editor (Regions, I) and save`);
  return regions;
}

/** keep(x, y, z) for a part, in its source frame: the same crop build-scene.mjs applies (null = keep all). */
function partKeep(scene, part, trees) {
  const crop = partCrop(scene, part);
  if (!crop) return null;
  const roi = crop.roi ? readRoi(path.resolve(PROJECT_ROOT, crop.roi), crop.roiOutlines ?? null) : null;
  let tree = null;
  if (crop.partition) {
    const abs = path.resolve(PROJECT_ROOT, crop.partition);
    if (!trees.has(abs)) trees.set(abs, loadPartitionTree(abs));
    tree = trees.get(abs).tree;
  }
  return (x, y, z) => (!roi || roi.contains(x, y, z)) && (!tree || tree.label(x, y, z) === crop.part);
}

/** Reservoir sample of up to SIZE_SAMPLES values. */
class Sample {
  constructor() {
    this.values = new Float32Array(SIZE_SAMPLES);
    this.seen = 0;
  }
  push(v) {
    if (this.seen < SIZE_SAMPLES) this.values[this.seen] = v;
    else {
      const j = Math.floor(Math.random() * (this.seen + 1));
      if (j < SIZE_SAMPLES) this.values[j] = v;
    }
    this.seen++;
  }
  median() {
    const n = Math.min(this.seen, SIZE_SAMPLES);
    if (!n) return null;
    const v = this.values.slice(0, n).sort();
    return v[n >> 1];
  }
}

/**
 * Count one model (a scene's enabled parts) in every region.
 * @returns {{ scene: string, splats: number, inAny: number, regions: { count: number, sizeMm: number|null }[], seconds: number }}
 */
export function quantifyModel(model, regions, log = console.log) {
  const t0 = Date.now();
  const M = model.transform.matrix;
  const scale = Math.hypot(M[0], M[1], M[2]);
  const tests = regions.map((r) => {
    const contains = regionContains(r);
    // Scene-frame AABB of the box: a cheap reject before the exact test.
    const half = r.size.map((s) => s / 2);
    const ext = [0, 1, 2].map((i) => {
      const [x, y, z, w] = r.quaternion;
      const R = [
        1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
        2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
        2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
      ];
      return Math.abs(R[3 * i]) * half[0] + Math.abs(R[3 * i + 1]) * half[1] + Math.abs(R[3 * i + 2]) * half[2];
    });
    const lo = r.center.map((c, i) => c - ext[i]);
    const hi = r.center.map((c, i) => c + ext[i]);
    return { contains, lo, hi, count: 0, sizes: new Sample() };
  });
  const trees = new Map();
  let splats = 0;
  let inAny = 0;
  for (const part of model.parts.filter((p) => p.enabled !== false)) {
    const keep = partKeep(model, part, trees);
    const ply = openSplatPly(path.resolve(PROJECT_ROOT, part.source), () => {});
    const { props, stride, total, header } = ply;
    for (const k of ['scale_0', 'scale_1', 'scale_2']) if (!props[k]) throw new Error(`${part.source}: no ${k} property (not a 3DGS splat .ply?)`);
    const off = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2'].map((k) => props[k].offset);
    const records = Math.floor(READ_BYTES / stride);
    const buf = Buffer.alloc(records * stride);
    const fd = fs.openSync(ply.input, 'r');
    let kept = 0;
    try {
      for (let done = 0; done < total;) {
        const want = Math.min(records, total - done);
        fs.readSync(fd, buf, 0, want * stride, header.headerBytes + done * stride);
        for (let i = 0; i < want; i++) {
          const b = i * stride;
          const x = buf.readFloatLE(b + off[0]), y = buf.readFloatLE(b + off[1]), z = buf.readFloatLE(b + off[2]);
          if (!Number.isFinite(x + y + z) || (keep && !keep(x, y, z))) continue;
          kept++;
          // Scene coordinates: M * p (column-major).
          const sx = M[0] * x + M[4] * y + M[8] * z + M[12];
          const sy = M[1] * x + M[5] * y + M[9] * z + M[13];
          const sz = M[2] * x + M[6] * y + M[10] * z + M[14];
          let hit = false;
          for (const t of tests) {
            if (sx < t.lo[0] || sx > t.hi[0] || sy < t.lo[1] || sy > t.hi[1] || sz < t.lo[2] || sz > t.hi[2] || !t.contains(sx, sy, sz)) continue;
            t.count++;
            const ln = Math.max(buf.readFloatLE(b + off[3]), buf.readFloatLE(b + off[4]), buf.readFloatLE(b + off[5]));
            t.sizes.push(Math.exp(ln) * scale * 1000);
            hit = true;
          }
          if (hit) inAny++;
        }
        done += want;
      }
    } finally {
      fs.closeSync(fd);
    }
    splats += kept;
    log(`  ${model.name}/${part.id}: ${kept.toLocaleString()} of ${total.toLocaleString()} splats kept by its crop`);
  }
  return {
    scene: model.name,
    splats,
    inAny,
    regions: tests.map((t) => ({ count: t.count, sizeMm: t.sizes.median() })),
    seconds: (Date.now() - t0) / 1000,
  };
}

function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function table(rows) {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((v, c) => (c < 3 ? String(v).padEnd(w[c]) : String(v).padStart(w[c]))).join('  ')).join('\n');
}

function list(scene) {
  const regions = regionsOf(scene);
  console.log(table([
    ['id', 'tier', 'name', 'size (m)', 'volume (m³)'],
    ...regions.map((r) => [r.id, r.tier, r.name, r.size.map((v) => v.toFixed(2)).join(' x '), regionVolume(r).toFixed(2)]),
  ]));
}

function quantify(o) {
  const scene = loadScene(o.scene);
  const regions = regionsOf(scene);
  const models = [scene, ...o.compare.map(loadScene)];
  for (const m of models.slice(1)) {
    const same = m.transform.matrix.every((v, i) => Math.abs(v - scene.transform.matrix[i]) < 1e-6);
    if (!same) console.log(`note: ${m.name} has a different transform from ${scene.name}: its splats are placed with its own transform, so the boxes only line up if both are aligned to the same space`);
  }
  console.log(`${regions.length} region(s) of ${scene.name}; models: ${models.map((m) => m.name).join(', ')}`);
  const results = models.map((m) => quantifyModel(m, regions));
  const head = ['region', 'tier', 'name', 'm³'];
  for (const r of results) head.push(`${r.scene} splats`, 'share', 'size mm');
  const rows = regions.map((reg, i) => {
    const row = [reg.id, reg.tier, reg.name, regionVolume(reg).toFixed(2)];
    for (const r of results) {
      const x = r.regions[i];
      row.push(fmt(x.count), `${((100 * x.count) / Math.max(1, r.splats)).toFixed(2)}%`, x.sizeMm === null ? '-' : x.sizeMm.toFixed(2));
    }
    return row;
  });
  const total = ['all regions', '', '(union)', regions.reduce((s, r) => s + regionVolume(r), 0).toFixed(2)];
  for (const r of results) total.push(fmt(r.inAny), `${((100 * r.inAny) / Math.max(1, r.splats)).toFixed(2)}%`, '');
  const rest = ['rest of the model', '', '', ''];
  for (const r of results) rest.push(fmt(r.splats - r.inAny), `${((100 * (r.splats - r.inAny)) / Math.max(1, r.splats)).toFixed(2)}%`, '');
  console.log(`\n${table([head, ...rows, total, rest])}`);
  for (const r of results) console.log(`${r.scene}: ${r.splats.toLocaleString()} splats after cropping, read in ${r.seconds.toFixed(1)} s`);
  if (o.json) {
    const report = {
      scene: scene.name,
      createdAt: new Date().toISOString(),
      regions: regions.map((reg, i) => ({ ...reg, volume: regionVolume(reg), models: Object.fromEntries(results.map((r) => [r.scene, r.regions[i]])) })),
      models: results.map(({ regions: _r, ...m }) => m),
    };
    fs.mkdirSync(path.dirname(path.resolve(o.json)), { recursive: true });
    fs.writeFileSync(o.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${o.json}`);
  }
}

function exportRegion(o) {
  const scene = loadScene(o.scene);
  const regions = regionsOf(scene).filter((r) => !o.tiers || o.tiers.includes(r.tier));
  if (!regions.length) throw new Error(`no ${o.tiers.join(' / ')} regions in ${scene.name}`);
  const json = regionsToSpirula(regions, scene.transform.matrix);
  parseRoi(json, path.basename(o.out)); // validates every prism as lib/roi.mjs reads them
  fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
  fs.writeFileSync(o.out, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${o.out}: ${regions.length} region(s) (${regions.map((r) => r.id).join(', ')}) as a Spirula region in ${scene.name}'s source frame`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argv = process.argv.slice(2);
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    const o = parseArgs(argv);
    if (o.command === 'list') list(loadScene(o.scene));
    else if (o.command === 'quantify') quantify(o);
    else exportRegion(o);
  } catch (e) {
    console.error(`error: ${e.message}\n\n${USAGE}`);
    process.exit(1);
  }
}
