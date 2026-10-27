#!/usr/bin/env node
// Lossless, purely subtractive splat cutting with closed solids modelled in Rhino.
//
//   node pipeline/cut.mjs <in.ply> --cuts <file.3dm> [--remove <layer>]... [--keep <layer>]... [options]
//
// Solids on the "remove" layers (default "cut-remove") delete the splats inside
// them; if there are solids on the "keep" layers (default "cut-keep"), splats
// outside all of them are deleted too. Remove wins over keep. A layer also
// matches its sublayers. Every kept splat is copied byte for byte (all
// properties, all SH bands), in file order, with the input's header except the
// vertex count; nothing is re-encoded (lib/splat-crop.mjs).
//
// The .3dm must be in the splat file's own coordinates: model around a
// reference cloud of the same .ply and never move it. No units or transform are
// applied; the model's unit system is only reported.
//
// Solids: meshes, polysurfaces (Breps) and extrusions, also inside blocks (the
// instance's layer decides, and its transform is applied). rhino3dm cannot mesh
// NURBS itself, so polysurfaces use the render meshes Rhino stores in the file:
// a file saved with "Save Small" has none (fix: save normally, or ExtractRenderMesh
// and put the mesh on the layer). Curves, open surfaces, SubDs, etc. are skipped
// with a note.
//
// By default only the splat centre is tested, so a cut edge is as soft as the
// splats along it. --margin k also tests the six points at +-k sigma along each
// splat axis: any of them inside a remove solid deletes the splat, and any of
// them outside the keep solids deletes it, so cut faces come out cleaner at the
// price of eating a little further in.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import rhino3dm from 'rhino3dm';

import { makeSolid } from './lib/solids.mjs';
import {
  PartWriter, headerWithCount, openSplatPly, passProgress, readHeaderText, writeByLabel,
} from './lib/splat-crop.mjs';

export const CUT_USAGE = `Usage:
  node pipeline/cut.mjs <in.ply> --cuts <file.3dm> [options]

Options:
  --cuts <file.3dm>     Rhino file with closed solids, in the .ply's coordinates.
  --remove <layer>      Delete splats inside solids on this layer (and sublayers). Repeatable. Default: cut-remove.
  --keep <layer>        Delete splats outside all solids on this layer. Repeatable. Default: cut-keep (if present).
  --margin <k>          Also test the points +-k sigma along each splat axis (default 0: centre only).
  --out <file.ply>      Output (default <in>-cut.ply next to the input).
  --removed <file.ply>  Also write the deleted splats here, to check the cut.
  --overwrite           Replace existing output files.
  --dry-run             Count only; write nothing.
  --json                Print the report as JSON at the end.
  -h, --help            Show this help.`;

export function parseCutArgs(argv) {
  const opts = { input: null, cuts: null, remove: [], keep: [], margin: 0, out: null, removed: null, overwrite: false, dryRun: false, json: false, help: false };
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
      case '--cuts': opts.cuts = takeValue(); break;
      case '--remove': { const v = takeValue(); if (v) opts.remove.push(v); break; }
      case '--keep': { const v = takeValue(); if (v) opts.keep.push(v); break; }
      case '--margin': {
        const v = Number(takeValue());
        if (!Number.isFinite(v) || v < 0) errors.push('--margin must be a number >= 0');
        else opts.margin = v;
        break;
      }
      case '--out': opts.out = takeValue(); break;
      case '--removed': opts.removed = takeValue(); break;
      case '--overwrite': opts.overwrite = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      default:
        if (a.startsWith('-')) errors.push(`Unknown option: ${a}`);
        else positional.push(a);
    }
  }
  if (opts.help) return { opts, errors: [] };
  if (positional.length !== 1) errors.push(positional.length ? `Expected one input .ply, got ${positional.length}` : 'Missing input .ply');
  opts.input = positional[0] ?? null;
  if (!opts.cuts) errors.push('Missing --cuts <file.3dm>');
  return { opts, errors };
}

