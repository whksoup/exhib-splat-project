// lib/roi.mjs (Spirula ROI region files) and scene-roi.mjs helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, writeGaussianPly } from './fixtures.mjs';
import { parseRoi, readRoi } from '../lib/roi.mjs';
import { parseSceneRoiArgs, roiTarget, shareInside } from '../scene-roi.mjs';

const dir = tmpDir('gsplat-roi-test-');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// Shape of Spirula's region6.json: a quad prism plus the editor outlines it came from.
const region = (o = {}) => ({
  type: 'prism', center: [1, 2, 3], rotation: I, half_height: 0.5,
  polygon: [-1, -1, 1, -1, 1, 1, -1, 1],
  editor: { version: 1, shapes: [{ name: 'Outline 1', kind: 'prism', op: 'add', enabled: true }] },
  ...o,
});

test('parseRoi: prism containment, rotation, digest, validation', () => {
  const r = parseRoi(region());
  assert.ok(r.contains(1, 2, 3));
  assert.ok(r.contains(1.9, 1.1, 3.49));
  assert.ok(!r.contains(2.1, 2, 3), 'outside the outline');
  assert.ok(!r.contains(1, 2, 3.6), 'above the prism');
  assert.ok(!r.contains(1, 2, 2.4), 'below the prism');
  assert.equal(r.rotated, false);

  // Non-convex outline (an L): the notch is outside.
  const L = parseRoi(region({ center: [0, 0, 0], polygon: [0, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2] }));
  assert.ok(L.contains(0.5, 1.5, 0));
  assert.ok(L.contains(1.5, 0.5, 0));
  assert.ok(!L.contains(1.5, 1.5, 0));

  // Rotation maps local -> world: a box long in local x, turned 90 degrees about z, is long in world y.
  const Rz = [0, -1, 0, 1, 0, 0, 0, 0, 1]; // row-major
  const long = parseRoi(region({ center: [0, 0, 0], rotation: Rz, polygon: [-3, -1, 3, -1, 3, 1, -3, 1] }));
  assert.ok(long.rotated);
  assert.ok(long.contains(0, 2.5, 0));
  assert.ok(!long.contains(2.5, 0, 0));

  // The digest follows the region, not the editor block.
  assert.equal(parseRoi(region({ editor: { shapes: [] } })).digest, r.digest);
  assert.notEqual(parseRoi(region({ half_height: 0.6 })).digest, r.digest);

  assert.throws(() => parseRoi(region({ type: 'sphere' })), /not supported/);
  assert.throws(() => parseRoi(region({ center: [0, 0] })), /center/);
  assert.throws(() => parseRoi(region({ half_height: 0 })), /half_height/);
  assert.throws(() => parseRoi(region({ polygon: [0, 0, 1, 1] })), /polygon/);
  assert.throws(() => parseRoi(region({ rotation: [2, 0, 0, 0, 1, 0, 0, 0, 1] })), /not a rotation/);
  assert.throws(() => parseRoi(region({ rotation: [-1, 0, 0, 0, 1, 0, 0, 0, 1] })), /reflection/);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{');
  assert.throws(() => readRoi(path.join(dir, 'bad.json')), /cannot read/);
});

test('parseRoi: an outline from the editor block, by name', () => {
  // Same shape as Spirula's file: the top-level region is the enabled outline,
  // re-centred at the middle of its z span.
  const outline = (name, origin, lo, hi, polygon, o = {}) => ({ name, kind: 'prism', op: 'add', enabled: false, origin, rotation: I, lo: [0, 0, lo], hi: [0, 0, hi], polygon, ...o });
  const json = region({
    center: [0.67, -0.04, 0.78], half_height: 1.31, polygon: [-1, -1, 1, -1, 1, 1, -1, 1],
    editor: {
      version: 1,
      shapes: [
        outline('Outline 1', [-2, 0, 0], 0, 2, [-0.5, -0.5, 0.5, -0.5, 0, 0.5]),
        outline('Outline 3', [0.67, -0.04, -0.06], -0.47, 2.15, [-1, -1, 1, -1, 1, 1, -1, 1], { enabled: true }),
        outline('Cut', [0, 0, 0], 0, 1, [0, 0, 1, 0, 1, 1], { op: 'subtract' }),
        outline('Twin', [0, 0, 0], 0, 1, [0, 0, 1, 0, 1, 1]),
        outline('Twin', [0, 0, 0], 0, 1, [0, 0, 1, 0, 1, 1]),
      ],
    },
  });
  const top = parseRoi(json);
  const o3 = parseRoi(json, 'r', 'Outline 3');
  close3(o3.center, [0.67, -0.04, 0.78]);
  assert.ok(Math.abs(o3.halfHeight - 1.31) < 1e-12);
  for (const p of [[0.67, -0.04, 0.78], [1.6, 0.9, 2.08], [1.6, 0.9, 2.1], [0.67, -0.04, -0.54], [1.7, 0, 1]]) {
    assert.equal(o3.contains(...p), top.contains(...p), `same as the top-level region at ${p}`);
  }
  const o1 = parseRoi(json, 'r', 'Outline 1');
  assert.ok(o1.contains(-2, -0.2, 1.9));
  assert.ok(!o1.contains(-2, -0.2, 2.1), 'above hi');
  assert.ok(!o1.contains(-2, 0.6, 1), 'outside the triangle');
  assert.throws(() => parseRoi(json, 'r', 'Outline 9'), /no outline named "Outline 9" \(outlines: Outline 1, Outline 3, Cut, Twin, Twin\)/);
  assert.throws(() => parseRoi(json, 'r', 'Cut'), /op "subtract"/);
  assert.throws(() => parseRoi(json, 'r', 'Twin'), /2 outlines are named/);
});

test('parseRoi: union regions, top-level and from several outlines', () => {
  const box = (cx) => ({ type: 'prism', center: [cx, 0, 0], rotation: I, half_height: 1, polygon: [-1, -1, 1, -1, 1, 1, -1, 1] });
  const shape = (name, cx) => ({ name, kind: 'prism', op: 'add', enabled: true, origin: [cx, 0, -1], rotation: I, lo: [0, 0, 0], hi: [0, 0, 2], polygon: [-1, -1, 1, -1, 1, 1, -1, 1] });
  // Like Oculus6Part.json: the top-level region is a union of the enabled outlines.
  const json = { type: 'union', children: [box(0), box(5)], editor: { version: 1, shapes: [shape('Outline 1', 0), shape('Outline 2', 5), shape('Outline 3', 10)] } };
  const top = parseRoi(json);
  assert.equal(top.type, 'union');
  assert.equal(top.prisms.length, 2);
  assert.ok(top.contains(0.5, 0, 0) && top.contains(5.5, 0, 0));
  assert.ok(!top.contains(2.5, 0, 0), 'between the children');
  assert.ok(!top.contains(10, 0, 0));
  const o12 = parseRoi(json, 'r', ['Outline 2', 'Outline 1']);
  assert.equal(o12.digest, parseRoi(json, 'r', ['Outline 2', 'Outline 1']).digest);
  for (const p of [[0.5, 0, 0], [5.5, 0, 0.9], [2.5, 0, 0], [10, 0, 0], [5, 0, 1.1]]) assert.equal(o12.contains(...p), top.contains(...p), `${p}`);
  assert.ok(parseRoi(json, 'r', ['Outline 3']).contains(10, 0, 0));
  assert.equal(parseRoi(json, 'r', 'Outline 3').digest, parseRoi(json, 'r', ['Outline 3']).digest, 'a name or a one-item list');
  assert.throws(() => parseRoi(json, 'r', ['Outline 1', 'Outline 1']), /listed twice/);
  assert.throws(() => parseRoi({ type: 'union', children: [] }), /non-empty/);
  assert.throws(() => parseRoi({ type: 'union', children: [box(0), { ...box(1), half_height: -1 }] }), /prism 2: "half_height"/);
  // A single prism keeps the digest it had before unions were supported (no rebuild of earlier builds).
  assert.equal(parseRoi(region()).digest, parseRoi(region({ editor: {} })).digest);
});

const close3 = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-12, `${v} vs ${b[i]}`));

