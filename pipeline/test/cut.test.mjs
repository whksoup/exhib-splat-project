// cut.mjs (lossless cutting with .3dm solids) and lib/solids.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import rhino3dm from 'rhino3dm';
import { tmpDir, writeGaussianPly } from './fixtures.mjs';
import { makeSolid } from '../lib/solids.mjs';
import { readPlyHeader } from '../lib/ply.mjs';
import { cutPly, layerMatches, loadCutters, parseCutArgs } from '../cut.mjs';

const dir = tmpDir('gsplat-cut-test-');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const rhino = await rhino3dm();

const CORNERS = (a, b) => [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], b[1], a[2]], [a[0], b[1], a[2]], [a[0], a[1], b[2]], [b[0], a[1], b[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]]];
const QUADS = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];

/** Box triangles for makeSolid. */
function boxTriangles(a, b) {
  const c = CORNERS(a, b);
  return QUADS.flatMap(([p, q, r, s]) => [...c[p], ...c[q], ...c[r], ...c[p], ...c[r], ...c[s]]);
}

function rhinoBoxMesh(a, b) {
  const m = new rhino.Mesh();
  for (const v of CORNERS(a, b)) m.vertices().add(...v);
  for (const q of QUADS) m.faces().addQuadFace(...q);
  return m;
}

/** A .3dm with the given objects: [{ layer, geometry, name? }], layers created as needed ("A::B" makes a sublayer). */
function write3dm(file, objects, { blocks = [] } = {}) {
  const doc = new rhino.File3dm();
  doc.settings().modelUnitSystem = rhino.UnitSystem.Meters;
  const layerIndex = new Map();
  const layer = (full) => {
    if (layerIndex.has(full)) return layerIndex.get(full);
    const parts = full.split('::');
    const l = new rhino.Layer();
    l.name = parts.at(-1);
    if (parts.length > 1) l.parentLayerId = doc.layers().get(layer(parts.slice(0, -1).join('::'))).id;
    const i = doc.layers().add(l);
    layerIndex.set(full, i);
    return i;
  };
  for (const b of blocks) {
    doc.instanceDefinitions().add(b.name, '', '', '', [0, 0, 0], b.geometry, b.geometry.map(() => new rhino.ObjectAttributes()));
  }
  for (const o of objects) {
    const attrs = new rhino.ObjectAttributes();
    attrs.layerIndex = layer(o.layer);
    if (o.name) attrs.name = o.name;
    if (o.block) {
      const idefs = doc.instanceDefinitions();
      const def = [...Array(idefs.count).keys()].map((i) => idefs.get(i)).find((d) => d.name === o.block);
      doc.objects().add(new rhino.InstanceReference(def.id, o.xform), attrs);
    } else {
      doc.objects().add(o.geometry, attrs);
    }
  }
  layer('unrelated');
  fs.writeFileSync(file, doc.toByteArray());
  return file;
}

/** Splat .ply where every record has distinct bytes (so record identity can be checked). */
function writeSplats(file, points) {
  const r = writeGaussianPly(file, points);
  const buf = fs.readFileSync(file);
  points.forEach((_, i) => buf.writeFloatLE(i + 0.5, r.headerBytes + i * r.stride + 6 * 4)); // f_dc_0 = id
  fs.writeFileSync(file, buf);
  return r;
}

function records(file) {
  const h = readPlyHeader(file);
  const buf = fs.readFileSync(file);
  const n = h.splatCount, stride = h.bytesPerSplat;
  return Array.from({ length: n }, (_, i) => buf.subarray(h.headerBytes + i * stride, h.headerBytes + (i + 1) * stride).toString('hex'));
}

const grid = () => {
  const pts = [];
  for (let x = 0.05; x < 4; x += 0.1) for (let y = 0.05; y < 2; y += 0.1) for (let z = 0.05; z < 2; z += 0.1) pts.push([x, y, z]);
  return pts;
};
const inBox = ([x, y, z], a, b) => x > a[0] && x < b[0] && y > a[1] && y < b[1] && z > a[2] && z < b[2];

test('makeSolid: box matches an exact test, hollow box, open mesh', () => {
  const a = [0.13, -0.27, 0.31], b = [1.7, 0.9, 2.2];
  const s = makeSolid(boxTriangles(a, b));
  assert.equal(s.openEdges, 0);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 3 - 0.8;
  for (let i = 0; i < 20000; i++) {
    const p = [rnd(), rnd(), rnd()];
    assert.equal(s.contains(...p), inBox(p, a, b), `point ${p}`);
  }
  // Rays through face diagonals, edges and vertices of the triangulation (every coordinate on a 1/4 grid).
  const unit = makeSolid(boxTriangles([0, 0, 0], [1, 1, 1]));
  for (let i = 1; i < 4; i++) for (let j = 1; j < 4; j++) for (let k = 1; k < 4; k++) {
    assert.ok(unit.contains(i / 4, j / 4, k / 4), `inside ${i} ${j} ${k}`);
    assert.ok(!unit.contains(i / 4 - 1, j / 4, k / 4) && !unit.contains(i / 4, j / 4, k / 4 + 1), `outside ${i} ${j} ${k}`);
  }
  // Shell with a cavity: parity says the cavity is outside.
  const hollow = makeSolid([...boxTriangles([0, 0, 0], [10, 10, 10]), ...boxTriangles([4, 4, 4], [6, 6, 6])]);
  assert.ok(hollow.contains(1, 1.3, 1.7));
  assert.ok(!hollow.contains(5.1, 4.9, 5.2));
  // Missing face: reported as open.
  assert.equal(makeSolid(boxTriangles(a, b).slice(0, 5 * 18)).openEdges, 4);
  assert.throws(() => makeSolid([0, 0, 0, 1, 0, 0, 0, 1, 0]), /at least 4 triangles/);
});

