// Focus regions (shared/focus-regions.mjs): validation, the box test in scene
// coordinates, and the Spirula prism export: read back through lib/roi.mjs in
// the source frame, the prism must hold exactly the points the box holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, quantifyModel } from '../focus-regions.mjs';
import { tmpDir, writeGaussianPly } from './fixtures.mjs';
import { FOCUS_TIERS, nextRegionId, quatToMat3, regionBackContains, regionContains, regionFacing, regionsToSpirula, regionToSourcePrism, validateFocusRegions } from '../../shared/focus-regions.mjs';
import { createScene, mat4Invert, mat4ApplyPoint, transformFromTRS, validateScene } from '../../shared/scene-schema.mjs';
import { parseRoi } from '../lib/roi.mjs';

const unitQuat = (x, y, z, w) => {
  const n = Math.hypot(x, y, z, w);
  return [x / n, y / n, z / n, w / n];
};
const box = (over = {}) => ({ id: 'r1', name: 'Mural', tier: 'hero', center: [1, 1.5, -2], size: [2, 1, 0.4], quaternion: unitQuat(0.1, 0.4, -0.2, 0.9), ...over });

test('validateFocusRegions accepts a good list and names each problem', () => {
  assert.deepEqual(validateFocusRegions([box(), box({ id: 'r2', tier: 'low' })]), []);
  assert.deepEqual(validateFocusRegions([]), []);
  const errors = validateFocusRegions([box(), box({ size: [1, 0, 1], tier: 'max' }), box({ id: 'bad id', quaternion: [0, 0, 0, 2] })]);
  assert.ok(errors.some((e) => /"r1" is used twice/.test(e)));
  assert.ok(errors.some((e) => /size must be three positive/.test(e)));
  assert.ok(errors.some((e) => /tier must be one of hero, high, low/.test(e)));
  assert.ok(errors.some((e) => /id "bad id" is invalid/.test(e)));
  assert.ok(errors.some((e) => /unit quaternion/.test(e)));
  assert.deepEqual(FOCUS_TIERS, ['hero', 'high', 'low']);
});

test('validateScene keeps focusRegions and rejects bad ones', () => {
  const doc = createScene({ name: 's', source: 'assets/source_ply/a.ply' });
  assert.equal(validateScene({ ...doc, focusRegions: [box()] }).scene.focusRegions.length, 1);
  assert.equal(validateScene(doc).scene.focusRegions, undefined);
  const { scene, errors } = validateScene({ ...doc, focusRegions: [box({ tier: 'ultra' })] });
  assert.equal(scene, null);
  assert.match(errors.join(';'), /focusRegions\[0\]\.tier/);
});

test('regionContains: a rotated box holds its corners and not just past them', () => {
  const r = box();
  const inside = regionContains(r);
  const [x, y, z, w] = r.quaternion;
  // Box axes are the columns of the rotation.
  const R = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
  const at = (lx, ly, lz) => [0, 1, 2].map((i) => r.center[i] + R[3 * i] * lx + R[3 * i + 1] * ly + R[3 * i + 2] * lz);
  assert.ok(inside(...at(0.99, 0.49, 0.19)));
  assert.ok(inside(...at(-0.99, -0.49, -0.19)));
  assert.ok(!inside(...at(1.01, 0, 0)));
  assert.ok(!inside(...at(0, 0.51, 0)));
  assert.ok(!inside(...at(0, 0, -0.21)));
});

test('regionToSourcePrism: the exported prism holds the same points in the source frame', () => {
  // A HighRezOculus-like transform: scale 8, -90 deg about X, translated.
  const t = transformFromTRS({ position: [-1.2, -0.5, 5.1], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: 8 });
  const inv = mat4Invert(t.matrix);
  const regions = [box(), box({ id: 'r2', center: [-3, 0.2, 4], size: [0.5, 2.5, 1.2], quaternion: unitQuat(0, 0.7, 0, 0.7) })];
  const prism = parseRoi(regionsToSpirula(regions, t.matrix));
  const scene = regions.map(regionContains);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let insideCount = 0;
  for (let i = 0; i < 20000; i++) {
    const p = [-5 + 9 * rand(), -1.5 + 4 * rand(), -4 + 10 * rand()];
    const want = scene.some((f) => f(...p));
    const src = mat4ApplyPoint(inv, p);
    assert.equal(prism.contains(...src), want, `point ${p} (source ${src})`);
    if (want) insideCount++;
  }
  assert.ok(insideCount > 100, `the sample should hit the boxes (${insideCount})`);
  // Spirula's prism rotation must be a proper rotation (parseRoi checks), and sizes shrink by the scale.
  const one = regionToSourcePrism(regions[0], t.matrix);
  assert.ok(Math.abs(one.half_height - 0.4 / 2 / 8) < 1e-12);
});

