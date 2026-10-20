// Scene save files: shared schema maths (composition, delta preview) and
// build-scene.mjs end to end with the stand-in build-lod (real splat-transform).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { tmpDir, writeGaussianPly, FAKE_BUILD_LOD } from './fixtures.mjs';
import { parseBuildSceneArgs, makeBuildLodProgress } from '../build-scene.mjs';
import { parseNewSceneArgs } from '../new-scene.mjs';
import { swapBuildDir, acquireBuildLock } from '../lib/scene-files.mjs';
import { composeMatrix } from '../lib/transform.mjs';
import { readPlyHeader, scanPlyPositions } from '../lib/ply.mjs';
import {
  createScene, validateScene, composeTransforms, transformFromTRS, transformFromMatrix, deltaMatrix,
  mat4Multiply, mat4Invert, mat4ApplyPoint, matricesEqual, isIdentityMatrix, transformChangedSinceBuild,
  navMayBeMisaligned, previewPlan, isSafeSceneRelPath, isSafeSourcePath, decomposeTRS, IDENTITY,
} from '../../shared/scene-schema.mjs';

const PIPELINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = tmpDir('gsplat-scene-test-');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const close = (a, b, tol = 1e-9) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tol, `[${i}] ${v} vs ${b[i]}`));

// The user's real v1 transforms (assets/transforms/*.json at the time of migration).
const T1 = {
  position: [-0.03662110882969907, 0.19596746045457614, -1.872558583904338],
  quaternion: [-0.7071067811865475, 0, 0, 0.7071067811865476],
  scale: 5,
  matrix: [5, 0, 0, 0, 0, 1.1102230246251565e-15, -5, 0, 0, 5, 1.1102230246251565e-15, 0, -0.03662110882969907, 0.19596746045457614, -1.872558583904338, 1],
};
const T2 = {
  position: [0.8361895813316569, -0.44364187745769335, -1.4957548639379472],
  quaternion: [0, 0, 0, 1],
  scale: 1,
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.8361895813316569, -0.44364187745769335, -1.4957548639379472, 1],
};

test('schema: compose matches three.js and pipeline composeMatrix', () => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -1.1, 2.0, 'XYZ'));
  const t = transformFromTRS({ position: [1, -2, 3], quaternion: q.toArray(), scale: 1.7 });
  const m3 = new THREE.Matrix4().compose(new THREE.Vector3(1, -2, 3), q, new THREE.Vector3(1.7, 1.7, 1.7));
  close(t.matrix, m3.elements, 1e-12);
  close(t.matrix, composeMatrix([1, -2, 3], q.toArray(), 1.7), 1e-12);
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  close(t.rotationDeg, [e.x, e.y, e.z].map(THREE.MathUtils.radToDeg), 1e-9);
  // decompose round trip, including a negative-w input quaternion
  const d = decomposeTRS(t.matrix);
  close(transformFromTRS(d).matrix, t.matrix, 1e-12);
  assert.ok(d.quaternion[3] >= 0);
});

test('schema: inverse and multiply', () => {
  const t = transformFromTRS({ position: [4, 5, -6], quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(1, 2, 3)).toArray(), scale: 0.3 });
  close(mat4Multiply(t.matrix, mat4Invert(t.matrix)), IDENTITY, 1e-12);
  const m3 = new THREE.Matrix4().fromArray(t.matrix);
  close(mat4Invert(t.matrix), m3.clone().invert().elements, 1e-12);
  assert.ok(isIdentityMatrix(IDENTITY));
  assert.throws(() => decomposeTRS([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), /non-uniform/);
  assert.throws(() => decomposeTRS([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), /reflection/);
});

test('migration maths: M2 * M1 equals baking T1 then T2', () => {
  const combined = composeTransforms([T1, T2]);
  close(combined.matrix, mat4Multiply(T2.matrix, T1.matrix), 1e-12);
  close(combined.position, [T1.position[0] + T2.position[0], T1.position[1] + T2.position[1], T1.position[2] + T2.position[2]], 1e-12);
  assert.deepEqual(combined.rotationDeg, [-90, 0, 0]);
  assert.equal(combined.scale, 5);
  for (const p of [[-4.282, -3.5569, -0.6063], [1.632, 1.248, 2.909], [0.1, 0.2, 0.3]]) {
    close(mat4ApplyPoint(combined.matrix, p), mat4ApplyPoint(T2.matrix, mat4ApplyPoint(T1.matrix, p)), 1e-12);
  }
});

test('delta preview: D * T_built * p == T_new * p', () => {
  const built = transformFromTRS({ position: [0.5, -1, 2], quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)).toArray(), scale: 5 });
  const next = transformFromTRS({ position: [3, 0.25, -4], quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0.4, 0.1)).toArray(), scale: 4.2 });
  const D = deltaMatrix(next.matrix, built.matrix);
  for (const p of [[0, 0, 0], [1, 2, 3], [-7, 0.5, 11]]) {
    close(mat4ApplyPoint(D, mat4ApplyPoint(built.matrix, p)), mat4ApplyPoint(next.matrix, p), 1e-9);
  }
  // Unchanged transform -> identity delta; D stays a similarity (decomposable for a three.js mesh).
  assert.ok(isIdentityMatrix(deltaMatrix(built.matrix, built.matrix), 1e-12));
  close(transformFromMatrix(D).matrix, D, 1e-9);

  const scene = createScene({ name: 's', source: 'assets/source_ply/a.ply', transform: next });
  assert.equal(previewPlan(scene).mode, 'source');
  close(previewPlan(scene).matrix, next.matrix);
  scene.build = { status: 'ok', transformMatrix: built.matrix, radFile: 's-lod.rad' };
  assert.equal(previewPlan(scene).mode, 'built');
  close(previewPlan(scene).matrix, D);
  assert.equal(previewPlan(scene, { builtAvailable: false }).mode, 'source');
  assert.ok(transformChangedSinceBuild(scene));
  scene.build.transformMatrix = [...next.matrix];
  assert.ok(!transformChangedSinceBuild(scene));
});