test('parseCutArgs and layerMatches', () => {
  const { opts, errors } = parseCutArgs(['in.ply', '--cuts', 'c.3dm', '--remove', 'a', '--remove=b', '--keep', 'k', '--margin', '1.5', '--dry-run']);
  assert.deepEqual(errors, []);
  assert.deepEqual([opts.input, opts.cuts, opts.remove, opts.keep, opts.margin, opts.dryRun], ['in.ply', 'c.3dm', ['a', 'b'], ['k'], 1.5, true]);
  assert.match(parseCutArgs(['in.ply']).errors.join(), /--cuts/);
  assert.match(parseCutArgs(['in.ply', '--cuts', 'c', '--margin', '-1']).errors.join(), /margin/);
  assert.ok(layerMatches('cut-remove', 'Cut-Remove'));
  assert.ok(layerMatches('cut-remove::walls', 'cut-remove'));
  assert.ok(layerMatches('Model::cut-remove', 'cut-remove'));
  assert.ok(layerMatches('Model::cut-remove::walls', 'Model::cut-remove'));
  assert.ok(!layerMatches('cut-remove-old', 'cut-remove'));
  assert.ok(!layerMatches('Other::cut-remove', 'Model::cut-remove'));
});

test('loadCutters: meshes, polysurface render meshes, Save Small, blocks, sublayers', async () => {
  const brep = rhino.Brep.createFromBoundingBox(new rhino.BoundingBox([2, 0, 0], [3, 1, 1]));
  const faces = brep.faces();
  for (let i = 0; i < faces.count; i++) {
    // What Rhino stores with a normal save: one render mesh per face.
    const bb = faces.get(i).duplicateFace(false).getBoundingBox(true);
    const flat = (lo, hi) => lo.map((v, a) => (hi[a] - v < 1e-9 ? [v, v] : [v, hi[a]]));
    const [[x0, x1], [y0, y1], [z0, z1]] = flat(bb.min, bb.max);
    const m = new rhino.Mesh();
    const pts = x0 === x1 ? [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]]
      : y0 === y1 ? [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]
        : [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]];
    for (const p of pts) m.vertices().add(...p);
    m.faces().addQuadFace(0, 1, 2, 3);
    faces.get(i).setMesh(m, rhino.MeshType.Render);
  }
  const bare = rhino.Brep.createFromBoundingBox(new rhino.BoundingBox([0, 0, 0], [1, 1, 1]));
  const file = write3dm(path.join(dir, 'kinds.3dm'), [
    { layer: 'cut-remove', geometry: rhinoBoxMesh([0, 0, 0], [1, 1, 1]), name: 'mesh box' },
    { layer: 'cut-remove::walls', geometry: brep, name: 'polysurface' },
    { layer: 'cut-remove', geometry: bare, name: 'save small' },
    { layer: 'cut-remove', geometry: new rhino.LineCurve([0, 0, 0], [1, 1, 1]), name: 'a curve' },
    { layer: 'cut-keep', block: 'unit', xform: rhino.Transform.translationXYZ(10, 0, 0), name: 'block' },
    { layer: 'unrelated', geometry: rhinoBoxMesh([0, 0, 0], [9, 9, 9]) },
  ], { blocks: [{ name: 'unit', geometry: [rhinoBoxMesh([0, 0, 0], [1, 1, 1])] }] });

  const c = await loadCutters(file);
  assert.equal(c.units, 'Meters');
  assert.deepEqual(c.remove.map((s) => s.name).sort(), ['mesh box', 'polysurface']);
  const poly = c.remove.find((s) => s.name === 'polysurface');
  assert.equal(poly.layer, 'cut-remove::walls');
  assert.equal(poly.openEdges, 0);
  assert.ok(poly.contains(2.5, 0.5, 0.5) && !poly.contains(1.5, 0.5, 0.5));
  assert.equal(c.keep.length, 1);
  assert.ok(c.keep[0].contains(10.5, 0.5, 0.5) && !c.keep[0].contains(0.5, 0.5, 0.5), 'block transform applied');
  assert.deepEqual(c.skipped.map((s) => s.name).sort(), ['a curve', 'save small']);
  assert.match(c.skipped.find((s) => s.name === 'save small').reason, /render mesh/);

  await assert.rejects(loadCutters(file, { remove: ['nope'] }), /no layer "nope"/);
  const onlyRemove = await loadCutters(file, { remove: ['cut-remove::walls'] });
  assert.deepEqual(onlyRemove.remove.map((s) => s.name), ['polysurface']);
});