test('scene-roi: arguments, copy into the repo, share inside', () => {
  assert.deepEqual(parseSceneRoiArgs(['s', '--roi', 'r.json', '--outline', 'Outline 2', '--outline=Outline 1', '--outline', 'Outline 2']).opts.outlines, ['Outline 2', 'Outline 1']);
  assert.match(parseSceneRoiArgs(['s', '--off', '--outline', 'x']).errors.join(), /--off/);
  assert.deepEqual(parseSceneRoiArgs(['s', '--roi', 'r.json', '--part', 'a', '--part=b']).opts.parts, ['a', 'b']);
  assert.match(parseSceneRoiArgs(['s']).errors.join(), /Missing --roi/);
  assert.match(parseSceneRoiArgs(['s', '--roi', 'r.txt']).errors.join(), /\.json/);
  assert.match(parseSceneRoiArgs(['s', '--off', '--roi', 'r.json']).errors.join(), /--off/);
  assert.deepEqual(parseSceneRoiArgs(['s', '--off']).errors, []);

  const root = path.join(dir, 'repo');
  const outside = path.join(dir, 'spirula', 'roi', 'region6.json');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(outside, JSON.stringify(region()));
  assert.deepEqual(roiTarget(outside, 'scn', { root }), { rel: 'assets/roi/scn/region6.json', copyFrom: outside });
  fs.mkdirSync(path.join(root, 'assets', 'roi', 'scn'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'roi', 'scn', 'region6.json'), JSON.stringify(region(), null, 4));
  assert.deepEqual(roiTarget(outside, 'scn', { root }), { rel: 'assets/roi/scn/region6.json', copyFrom: null }, 'same file already copied');
  fs.writeFileSync(outside, JSON.stringify(region({ editor: { version: 1, shapes: [] } })));
  assert.throws(() => roiTarget(outside, 'scn', { root }), /different region file/, 'outlines changed: not the same file');
  fs.writeFileSync(outside, JSON.stringify(region({ half_height: 2 })));
  assert.throws(() => roiTarget(outside, 'scn', { root }), /different region file/);
  assert.equal(roiTarget(outside, 'scn', { root, overwrite: true }).copyFrom, outside);
  assert.deepEqual(roiTarget('assets/roi/scn/region6.json', 'scn', { root }), { rel: 'assets/roi/scn/region6.json', copyFrom: null }, 'in the repo: used in place');

  const ply = path.join(dir, 'p.ply');
  writeGaussianPly(ply, [[1, 2, 3], [1.5, 2.5, 3.2], [5, 5, 5], [1, 2, 9]]);
  assert.equal(shareInside(ply, parseRoi(region())), 0.5);
});