test('schema: validateScene, nav misalignment, path safety', () => {
  const s = createScene({ name: 'lobby_1', source: 'assets/source_ply/a.ply', now: 't' });
  const { scene, errors } = validateScene(JSON.parse(JSON.stringify({ ...s, futureKey: 1 })));
  assert.deepEqual(errors, []);
  assert.equal(scene.futureKey, 1, 'unknown keys survive');
  assert.match(validateScene({ ...s, schemaVersion: 2 }).errors.join(), /schemaVersion/);
  assert.match(validateScene({ ...s, name: '../x' }).errors.join(), /name/);
  assert.match(validateScene({ ...s, navigation: { collision: '../../etc/x.glb' } }).errors.join(), /collision/);
  assert.match(validateScene({ ...s, transform: { ...s.transform, scale: 2 } }).errors.join(), /disagrees/);
  assert.match(validateScene({ ...s, buildOptions: { extraFlags: ['--max-sh=3'] } }).errors.join(), /conflicts/);
  assert.throws(() => createScene({ name: 'a.b', source: 'x.ply' }), /invalid scene name/);

  assert.ok(!navMayBeMisaligned(s));
  s.floorY = 0;
  s.navTransformMatrix = [...s.transform.matrix];
  assert.ok(!navMayBeMisaligned(s));
  s.transform = transformFromTRS({ position: [0, 1, 0], quaternion: [0, 0, 0, 1], scale: 1 });
  assert.ok(navMayBeMisaligned(s));

  assert.ok(isSafeSceneRelPath('nav/collision.glb'));
  for (const bad of ['../x.glb', '/abs.glb', 'nav/../x', 'C:/x.glb', 'nav\\x.glb', '.hidden/x', '']) assert.ok(!isSafeSceneRelPath(bad), bad);
  assert.ok(isSafeSourcePath('assets/source_ply/OculusMerged_1.ply'));
  for (const bad of ['../x.ply', 'assets/x.rad', '/x.ply', 'a/./b.ply', 'C:/x.ply']) assert.ok(!isSafeSourcePath(bad), bad);
  assert.ok(matricesEqual(IDENTITY, [...IDENTITY]));
});

test('build-scene / new-scene argument parsing', () => {
  assert.deepEqual(parseBuildSceneArgs(['oculus', '--keep-temp']).errors, []);
  assert.match(parseBuildSceneArgs([]).errors.join(), /Missing scene name/);
  assert.match(parseBuildSceneArgs(['../etc']).errors.join(), /Invalid scene name/);
  assert.match(parseBuildSceneArgs(['a.b']).errors.join(), /Invalid scene name/);
  assert.match(parseBuildSceneArgs(['a', 'b']).errors.join(), /one scene name/);
  assert.match(parseBuildSceneArgs(['a', '--bogus']).errors.join(), /Unknown option/);
  const n = parseNewSceneArgs(['x', '--source', 'assets/source_ply/a.ply', '--transform', 'a.json', '--transform=b.json']);
  assert.deepEqual(n.errors, []);
  assert.deepEqual(n.opts.transforms, ['a.json', 'b.json']);
  assert.match(parseNewSceneArgs(['x', '--source', '../a.ply']).errors.join(), /--source/);
});