/** Does a layer (full path "A::B::C") belong to `want` (a full path, or a bare name anywhere in the path)? */
export function layerMatches(fullPath, want) {
  const p = fullPath.toLowerCase(), w = want.toLowerCase();
  if (p === w || p.startsWith(`${w}::`)) return true;
  return !w.includes('::') && p.split('::').includes(w);
}

let rhinoModule = null;
const loadRhino = async () => (rhinoModule ??= await rhino3dm());

/** Triangles (flat x0 y0 z0 x1 ... array) of rhino Meshes, after an optional transform. */
function meshTriangles(meshes, xform) {
  const out = [];
  for (let m of meshes) {
    if (xform) { m = m.duplicate(); m.transform(xform); }
    const verts = m.vertices(), faces = m.faces();
    const vert = (i) => verts.get(i);
    for (let f = 0; f < faces.count; f++) {
      const [a, b, c, d] = faces.get(f);
      out.push(...vert(a), ...vert(b), ...vert(c));
      if (d !== c) out.push(...vert(a), ...vert(c), ...vert(d));
    }
  }
  return out;
}

/** The meshes of one piece of geometry, or { skip: reason }. */
function geometryMeshes(rhino, geom) {
  const t = geom.objectType;
  const faceMeshes = (brep) => {
    const faces = brep.faces();
    const meshes = [];
    for (let i = 0; i < faces.count; i++) {
      const m = faces.get(i).getMesh(rhino.MeshType.Any);
      if (!m) return null;
      meshes.push(m);
    }
    return meshes;
  };
  const noRender = 'polysurface without a render mesh in the file (saved with "Save Small"?): save normally, or ExtractRenderMesh onto the layer';
  if (t === rhino.ObjectType.Mesh) return { meshes: [geom] };
  if (t === rhino.ObjectType.Brep) {
    const meshes = faceMeshes(geom);
    return meshes ? { meshes } : { skip: noRender };
  }
  if (t === rhino.ObjectType.Extrusion) {
    const m = geom.getMesh(rhino.MeshType.Any);
    if (m) return { meshes: [m] };
    const brep = geom.toBrep(true);
    const meshes = brep && faceMeshes(brep);
    return meshes ? { meshes } : { skip: noRender };
  }
  if (t === rhino.ObjectType.SubD) return { skip: 'SubD: convert it with ToNURBS (then save normally) or Mesh' };
  const name = Object.entries(rhino.ObjectType).find(([, v]) => v === t)?.[0] ?? 'unknown';
  return { skip: `${name} is not a solid` };
}

/**
 * Read the cutting solids from a .3dm.
 * @param {string} file
 * @param {{ remove?: string[], keep?: string[] }} layers  explicit layer names; defaults "cut-remove" / "cut-keep"
 * @returns {Promise<{ units: string, layers: string[], remove: object[], keep: object[], skipped: { name: string, layer: string, reason: string }[] }>}
 */