test('quantifyModel counts kept splats per region in scene coordinates', () => {
  const dir = tmpDir('focus-quantify-');
  // A 10x10x10 grid in the source frame, scale_* = 0 (sigma 1 source unit).
  const points = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) for (let k = 0; k < 10; k++) points.push([i, j, k]);
  const a = path.join(dir, 'a.ply');
  writeGaussianPly(a, points, { shRest: 0 });
  writeGaussianPly(path.join(dir, 'b.ply'), points, { shRest: 0 });
  // Scene = 2 x source, rotated 90 deg about Y, shifted.
  const t = transformFromTRS({ position: [5, 0, -3], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: 2 });
  // A region-of-interest crop on part a: source x < 4.5 only.
  const roiFile = path.join(dir, 'roi.json');
  fs.writeFileSync(roiFile, JSON.stringify({ type: 'prism', center: [2, 4.5, 4.5], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], half_height: 10, polygon: [-2.5, -10, 2.5, -10, 2.5, 10, -2.5, 10] }));
  const model = {
    name: 'm',
    transform: t,
    parts: [
      { id: 'a', source: a, enabled: true, roi: roiFile },
      { id: 'b', source: path.join(dir, 'b.ply'), enabled: false },
    ],
  };
  const regions = [
    box({ id: 'r1', center: [8, 6, -6], size: [6, 6, 6], quaternion: [0, 0, 0, 1] }),
    box({ id: 'r2', center: [0, 0, 0], size: [1, 1, 1], quaternion: [0, 0, 0, 1] }),
  ];
  const r = quantifyModel(model, regions, () => {});
  const kept = points.filter(([x]) => x < 4.5);
  assert.equal(r.splats, kept.length, 'the roi crop and the disabled part are honoured');
  const tests = regions.map(regionContains);
  for (let i = 0; i < regions.length; i++) {
    const want = kept.filter((p) => tests[i](...mat4ApplyPoint(t.matrix, p))).length;
    assert.equal(r.regions[i].count, want, `region ${regions[i].id}`);
  }
  assert.ok(r.regions[0].count > 0);
  assert.equal(r.regions[1].count, 0);
  assert.ok(Math.abs(r.regions[0].sizeMm - 2000) < 1e-3, 'size is sigma x scene scale, in mm');
  assert.equal(r.regions[1].sizeMm, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['quantify', 'A', '--compare', 'B', '--compare', 'C', '--json', 'x.json']), { command: 'quantify', scene: 'A', compare: ['B', 'C'], json: 'x.json', out: null, tiers: null });
  assert.deepEqual(parseArgs(['export', 'A', '--out', 'r.json', '--tier', 'hero,high']).tiers, ['hero', 'high']);
  assert.throws(() => parseArgs(['export', 'A']), /--out/);
  assert.throws(() => parseArgs(['quantify', 'A', '--tier', 'max']), /--tier/);
  assert.throws(() => parseArgs(['count', 'A']), /command/);
});

test('nextRegionId fills the first gap', () => {
  assert.equal(nextRegionId([]), 'r1');
  assert.equal(nextRegionId(['r1', 'r3']), 'r2');
});

test('regionFacing: the camera side of a wall panel, both sides for a free-standing one', () => {
  const r = box(); // thinnest axis: local z (0.4)
  const R = quatToMat3(r.quaternion);
  const n = [R[2], R[5], R[8]];
  const at = (d, lateral = 0) => r.center.map((c, i) => c + d * n[i] + lateral * R[3 * i]);
  const looking = (p) => ({ center: p, forward: r.center.map((c, i) => c - p[i]).map((v, _, a) => v / Math.hypot(...a)) });
  const front = Array.from({ length: 10 }, (_, k) => looking(at(2 + k * 0.1, k * 0.2 - 1)));
  assert.deepEqual(regionFacing(r, front), { axis: 2, normal: n, front: 1, counts: [0, 10] });
  // Cameras looking away, or standing within the box's depth, don't count.
  const away = front.map((c) => ({ ...c, forward: c.forward.map((v) => -v) }));
  const edgeOn = [looking(at(0.1, 3))];
  assert.equal(regionFacing(r, [...away, ...edgeOn]).front, 0);
  const behind = Array.from({ length: 3 }, (_, k) => looking(at(-2 - k * 0.1)));
  assert.equal(regionFacing(r, [...front, behind[0]]).front, 1); // 1 in 10 behind: still a wall panel
  assert.deepEqual(regionFacing(r, [...front, ...behind]).counts, [3, 10]); // 3 in 10: seen from both sides
  assert.equal(regionFacing(r, [...front, ...behind]).front, 0);
  assert.equal(regionFacing(r, front.slice(0, 4)).front, 0); // too few cameras
});

test('regionBackContains: the footprint extruded behind the box, away from the front', () => {
  const r = box();
  const R = quatToMat3(r.quaternion);
  const p = (lx, ly, lz) => r.center.map((c, i) => c + lx * R[3 * i] + ly * R[3 * i + 1] + lz * R[3 * i + 2]);
  const back = regionBackContains(r, 1, 0.5); // front +z: behind is -z, from -0.2 to -0.7
  assert.equal(back(...p(0, 0, -0.3)), true);
  assert.equal(back(...p(0.9, 0.4, -0.69)), true);
  assert.equal(back(...p(0, 0, -0.1)), false); // inside the box
  assert.equal(back(...p(0, 0, -0.75)), false); // past the depth
  assert.equal(back(...p(0, 0, 0.3)), false); // in front
  assert.equal(back(...p(1.1, 0, -0.3)), false); // outside the footprint
  assert.equal(regionBackContains(r, -1, 0.5)(...p(0, 0, 0.3)), true);
});