test('build-lod progress parsing', () => {
  const seen = [];
  const feed = makeBuildLodProgress((p) => seen.push(p), { from: 10, lodTo: 90, chunksTo: 98 });
  feed('Level: -19, step: 0.1, frontier: 0 / 100, # active: 1\nLevel: -5, step: 0.2, front');
  feed('ier: 50 / 100, # active: 1\nWrote x-lod-0.radc (5 bytes)\n');
  assert.deepEqual(seen.map((p) => p.stage), ['lod', 'lod', 'chunks']);
  assert.equal(seen[0].pct, 10);
  assert.equal(seen[1].pct, 50);
  assert.ok(seen[2].pct >= 90 && seen[2].pct < 98);
});

test('swapBuildDir replaces the old build and keeps it when the swap fails', () => {
  const root = path.join(dir, 'swap');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'old.rad'), 'old');
  fs.mkdirSync(path.join(root, '.build-tmp'));
  fs.writeFileSync(path.join(root, '.build-tmp', 'new.rad'), 'new');
  swapBuildDir(path.join(root, '.build-tmp'), path.join(root, 'build'));
  assert.deepEqual(fs.readdirSync(path.join(root, 'build')), ['new.rad']);
  assert.deepEqual(fs.readdirSync(root).sort(), ['build']);
  assert.throws(() => swapBuildDir(path.join(root, 'missing'), path.join(root, 'build')));
  assert.deepEqual(fs.readdirSync(path.join(root, 'build')), ['new.rad'], 'old build restored');
});

test('build lock: one build at a time, stale locks are replaced', () => {
  const root = path.join(dir, 'locks');
  const release = acquireBuildLock(root, 'a');
  assert.throws(() => acquireBuildLock(root, 'b'), /another scene build is running/);
  release();
  fs.writeFileSync(path.join(root, '.build.lock'), JSON.stringify({ pid: 2 ** 30, scene: 'dead' }));
  acquireBuildLock(root, 'c')();
  assert.ok(!fs.existsSync(path.join(root, '.build.lock')));
});

// --- end to end --------------------------------------------------------------

const scenesRoot = path.join(dir, 'scenes');
const fake = path.join(dir, 'fake-build-lod.mjs');
fs.writeFileSync(fake, FAKE_BUILD_LOD);

function runBuildScene(args, env = {}) {
  return spawnSync(process.execPath, [path.join(PIPELINE, 'build-scene.mjs'), ...args, '--build-lod', fake], {
    encoding: 'utf8',
    env: { ...process.env, PIPELINE_SCENES_ROOT: scenesRoot, PIPELINE_BUILD_LOG: path.join(dir, 'reports', 'build-log.jsonl'), ...env },
  });
}

function makeScene(name, source, transform) {
  const d = path.join(scenesRoot, name);
  fs.mkdirSync(path.join(d, 'nav'), { recursive: true });
  // Absolute source paths are allowed for tests (resolved against the repo root otherwise).
  const s = createScene({ name, source, transform });
  fs.writeFileSync(path.join(d, 'scene.json'), JSON.stringify(s, null, 2));
  return d;
}

const lines = (out, kind) => out.split(/\r?\n/).filter((l) => l.startsWith(`@${kind} `)).map((l) => JSON.parse(l.slice(kind.length + 2)));