test('cutPly: remove + keep, byte-identical records, removed file, dry run', async () => {
  const pts = grid();
  const input = path.join(dir, 'scan.ply');
  writeSplats(input, pts);
  const removeA = [0.5, 0.5, 0.5], removeB = [1.5, 1.5, 1.5];
  const keepA = [0, 0, 0], keepB = [3, 2, 2];
  const cuts = write3dm(path.join(dir, 'cuts.3dm'), [
    { layer: 'cut-remove', geometry: rhinoBoxMesh(removeA, removeB) },
    { layer: 'cut-keep', geometry: rhinoBoxMesh(keepA, keepB) },
  ]);
  const quiet = { log: () => {}, onProgress: () => {} };

  const dry = await cutPly({ input, cuts, dryRun: true, ...quiet });
  assert.equal(dry.out, null);
  assert.ok(!fs.existsSync(path.join(dir, 'scan-cut.ply')));

  const r = await cutPly({ input, cuts, removed: path.join(dir, 'gone.ply'), readBytes: 4096, ...quiet });
  const expectRemoved = pts.filter((p) => inBox(p, removeA, removeB));
  const expectOutside = pts.filter((p) => !inBox(p, removeA, removeB) && !inBox(p, keepA, keepB));
  assert.equal(r.removedInside, expectRemoved.length);
  assert.equal(r.removedOutsideKeep, expectOutside.length);
  assert.equal(r.keptSplats, pts.length - expectRemoved.length - expectOutside.length);
  assert.deepEqual([dry.keptSplats, dry.removedInside], [r.keptSplats, r.removedInside]);
  assert.equal(r.out, path.join(dir, 'scan-cut.ply'));

  // Lossless: kept + removed records are exactly the input's records, each in file order.
  const all = records(input), kept = records(r.out), gone = records(r.removedOut);
  const keptIdx = pts.map((p, i) => (inBox(p, removeA, removeB) || !inBox(p, keepA, keepB) ? -1 : i)).filter((i) => i >= 0);
  assert.deepEqual(kept, keptIdx.map((i) => all[i]));
  assert.deepEqual([...kept, ...gone].sort(), [...all].sort());
  // Header identical except the vertex count.
  const headerOf = (f) => fs.readFileSync(f).subarray(0, readPlyHeader(f).headerBytes).toString('latin1');
  assert.equal(headerOf(r.out), headerOf(input).replace(`element vertex ${pts.length}`, `element vertex ${kept.length}`));

  await assert.rejects(cutPly({ input, cuts, ...quiet }), /exists/);
});

test('cutPly --margin: splats reaching into a remove solid go too', async () => {
  // Three splats with sigma 0.1 along x, at 0.05 / 0.15 / 0.35 left of a box face at x = 1.
  const input = path.join(dir, 'edge.ply');
  const r0 = writeSplats(input, [[0.95, 0.5, 0.5], [0.85, 0.5, 0.5], [0.65, 0.5, 0.5]]);
  const buf = fs.readFileSync(input);
  const prop = (name) => (6 + 3 + 45 + ['opacity', 'scale_0', 'scale_1', 'scale_2'].indexOf(name)) * 4;
  for (let i = 0; i < 3; i++) {
    buf.writeFloatLE(Math.log(0.1), r0.headerBytes + i * r0.stride + prop('scale_0'));
    buf.writeFloatLE(Math.log(0.001), r0.headerBytes + i * r0.stride + prop('scale_1'));
    buf.writeFloatLE(Math.log(0.001), r0.headerBytes + i * r0.stride + prop('scale_2'));
  }
  fs.writeFileSync(input, buf);
  const cuts = write3dm(path.join(dir, 'edge.3dm'), [{ layer: 'cut-remove', geometry: rhinoBoxMesh([1, 0, 0], [2, 1, 1]) }]);
  const quiet = { log: () => {}, onProgress: () => {}, dryRun: true };
  assert.equal((await cutPly({ input, cuts, ...quiet })).removedInside, 0, 'centres are all outside');
  assert.equal((await cutPly({ input, cuts, margin: 1, ...quiet })).removedInside, 1);
  assert.equal((await cutPly({ input, cuts, margin: 2, ...quiet })).removedInside, 2);
});

test('cutPly: no usable solids is an error', async () => {
  const input = path.join(dir, 'tiny.ply');
  writeSplats(input, grid().slice(0, 50));
  const cuts = write3dm(path.join(dir, 'empty.3dm'), [{ layer: 'cut-remove', geometry: new rhino.LineCurve([0, 0, 0], [1, 1, 1]), name: 'just a line' }]);
  await assert.rejects(cutPly({ input, cuts, log: () => {}, onProgress: () => {} }), /no solids.*just a line/);
});