export async function loadCutters(file, { remove = [], keep = [] } = {}) {
  const rhino = await loadRhino();
  const doc = rhino.File3dm.fromByteArray(new Uint8Array(fs.readFileSync(file)));
  if (!doc) throw new Error(`${path.basename(file)}: not a readable .3dm file`);
  const layerTable = doc.layers();
  const layers = Array.from({ length: layerTable.count }, (_, i) => layerTable.get(i).fullPath);
  const removeWant = remove.length ? remove : ['cut-remove'];
  const keepWant = keep.length ? keep : ['cut-keep'];
  for (const w of [...remove, ...keep]) {
    if (!layers.some((l) => layerMatches(l, w))) throw new Error(`${path.basename(file)}: no layer "${w}" (layers: ${layers.join(', ') || 'none'})`);
  }
  const roleOf = (layerIndex) => {
    const l = layers[layerIndex];
    if (l === undefined) return null;
    if (removeWant.some((w) => layerMatches(l, w))) return 'remove';
    if (keepWant.some((w) => layerMatches(l, w))) return 'keep';
    return null;
  };

  const objects = doc.objects();
  const byId = new Map();
  for (let i = 0; i < objects.count; i++) {
    const o = objects.get(i);
    byId.set(o.attributes().id, o);
  }
  // Objects that only exist inside block definitions are not placed on their own.
  const idefs = doc.instanceDefinitions();
  const defs = new Map();
  for (let i = 0; i < idefs.count; i++) {
    const d = idefs.get(i);
    defs.set(d.id, d);
  }
  const inDefinition = new Set([...defs.values()].flatMap((d) => d.getObjectIds()));

  const out = { units: Object.entries(rhino.UnitSystem).find(([, v]) => v === doc.settings().modelUnitSystem)?.[0] ?? 'unknown', layers, remove: [], keep: [], skipped: [] };
  const add = (role, geom, label, layer, xform, depth) => {
    if (geom.objectType === rhino.ObjectType.InstanceReference) {
      const def = defs.get(geom.parentIdefId);
      if (!def || depth > 16) { out.skipped.push({ name: label, layer, reason: 'block definition missing or nested too deep' }); return; }
      const x = xform ? rhino.Transform.multiply(xform, geom.xform) : geom.xform;
      for (const id of def.getObjectIds()) {
        const child = byId.get(id);
        if (child) add(role, child.geometry(), `${label} > ${child.attributes().name || def.name || 'block part'}`, layer, x, depth + 1);
      }
      return;
    }
    const r = geometryMeshes(rhino, geom);
    if (r.skip) { out.skipped.push({ name: label, layer, reason: r.skip }); return; }
    const solid = makeSolid(meshTriangles(r.meshes, xform), label);
    solid.layer = layer;
    out[role].push(solid);
  };
  for (let i = 0; i < objects.count; i++) {
    const o = objects.get(i);
    const attrs = o.attributes();
    if (inDefinition.has(attrs.id)) continue;
    const role = roleOf(attrs.layerIndex);
    if (!role) continue;
    const layer = layers[attrs.layerIndex];
    add(role, o.geometry(), attrs.name || `object ${attrs.id.slice(0, 8)}`, layer, null, 0);
  }
  return out;
}

/** Sample points of a splat: its centre, plus +-k sigma along each axis when k > 0. Fills `pts` (21 numbers) and returns the count. */
function splatSamples(f, b, at, k, pts) {
  const x = f(b + at.x), y = f(b + at.y), z = f(b + at.z);
  pts[0] = x; pts[1] = y; pts[2] = z;
  if (k === 0) return 1;
  let qw = f(b + at.rot_0), qx = f(b + at.rot_1), qy = f(b + at.rot_2), qz = f(b + at.rot_3);
  const qn = Math.hypot(qw, qx, qy, qz) || 1;
  qw /= qn; qx /= qn; qy /= qn; qz /= qn;
  // Columns of the rotation matrix are the splat's axes.
  const axes = [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qw * qz), 2 * (qx * qz - qw * qy)],
    [2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx)],
    [2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy)],
  ];
  let n = 1;
  for (let a = 0; a < 3; a++) {
    const s = k * Math.exp(f(b + at[`scale_${a}`]));
    for (const sign of [1, -1]) {
      pts[n * 3] = x + sign * s * axes[a][0];
      pts[n * 3 + 1] = y + sign * s * axes[a][1];
      pts[n * 3 + 2] = z + sign * s * axes[a][2];
      n++;
    }
  }
  return n;
}

const overlaps = (s, lo, hi) => [0, 1, 2].every((a) => s.bboxMax[a] >= lo[a] && s.bboxMin[a] <= hi[a]);

/**
 * Cut a splat .ply with the solids of a .3dm.
 * @param {{ input: string, cuts: string, remove?: string[], keep?: string[], margin?: number, out?: string|null, removed?: string|null, overwrite?: boolean, dryRun?: boolean, log?: (s: string) => void, onProgress?: (pass: number, f: number) => void, readBytes?: number }} o
 */