test('build-scene: transformed build from the original source, then rebuild overwrites build/', () => {
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const src = path.join(srcDir, 'Scan 01.ply');
  const pts = [[1, 2, 3], [-1, 0.5, 2], [0.25, -3, 4]];
  writeGaussianPly(src, pts, { shRest: 0 });
  const srcBytes = fs.readFileSync(src);
  const t = transformFromTRS({ position: [2, -1, 3], quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)).toArray(), scale: 5 });
  const sceneDir = makeScene('scn', src, t);

  const r = runBuildScene(['scn']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const files = fs.readdirSync(path.join(sceneDir, 'build')).sort();
  assert.deepEqual(files, ['build-lod.log', 'build-report.json', 'scn-lod-0.radc', 'scn-lod-1.radc', 'scn-lod.rad']);
  assert.deepEqual(fs.readdirSync(sceneDir).sort(), ['build', 'nav', 'scene.json'], 'no temp dir or temp .ply left');
  assert.deepEqual(fs.readdirSync(srcDir), ['Scan 01.ply']);
  assert.ok(fs.readFileSync(src).equals(srcBytes), 'source unchanged');

  const scene = JSON.parse(fs.readFileSync(path.join(sceneDir, 'scene.json'), 'utf8'));
  assert.equal(scene.build.status, 'ok');
  assert.equal(scene.build.radFile, 'scn-lod.rad');
  close(scene.build.transformMatrix, t.matrix, 0);
  assert.equal(scene.buildAttempt.status, 'ok');
  assert.equal(scene.build.splatCount.final, 7);
  assert.deepEqual(scene.build.buildLodFlags, ['--quality', '--rad-chunked', '--max-sh=1']);
  // Build bounds = bbox of T applied to the source points (float32 precision).
  const tp = pts.map((p) => mat4ApplyPoint(t.matrix, p));
  close(scene.build.bounds.bboxMin, [0, 1, 2].map((i) => Math.min(...tp.map((p) => p[i]))), 1e-5);
  close(scene.build.bounds.bboxMax, [0, 1, 2].map((i) => Math.max(...tp.map((p) => p[i]))), 1e-5);
  assert.equal(validateScene(scene).errors.length, 0);

  const rep = JSON.parse(fs.readFileSync(path.join(sceneDir, 'build', 'build-report.json'), 'utf8'));
  assert.equal(rep.input.scene, 'scn');
  assert.equal(rep.input.bakedFromSource, true);

  const prog = lines(r.stdout, 'progress');
  assert.ok(prog.some((p) => p.stage === 'transform'));
  assert.ok(prog.some((p) => p.stage === 'chunks'));
  assert.equal(prog.at(-1).pct, 100);
  assert.equal(lines(r.stdout, 'result').at(-1).status, 'ok');

  // Rebuild with a changed transform: build/ is replaced, not accumulated.
  const s2 = { ...scene, transform: transformFromTRS({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 2 }) };
  fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify(s2, null, 2));
  const r2 = runBuildScene(['scn']);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.deepEqual(fs.readdirSync(path.join(sceneDir, 'build')).sort(), files);
  const scene2 = JSON.parse(fs.readFileSync(path.join(sceneDir, 'scene.json'), 'utf8'));
  close(scene2.build.transformMatrix, s2.transform.matrix, 0);
  close(scene2.build.bounds.bboxMax, [2, 4, 8], 1e-6);
});

test('build-scene: identity transform builds straight from the source', () => {
  const src = path.join(dir, 'src', 'plain.ply');
  writeGaussianPly(src, [[1, 1, 1], [2, 2, 2]], { shRest: 0 });
  const sceneDir = makeScene('plain', src);
  const r = runBuildScene(['plain']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!lines(r.stdout, 'progress').some((p) => p.stage === 'transform'));
  const rep = JSON.parse(fs.readFileSync(path.join(sceneDir, 'build', 'build-report.json'), 'utf8'));
  assert.equal(rep.input.bakedFromSource, false);
  const scene = JSON.parse(fs.readFileSync(path.join(sceneDir, 'scene.json'), 'utf8'));
  close(scene.build.bounds.bboxMin, [1, 1, 1], 0);
});

test('build-scene: a failed build keeps the previous build/ and records the attempt', () => {
  const sceneDir = path.join(scenesRoot, 'plain');
  const before = fs.readdirSync(path.join(sceneDir, 'build')).sort();
  const radBefore = fs.readFileSync(path.join(sceneDir, 'build', 'plain-lod.rad'));
  const buildBefore = JSON.parse(fs.readFileSync(path.join(sceneDir, 'scene.json'), 'utf8')).build;
  const r = runBuildScene(['plain'], { FAKE_FAIL_DECODE: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /previous build\/ left unchanged/);
  assert.deepEqual(fs.readdirSync(path.join(sceneDir, 'build')).sort(), before);
  assert.ok(fs.readFileSync(path.join(sceneDir, 'build', 'plain-lod.rad')).equals(radBefore));
  assert.deepEqual(fs.readdirSync(sceneDir).sort(), ['build', 'nav', 'scene.json']);
  const scene = JSON.parse(fs.readFileSync(path.join(sceneDir, 'scene.json'), 'utf8'));
  assert.equal(scene.buildAttempt.status, 'failed');
  assert.match(scene.buildAttempt.error, /decode/);
  assert.deepEqual(scene.build, buildBefore);
  assert.equal(lines(r.stdout, 'result').at(-1).status, 'failed');
});

test('build-scene: missing scene, bad name, missing source, held lock', () => {
  assert.equal(runBuildScene(['nope']).status, 2);
  assert.equal(runBuildScene(['../x']).status, 2);
  makeScene('nosrc', path.join(dir, 'missing.ply'));
  const r = runBuildScene(['nosrc']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /source/);
  const lock = path.join(scenesRoot, '.build.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, scene: 'other', startedAt: 'now' }));
  try {
    const l = runBuildScene(['plain']);
    assert.equal(l.status, 3);
    assert.match(l.stderr, /another scene build is running/);
  } finally {
    fs.rmSync(lock, { force: true });
  }
  assert.ok(readPlyHeader && scanPlyPositions); // readers used by build-scene are importable
});