export async function cutPly(o) {
  const t0 = Date.now();
  const log = o.log ?? console.log;
  const k = o.margin ?? 0;
  const ply = openSplatPly(o.input, log);
  const cutsFile = path.resolve(o.cuts);
  if (!fs.existsSync(cutsFile)) throw new Error(`cuts file not found: ${cutsFile}`);
  const out = path.resolve(o.out ?? path.join(path.dirname(ply.input), `${path.basename(ply.input, path.extname(ply.input))}-cut.ply`));
  const removedOut = o.removed ? path.resolve(o.removed) : null;
  if (!o.dryRun) {
    for (const f of [out, removedOut].filter(Boolean)) {
      if (f === ply.input) throw new Error('an output would overwrite the input');
      if (fs.existsSync(f) && !o.overwrite) throw new Error(`${f} exists (use --overwrite)`);
    }
    if (out === removedOut) throw new Error('--out and --removed are the same file');
  }

  const cutters = await loadCutters(cutsFile, { remove: o.remove, keep: o.keep });
  const { remove, keep } = cutters;
  if (remove.length + keep.length === 0) {
    const why = cutters.skipped.length ? `; skipped: ${cutters.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}` : '';
    throw new Error(`no solids on the remove/keep layers of ${path.basename(cutsFile)}${why}`);
  }
  for (const s of [...remove, ...keep]) {
    if (s.openEdges) log(`WARNING: "${s.name}" (${s.layer}) is not closed: ${s.openEdges} open edge(s); splats near the gaps may be misjudged`);
  }
  for (const s of cutters.skipped) log(`skipped "${s.name}" (${s.layer}): ${s.reason}`);

  const { header, props, stride, total } = ply;
  const need = k > 0 ? ['scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'] : [];
  for (const p of need) if (!props[p] || !['float', 'float32'].includes(props[p].type)) throw new Error(`--margin needs float property "${p}"`);
  const at = Object.fromEntries(Object.entries(props).map(([name, p]) => [name, p.offset]));

  const records = Math.max(1, Math.floor((o.readBytes ?? 32 * 1024 * 1024) / stride));
  const buf = Buffer.alloc(records * stride);
  const f = (off) => buf.readFloatLE(off);
  const labels = new Uint8Array(total); // 0 kept, 1 inside a remove solid, 2 outside the keep solids
  const perRemove = new Array(remove.length).fill(0);
  const pts = new Float64Array(21);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let nonFinite = 0;
  const fd = fs.openSync(ply.input, 'r');
  try {
    const report = passProgress(o, 1, o.dryRun ? 1 : 2, 'test', total);
    for (let done = 0; done < total;) {
      const want = Math.min(records, total - done);
      if (fs.readSync(fd, buf, 0, want * stride, header.headerBytes + done * stride) !== want * stride) throw new Error(`short read at splat ${done}`);
      for (let i = 0; i < want; i++) {
        const n = splatSamples(f, i * stride, at, k, pts);
        if (!Number.isFinite(pts[0]) || !Number.isFinite(pts[1]) || !Number.isFinite(pts[2])) { nonFinite++; continue; } // kept as is
        for (let a = 0; a < 3; a++) { if (pts[a] < lo[a]) lo[a] = pts[a]; if (pts[a] > hi[a]) hi[a] = pts[a]; }
        let label = 0;
        for (let r = 0; r < remove.length && !label; r++) {
          for (let s = 0; s < n; s++) {
            if (remove[r].contains(pts[s * 3], pts[s * 3 + 1], pts[s * 3 + 2])) { label = 1; perRemove[r]++; break; }
          }
        }
        if (!label && keep.length) {
          for (let s = 0; s < n && !label; s++) {
            if (!keep.some((kp) => kp.contains(pts[s * 3], pts[s * 3 + 1], pts[s * 3 + 2]))) label = 2;
          }
        }
        labels[done + i] = label;
      }
      done += want;
      report(done);
    }

    const counts = [0, 0, 0];
    for (let i = 0; i < total; i++) counts[labels[i]]++;
    for (const s of [...remove, ...keep]) {
      if (!overlaps(s, lo, hi)) log(`WARNING: "${s.name}" (${s.layer}) does not overlap the splats' bounding box: is the .3dm in the .ply's coordinates and units?`);
    }
    if (counts[0] === 0) throw new Error('the cut deletes every splat');

    let written = false;
    if (!o.dryRun) {
      const headerText = readHeaderText(fd, header.headerBytes);
      const keepW = new PartWriter(out, Buffer.from(headerWithCount(headerText, counts[0]), 'latin1'), stride);
      const dropW = removedOut && counts[1] + counts[2] > 0
        ? new PartWriter(removedOut, Buffer.from(headerWithCount(headerText, counts[1] + counts[2]), 'latin1'), stride)
        : null;
      try {
        writeByLabel(fd, ply, labels, [keepW, dropW, dropW], buf, records, passProgress(o, 2, 2, 'write', total));
        keepW.close();
        dropW?.close();
        if (keepW.count !== counts[0]) throw new Error(`internal error: wrote ${keepW.count} of ${counts[0]} splats`);
        fs.renameSync(keepW.tmp, out);
        if (dropW) fs.renameSync(dropW.tmp, removedOut);
      } catch (e) {
        keepW.abort();
        dropW?.abort();
        throw e;
      }
      written = true;
    }
    return {
      input: ply.input,
      cuts: cutsFile,
      out: written ? out : null,
      removedOut: written && removedOut && counts[1] + counts[2] > 0 ? removedOut : null,
      units: cutters.units,
      margin: k,
      totalSplats: total,
      keptSplats: counts[0],
      removedInside: counts[1],
      removedOutsideKeep: counts[2],
      nonFiniteSplats: nonFinite,
      splatBounds: { bboxMin: lo, bboxMax: hi },
      solids: [
        ...remove.map((s, r) => ({ role: 'remove', name: s.name, layer: s.layer, triangles: s.triangles, openEdges: s.openEdges, removed: perRemove[r] })),
        ...keep.map((s) => ({ role: 'keep', name: s.name, layer: s.layer, triangles: s.triangles, openEdges: s.openEdges })),
      ],
      skipped: cutters.skipped,
      seconds: (Date.now() - t0) / 1000,
    };
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const { opts, errors } = parseCutArgs(process.argv.slice(2));
  if (opts.help) { console.log(CUT_USAGE); return 0; }
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`\n${CUT_USAGE}`);
    return 2;
  }
  let r;
  try {
    r = await cutPly(opts);
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }
  const n = (v) => v.toLocaleString('en-US');
  console.log('\n----- cut -----');
  for (const s of r.solids) console.log(`${s.role.padEnd(6)} ${s.name} (${s.layer}): ${n(s.triangles)} triangles${s.openEdges ? `, ${s.openEdges} OPEN EDGES` : ''}${s.role === 'remove' ? `, ${n(s.removed)} splats` : ''}`);
  console.log(`kept:    ${n(r.keptSplats)} of ${n(r.totalSplats)} splats (removed ${n(r.removedInside)} inside remove solids, ${n(r.removedOutsideKeep)} outside keep solids)`);
  console.log(`units:   .3dm is in ${r.units}; coordinates are used as they are${r.margin ? `; margin ${r.margin} sigma` : '; splat centres only'}`);
  console.log(r.out ? `output:  ${r.out}${r.removedOut ? `\nremoved: ${r.removedOut}` : ''}` : 'dry run: nothing written');
  console.log(`time:    ${r.seconds.toFixed(1)} s`);
  if (opts.json) console.log(JSON.stringify(r));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
