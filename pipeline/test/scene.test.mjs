// Scene save files: shared schema maths (composition, delta preview, multi-part
// load plan, schema 1 -> 2 migration) and build-scene.mjs end to end with the
// stand-in build-lod (real splat-transform): single part, several parts,
// incremental reuse, --part, --force, failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { tmpDir, writeGaussianPly, gridPartition, FAKE_BUILD_LOD } from './fixtures.mjs';
import { parseBuildSceneArgs, makeBuildLodProgress, partReuseCheck, summariseParts } from '../build-scene.mjs';
import { parseNewSceneArgs, expandSources } from '../new-scene.mjs';
import { swapBuildDir, acquireBuildLock, readScene } from '../lib/scene-files.mjs';
import { composeMatrix } from '../lib/transform.mjs';
import { readPlyHeader, scanPlyPositions } from '../lib/ply.mjs';
import {
  createScene, validateScene, composeTransforms, transformFromTRS, transformFromMatrix, deltaMatrix,
  mat4Multiply, mat4Invert, mat4ApplyPoint, matricesEqual, isIdentityMatrix, transformChangedSinceBuild,
  navMayBeMisaligned, previewPlan, loadPlan, migrateScene, partState, buildSummary, partsFromSources, partIdFromSource,
  isSafeSceneRelPath, isSafeSourcePath, decomposeTRS, IDENTITY, SCENE_SCHEMA_VERSION, partCrop, sameCrop, isSafeRoiPath,
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

/** A build record for `scene` where every part was built with `matrix`. */
function fakeBuild(scene, matrix, ids = scene.parts.map((p) => p.id)) {
  return {
    status: 'ok',
    transformMatrix: [...matrix],
    finishedAt: 't',
    buildLodFlags: [],
    parts: ids.map((id) => ({ id, status: 'ok', radFile: `${id}/${scene.name}-${id}-lod.rad`, transformMatrix: [...matrix], source: scene.parts.find((p) => p.id === id).source, buildLodFlags: [] })),
  };
}

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
  scene.build = fakeBuild(scene, built.matrix);
  assert.equal(previewPlan(scene).mode, 'built');
  close(previewPlan(scene).matrix, D);
  assert.equal(previewPlan(scene, { builtAvailable: false }).mode, 'source');
  assert.ok(transformChangedSinceBuild(scene));
  scene.build = fakeBuild(scene, next.matrix);
  assert.ok(!transformChangedSinceBuild(scene));
});

test('load plan: parts under one root, mixed built / outdated / source parts all land on T_new', () => {
  const tOld = transformFromTRS({ position: [1, 2, 3], quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)).toArray(), scale: 2 });
  const tMid = transformFromTRS({ position: [0, 1, 0], quaternion: [0, 0, 0, 1], scale: 3 });
  const tNew = transformFromTRS({ position: [-2, 0.5, 4], quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0.3, 0)).toArray(), scale: 2.5 });
  const scene = createScene({ name: 's', sources: ['a/p0.ply', 'a/p1.ply', 'a/p2.ply', 'a/p3.ply'], transform: tNew });
  assert.deepEqual(scene.parts.map((p) => p.id), ['p0', 'p1', 'p2', 'p3']);
  scene.parts[3].enabled = false;
  // p0 built with the build's transform, p1 carried over from an older build (--part), p2 never built.
  scene.build = fakeBuild(scene, tMid.matrix, ['p0', 'p1']);
  scene.build.parts[1].transformMatrix = [...tOld.matrix];
  const plan = loadPlan(scene, { sourceBytes: { p0: 10, p1: 10, p2: 10, p3: 10 } });
  assert.deepEqual(plan.parts.map((p) => p.mode), ['built', 'built', 'source', 'disabled']);
  assert.deepEqual(plan.parts.map((p) => p.state), ['outdated', 'outdated', 'not-built', 'disabled']);
  close(plan.refMatrix, tMid.matrix);
  const loaded = { p0: tMid.matrix, p1: tOld.matrix, p2: IDENTITY };
  for (const part of plan.parts.slice(0, 3)) {
    const world = mat4Multiply(plan.rootMatrix, part.localMatrix);
    for (const p of [[0, 0, 0], [1, -2, 3]]) {
      close(mat4ApplyPoint(world, mat4ApplyPoint(loaded[part.id], p)), mat4ApplyPoint(tNew.matrix, p), 1e-9);
    }
  }
  assert.ok(isIdentityMatrix(plan.parts[0].localMatrix), 'normal case: child is identity');
  assert.deepEqual(buildSummary(scene), { total: 4, enabled: 3, built: 0, outdated: 2, notBuilt: 1, complete: false });

  // Up to date build: root is identity-delta only through T_new * T_ref^-1, children identity.
  scene.build = fakeBuild(scene, tNew.matrix, ['p0', 'p1', 'p2']);
  const ok = loadPlan(scene);
  assert.ok(ok.parts.slice(0, 3).every((p) => p.mode === 'built' && isIdentityMatrix(p.localMatrix)));
  assert.ok(isIdentityMatrix(ok.rootMatrix, 1e-12));
  assert.ok(!transformChangedSinceBuild(scene));
  assert.equal(partState(scene, scene.parts[0]), 'built');
  assert.ok(buildSummary(scene).complete);
});

test('load plan: unbuilt preview size cap and per-part opt-in', () => {
  const scene = createScene({ name: 's', sources: ['a/p0.ply', 'a/p1.ply', 'a/p2.ply'] });
  const GB = 1024 ** 3;
  const bytes = { p0: 0.9 * GB, p1: 0.9 * GB, p2: 0.4 * GB };
  let plan = loadPlan(scene, { sourceBytes: bytes });
  assert.ok(plan.overCap);
  assert.deepEqual(plan.parts.map((p) => p.mode), ['blocked', 'blocked', 'blocked']);
  plan = loadPlan(scene, { sourceBytes: bytes, previewParts: ['p0', 'p2'] });
  assert.deepEqual(plan.parts.map((p) => p.mode), ['source', 'blocked', 'source']);
  plan = loadPlan(scene, { sourceBytes: bytes, previewParts: ['p0', 'p1'] }); // 1.8 GB > cap: second one blocked
  assert.deepEqual(plan.parts.map((p) => p.mode), ['source', 'blocked', 'blocked']);
  plan = loadPlan(scene, { sourceBytes: bytes, capBytes: 4 * GB });
  assert.deepEqual(plan.parts.map((p) => p.mode), ['source', 'source', 'source']);
  plan = loadPlan(scene, { sourceBytes: { p0: 1, p1: 1 } });
  assert.deepEqual(plan.parts.map((p) => p.mode), ['source', 'source', 'missing']);
  // Built parts don't count against the cap.
  scene.build = fakeBuild(scene, IDENTITY, ['p0', 'p1']);
  plan = loadPlan(scene, { sourceBytes: bytes });
  assert.deepEqual(plan.parts.map((p) => p.mode), ['built', 'built', 'source']);
  // Single-source scenes too.
  const big = createScene({ name: 'b', source: 'a/merged.ply' });
  assert.equal(loadPlan(big, { sourceBytes: { merged: 4.9 * GB } }).parts[0].mode, 'blocked');
});

test('schema 1 -> 2 migration keeps the build and loads the same', () => {
  const v1 = {
    schemaVersion: 1,
    name: 'oculus',
    source: 'assets/source_ply/OculusMerged_1.ply',
    transform: transformFromTRS({ position: [26.3, -3.4, -26.5], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: 50 }),
    floorY: null,
    navigation: {},
    camera: null,
    navTransformMatrix: null,
    buildOptions: {},
    build: {
      status: 'ok', transformMatrix: null, radFile: 'oculus-lod.rad', source: 'assets/source_ply/OculusMerged_1.ply',
      sourceBytes: 697271140, sourceModified: '2026-10-20T09:18:03.536Z', finishedAt: 'f', splatCount: { input: 2811571, final: 3939655 },
      bounds: { bboxMin: [-1, -2, -3], bboxMax: [1, 2, 3] }, buildLodFlags: ['--quality', '--rad-chunked', '--max-sh=1'], chunkCount: 61, totalBytes: 5, peakMemoryBytes: 7,
    },
    buildAttempt: { status: 'ok', startedAt: 's', finishedAt: 'f', error: null },
    hotspots: [],
    migratedFrom: ['assets/transforms/OculusMerged_1.json'],
  };
  v1.build.transformMatrix = [...v1.transform.matrix];
  const frozen = JSON.stringify(v1);
  const { scene, errors, warnings } = validateScene(JSON.parse(frozen));
  assert.deepEqual(errors, []);
  assert.match(warnings.join(), /migrated/);
  assert.equal(scene.schemaVersion, SCENE_SCHEMA_VERSION);
  assert.equal(scene.source, undefined);
  assert.deepEqual(scene.parts, [{ id: 'main', source: 'assets/source_ply/OculusMerged_1.ply', enabled: true }]);
  assert.deepEqual(scene.migratedFrom, v1.migratedFrom, 'unknown keys survive');
  const pb = scene.build.parts[0];
  assert.equal(pb.radFile, 'oculus-lod.rad');
  assert.equal(pb.sourceBytes, 697271140);
  assert.equal(pb.chunkCount, 61);
  close(pb.transformMatrix, v1.transform.matrix, 0);
  assert.equal(scene.build.splatCount.final, 3939655);
  assert.equal(scene.build.radFile, undefined);
  assert.ok(!transformChangedSinceBuild(scene));
  const plan = loadPlan(scene);
  assert.equal(plan.parts[0].mode, 'built');
  assert.equal(plan.parts[0].radFile, 'oculus-lod.rad');
  assert.ok(isIdentityMatrix(plan.rootMatrix, 1e-12));
  assert.equal(JSON.stringify(v1), frozen, 'migration does not mutate its input');
  // Round trip: a migrated scene validates again as schema 2 unchanged.
  assert.deepEqual(validateScene(JSON.parse(JSON.stringify(scene))).scene, scene);
  assert.deepEqual(migrateScene(scene), scene, 'schema 2 passes through');
});

test('schema: validateScene, parts, nav misalignment, path safety', () => {
  const s = createScene({ name: 'lobby_1', source: 'assets/source_ply/a.ply', now: 't' });
  const { scene, errors } = validateScene(JSON.parse(JSON.stringify({ ...s, futureKey: 1 })));
  assert.deepEqual(errors, []);
  assert.equal(scene.futureKey, 1, 'unknown keys survive');
  assert.match(validateScene({ ...s, schemaVersion: 3 }).errors.join(), /schemaVersion/);
  assert.match(validateScene({ ...s, name: '../x' }).errors.join(), /name/);
  assert.match(validateScene({ ...s, navigation: { collision: '../../etc/x.glb' } }).errors.join(), /collision/);
  assert.match(validateScene({ ...s, transform: { ...s.transform, scale: 2 } }).errors.join(), /disagrees/);
  assert.match(validateScene({ ...s, buildOptions: { extraFlags: ['--max-sh=3'] } }).errors.join(), /conflicts/);
  assert.match(validateScene({ ...s, parts: [] }).errors.join(), /parts/);
  assert.match(validateScene({ ...s, parts: [{ id: 'a', source: 'x.ply' }, { id: 'A', source: 'y.ply' }] }).errors.join(), /used twice/);
  assert.match(validateScene({ ...s, parts: [{ id: '../a', source: 'x.ply' }] }).errors.join(), /invalid/);
  assert.match(validateScene({ ...s, build: { transformMatrix: IDENTITY, parts: [{ id: 'a', radFile: '../x.rad', transformMatrix: IDENTITY }] } }).errors.join(), /radFile/);
  assert.equal(validateScene({ ...s, parts: [{ id: 'a', source: 'x.ply' }] }).scene.parts[0].enabled, true, 'enabled defaults to true');
  assert.throws(() => createScene({ name: 'a.b', source: 'x.ply' }), /invalid scene name/);
  assert.throws(() => createScene({ name: 'a', sources: [] }), /at least one/);

  assert.deepEqual(partsFromSources(['d/part0.ply', 'e/part0.ply', 'd/Scan 01.spz']).map((p) => p.id), ['part0', 'part0_2', 'Scan_01']);
  assert.equal(partIdFromSource('C:\\x\\y\\Big Scan.ply'), 'Big_Scan');

  assert.ok(!navMayBeMisaligned(s));
  s.floorY = 0;
  s.navTransformMatrix = [...s.transform.matrix];
  assert.ok(!navMayBeMisaligned(s));
  s.transform = transformFromTRS({ position: [0, 1, 0], quaternion: [0, 0, 0, 1], scale: 1 });
  assert.ok(navMayBeMisaligned(s));

  assert.ok(isSafeSceneRelPath('nav/collision.glb'));
  assert.ok(isSafeSceneRelPath('p0/s-p0-lod.rad'));
  for (const bad of ['../x.glb', '/abs.glb', 'nav/../x', 'C:/x.glb', 'nav\\x.glb', '.hidden/x', '']) assert.ok(!isSafeSceneRelPath(bad), bad);
  assert.ok(isSafeSourcePath('assets/source_ply/OculusMerged_1.ply'));
  assert.ok(isSafeSourcePath('assets/source_ply/parts/OculusV1/part0.ply'));
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
  const b = parseBuildSceneArgs(['a', '--part', 'p1', '--part=p2', '--force']);
  assert.deepEqual(b.errors, []);
  assert.deepEqual(b.opts.parts, ['p1', 'p2']);
  assert.ok(b.opts.force);
  assert.match(parseBuildSceneArgs(['a', '--part', '../x']).errors.join(), /Invalid part id/);
  assert.match(parseBuildSceneArgs(['a', '--part']).errors.join(), /needs a value/);
  const n = parseNewSceneArgs(['x', '--source', 'assets/source_ply/a.ply', '--transform', 'a.json', '--transform=b.json']);
  assert.deepEqual(n.errors, []);
  assert.deepEqual(n.opts.transforms, ['a.json', 'b.json']);
  assert.deepEqual(n.opts.sources, ['assets/source_ply/a.ply']);
  assert.match(parseNewSceneArgs(['x', '--source', '../a.ply']).errors.join(), /--source/);
  assert.match(parseNewSceneArgs(['x']).errors.join(), /Missing --source/);
  assert.deepEqual(parseNewSceneArgs(['x', '--source', 'a/p0.ply', '--source', 'a/p1.ply', '--transform-from', 'oculus']).errors, []);
  assert.match(parseNewSceneArgs(['x', '--source', 'a.ply', '--transform', 'a.json', '--transform-from', 'o']).errors.join(), /either/);
});

test('new-scene: --source accepts files, folders and globs', () => {
  const root = path.join(dir, 'repo');
  const d = path.join(root, 'assets', 'source_ply', 'parts', 'S');
  fs.mkdirSync(d, { recursive: true });
  for (const f of ['part10.ply', 'part2.ply', 'part1.ply', 'notes.txt']) fs.writeFileSync(path.join(d, f), 'x');
  fs.writeFileSync(path.join(root, 'assets', 'source_ply', 'one.ply'), 'x');
  const rel = 'assets/source_ply/parts/S';
  assert.deepEqual(expandSources([rel], root).sources, [`${rel}/part1.ply`, `${rel}/part2.ply`, `${rel}/part10.ply`], 'folder, natural order');
  assert.deepEqual(expandSources([`${rel}/part1*.ply`], root).sources, [`${rel}/part1.ply`, `${rel}/part10.ply`]);
  assert.deepEqual(expandSources(['assets/source_ply/one.ply', `${rel}/part2.ply`, 'assets/source_ply/one.ply'], root).sources, ['assets/source_ply/one.ply', `${rel}/part2.ply`]);
  assert.match(expandSources([`${rel}/*.xyz`], root).errors.join(), /no files match/);
  assert.match(expandSources(['assets/missing.ply'], root).errors.join(), /not found/);
  assert.match(expandSources([`${rel}/notes.txt`], root).errors.join(), /not a usable source/);
});

test('incremental reuse rules', () => {
  const mtime = new Date('2026-01-01T00:00:00Z');
  const prev = { source: 'a.ply', sourceBytes: 10, sourceModified: mtime.toISOString(), transformMatrix: [...IDENTITY], buildLodFlags: ['--x'], sparkTag: 'v1' };
  const now = { matrix: [...IDENTITY], flags: ['--x'], sparkTag: 'v1', stat: { size: 10, mtime } };
  const part = { source: 'a.ply' };
  assert.equal(partReuseCheck(prev, part, now).ok, true);
  assert.match(partReuseCheck(null, part, now).reason, /not built/);
  assert.match(partReuseCheck(prev, { source: 'b.ply' }, now).reason, /source file changed/);
  assert.match(partReuseCheck(prev, part, { ...now, stat: { size: 11, mtime } }).reason, /size/);
  assert.match(partReuseCheck(prev, part, { ...now, stat: { size: 10, mtime: new Date(0) } }).reason, /modified/);
  assert.match(partReuseCheck(prev, part, { ...now, matrix: transformFromTRS({ position: [0, 0, 1e-3], quaternion: [0, 0, 0, 1], scale: 1 }).matrix }).reason, /transform/);
  assert.match(partReuseCheck(prev, part, { ...now, flags: ['--y'] }).reason, /flags/);
  assert.match(partReuseCheck(prev, part, { ...now, sparkTag: 'v2' }).reason, /Spark/);
  assert.match(partReuseCheck(prev, part, { ...now, stat: null }).reason, /missing/);
  const sum = summariseParts([
    { splatCount: { input: 2, final: 3 }, bounds: { bboxMin: [0, 0, 0], bboxMax: [1, 1, 1] }, chunkCount: 2, totalBytes: 10, peakMemoryBytes: 5 },
    { splatCount: { input: 4, final: 5 }, bounds: { bboxMin: [-1, 0.5, 0], bboxMax: [0.5, 2, 1] }, chunkCount: 1, totalBytes: 1, peakMemoryBytes: 9 },
  ]);
  assert.deepEqual(sum, { splatCount: { input: 6, final: 8 }, bounds: { bboxMin: [-1, 0, 0], bboxMax: [1, 2, 1] }, chunkCount: 3, totalBytes: 11, peakMemoryBytes: 9 });
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

function makeScene(name, sources, transform) {
  const d = path.join(scenesRoot, name);
  fs.mkdirSync(path.join(d, 'nav'), { recursive: true });
  // Absolute source paths are allowed for tests (resolved against the repo root otherwise).
  const s = createScene({ name, sources: Array.isArray(sources) ? sources : [sources], transform });
  fs.writeFileSync(path.join(d, 'scene.json'), JSON.stringify(s, null, 2));
  return d;
}

const lines = (out, kind) => out.split(/\r?\n/).filter((l) => l.startsWith(`@${kind} `)).map((l) => JSON.parse(l.slice(kind.length + 2)));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

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
  assert.deepEqual(fs.readdirSync(path.join(sceneDir, 'build')), ['Scan_01']);
  const files = fs.readdirSync(path.join(sceneDir, 'build', 'Scan_01')).sort();
  assert.deepEqual(files, ['build-lod.log', 'build-report.json', 'scn-Scan_01-lod-0.radc', 'scn-Scan_01-lod-1.radc', 'scn-Scan_01-lod.rad']);
  assert.deepEqual(fs.readdirSync(sceneDir).sort(), ['build', 'nav', 'scene.json'], 'no temp dir or temp .ply left');
  assert.deepEqual(fs.readdirSync(srcDir), ['Scan 01.ply']);
  assert.ok(fs.readFileSync(src).equals(srcBytes), 'source unchanged');

  const scene = readJson(path.join(sceneDir, 'scene.json'));
  assert.equal(scene.schemaVersion, 2);
  assert.equal(scene.build.status, 'ok');
  assert.equal(scene.build.parts.length, 1);
  assert.equal(scene.build.parts[0].radFile, 'Scan_01/scn-Scan_01-lod.rad');
  close(scene.build.transformMatrix, t.matrix, 0);
  close(scene.build.parts[0].transformMatrix, t.matrix, 0);
  assert.equal(scene.buildAttempt.status, 'ok');
  assert.equal(scene.build.splatCount.final, 7);
  assert.equal(scene.build.parts[0].sourceBytes, srcBytes.length);
  assert.deepEqual(scene.build.buildLodFlags, ['--quality', '--rad-chunked', '--max-sh=1']);
  // Build bounds = bbox of T applied to the source points (float32 precision).
  const tp = pts.map((p) => mat4ApplyPoint(t.matrix, p));
  close(scene.build.bounds.bboxMin, [0, 1, 2].map((i) => Math.min(...tp.map((p) => p[i]))), 1e-5);
  close(scene.build.bounds.bboxMax, [0, 1, 2].map((i) => Math.max(...tp.map((p) => p[i]))), 1e-5);
  assert.equal(validateScene(scene).errors.length, 0);

  const rep = readJson(path.join(sceneDir, 'build', 'Scan_01', 'build-report.json'));
  assert.equal(rep.input.scene, 'scn');
  assert.equal(rep.input.part, 'Scan_01');
  assert.equal(rep.input.bakedFromSource, true);

  const prog = lines(r.stdout, 'progress');
  assert.ok(prog.some((p) => p.stage === 'transform' && p.part?.id === 'Scan_01'));
  assert.ok(prog.some((p) => p.stage === 'chunks'));
  assert.ok(prog.every((p, i) => i === 0 || p.pct >= prog[i - 1].pct), 'overall progress never goes back');
  assert.equal(prog.at(-1).pct, 100);
  assert.deepEqual(lines(r.stdout, 'part').map((p) => p.status), ['queued', 'building', 'built']);
  assert.equal(lines(r.stdout, 'result').at(-1).status, 'ok');

  // Rebuild with a changed transform: build/ is replaced, not accumulated.
  const s2 = { ...scene, transform: transformFromTRS({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 2 }) };
  fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify(s2, null, 2));
  const r2 = runBuildScene(['scn']);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.deepEqual(fs.readdirSync(path.join(sceneDir, 'build', 'Scan_01')).sort(), files);
  const scene2 = readJson(path.join(sceneDir, 'scene.json'));
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
  const rep = readJson(path.join(sceneDir, 'build', 'plain', 'build-report.json'));
  assert.equal(rep.input.bakedFromSource, false);
  const scene = readJson(path.join(sceneDir, 'scene.json'));
  close(scene.build.bounds.bboxMin, [1, 1, 1], 0);
});

test('build-scene: a failed build keeps the previous build/ and records the attempt', () => {
  const sceneDir = path.join(scenesRoot, 'plain');
  const before = fs.readdirSync(path.join(sceneDir, 'build', 'plain')).sort();
  const radBefore = fs.readFileSync(path.join(sceneDir, 'build', 'plain', 'plain-plain-lod.rad'));
  const buildBefore = readJson(path.join(sceneDir, 'scene.json')).build;
  // Nothing changed, so without --force the build would be skipped.
  const r = runBuildScene(['plain', '--force'], { FAKE_FAIL_DECODE: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /previous build\/ left unchanged/);
  assert.deepEqual(fs.readdirSync(path.join(sceneDir, 'build', 'plain')).sort(), before);
  assert.ok(fs.readFileSync(path.join(sceneDir, 'build', 'plain', 'plain-plain-lod.rad')).equals(radBefore));
  assert.deepEqual(fs.readdirSync(sceneDir).sort(), ['build', 'nav', 'scene.json']);
  const scene = readJson(path.join(sceneDir, 'scene.json'));
  assert.equal(scene.buildAttempt.status, 'failed');
  assert.match(scene.buildAttempt.error, /decode/);
  assert.deepEqual(scene.buildAttempt.parts.map((p) => p.status), ['failed']);
  assert.deepEqual(scene.build, buildBefore);
  assert.equal(lines(r.stdout, 'result').at(-1).status, 'failed');
});

test('build-scene: multi-part scene, sequential builds, incremental reuse, --part, --force, removed parts', () => {
  const srcDir = path.join(dir, 'parts');
  fs.mkdirSync(srcDir, { recursive: true });
  const srcs = [0, 1, 2].map((k) => path.join(srcDir, `part${k}.ply`));
  srcs.forEach((f, k) => writeGaussianPly(f, [[k, 0, 0], [k + 0.5, 1, 0]], { shRest: 0 }));
  const t = transformFromTRS({ position: [0, 0, 1], quaternion: [0, 0, 0, 1], scale: 2 });
  const sceneDir = makeScene('multi', srcs, t);
  const ids = ['part0', 'part1', 'part2'];

  // 1. Full build: every part, one after another.
  const r1 = runBuildScene(['multi']);
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  assert.deepEqual(fs.readdirSync(path.join(sceneDir, 'build')).sort(), ids);
  const parts1 = lines(r1.stdout, 'part');
  assert.deepEqual(parts1.filter((p) => p.status === 'built').map((p) => p.id), ids, 'built in scene order');
  // Sequential: part k+1 starts only after part k finished.
  const order = parts1.filter((p) => p.status === 'building' || p.status === 'built').map((p) => `${p.status}:${p.id}`);
  assert.deepEqual(order, ['building:part0', 'built:part0', 'building:part1', 'built:part1', 'building:part2', 'built:part2']);
  const s1 = readJson(path.join(sceneDir, 'scene.json'));
  assert.equal(s1.build.status, 'ok');
  assert.deepEqual(s1.build.parts.map((p) => p.radFile), ids.map((id) => `${id}/multi-${id}-lod.rad`));
  assert.equal(s1.build.splatCount.final, 21);
  close(s1.build.bounds.bboxMin, [0, 0, 1], 1e-6); // union of the parts' bounds: scale 2, then +1 in z
  close(s1.build.bounds.bboxMax, [5, 2, 1], 1e-6);
  assert.ok(s1.build.parts.every((p) => p.sourceBytes > 0 && p.sourceModified && Array.isArray(p.buildLodFlags)));
  const progress1 = lines(r1.stdout, 'progress');
  assert.ok(progress1.every((p, i) => i === 0 || p.pct >= progress1[i - 1].pct));
  assert.deepEqual([...new Set(progress1.filter((p) => p.part).map((p) => `${p.part.index + 1}/${p.part.count}`))], ['1/3', '2/3', '3/3']);

  // 2. Nothing changed: every part skipped, build/ untouched, quickly.
  const radStat = fs.statSync(path.join(sceneDir, 'build', 'part1', 'multi-part1-lod.rad'));
  const r2 = runBuildScene(['multi']);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /up to date/);
  assert.deepEqual(lines(r2.stdout, 'part').map((p) => p.status), ['reused', 'reused', 'reused']);
  assert.equal(fs.statSync(path.join(sceneDir, 'build', 'part1', 'multi-part1-lod.rad')).ino, radStat.ino);
  const s2 = readJson(path.join(sceneDir, 'scene.json'));
  assert.deepEqual(s2.build, s1.build);
  assert.ok(s2.buildAttempt.upToDate);

  // 3. One source changed: only that part is rebuilt, the others are carried over.
  writeGaussianPly(srcs[1], [[1, 0, 0], [1.5, 1, 0], [1.2, 0.3, 0]], { shRest: 0 });
  const r3 = runBuildScene(['multi']);
  assert.equal(r3.status, 0, r3.stdout + r3.stderr);
  assert.deepEqual(lines(r3.stdout, 'part').filter((p) => ['built', 'reused'].includes(p.status)).map((p) => `${p.status}:${p.id}`), ['reused:part0', 'built:part1', 'reused:part2']);
  const s3 = readJson(path.join(sceneDir, 'scene.json'));
  assert.equal(s3.build.parts[0].finishedAt, s1.build.parts[0].finishedAt);
  assert.ok(s3.build.parts[0].reusedFrom);
  assert.notEqual(s3.build.parts[1].finishedAt, s1.build.parts[1].finishedAt);
  assert.deepEqual(fs.readdirSync(path.join(sceneDir, 'build', 'part0')).sort(), fs.readdirSync(path.join(sceneDir, 'build', 'part2')).sort().map((f) => f.replace('part2', 'part0')));

  // 4. --part with a changed transform: only that part rebuilt; the others kept (outdated) -> partial.
  const s4in = { ...s3, transform: transformFromTRS({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }) };
  fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify(s4in, null, 2));
  const r4 = runBuildScene(['multi', '--part', 'part2']);
  assert.equal(r4.status, 0, r4.stdout + r4.stderr);
  assert.deepEqual(lines(r4.stdout, 'part').filter((p) => ['built', 'kept'].includes(p.status)).map((p) => `${p.status}:${p.id}`), ['kept:part0', 'kept:part1', 'built:part2']);
  const s4 = readJson(path.join(sceneDir, 'scene.json'));
  assert.equal(s4.build.status, 'partial');
  close(s4.build.parts[2].transformMatrix, IDENTITY, 0);
  close(s4.build.parts[0].transformMatrix, t.matrix, 0);
  const sc4 = readScene(path.join(sceneDir, 'scene.json'));
  assert.deepEqual(sc4.parts.map((p) => partState(sc4, p)), ['outdated', 'outdated', 'built']);
  assert.match(runBuildScene(['multi', '--part', 'nope']).stderr, /no part "nope"/);

  // 5. The rest catches up incrementally; then --force rebuilds everything.
  const r5 = runBuildScene(['multi']);
  assert.equal(r5.status, 0, r5.stdout + r5.stderr);
  assert.deepEqual(lines(r5.stdout, 'part').filter((p) => ['built', 'reused'].includes(p.status)).map((p) => `${p.status}:${p.id}`), ['built:part0', 'built:part1', 'reused:part2']);
  assert.equal(readJson(path.join(sceneDir, 'scene.json')).build.status, 'ok');
  const r6 = runBuildScene(['multi', '--force']);
  assert.equal(r6.status, 0, r6.stdout + r6.stderr);
  assert.equal(lines(r6.stdout, 'part').filter((p) => p.status === 'built').length, 3);

  // 6. A failure in part 2 of 3 keeps the whole previous build (part 1's new output is discarded).
  const good = readJson(path.join(sceneDir, 'scene.json')).build;
  const fail = runBuildScene(['multi', '--force'], { FAKE_FAIL_DECODE: '1', FAKE_FAIL_MATCH: 'multi-part1' });
  assert.equal(fail.status, 1);
  assert.deepEqual(lines(fail.stdout, 'part').filter((p) => ['built', 'failed'].includes(p.status)).map((p) => `${p.status}:${p.id}`), ['built:part0', 'failed:part1']);
  const attempt = readJson(path.join(sceneDir, 'scene.json')).buildAttempt;
  assert.deepEqual(attempt.parts.map((p) => p.status), ['built', 'failed', 'not-run']);
  assert.deepEqual(readJson(path.join(sceneDir, 'scene.json')).build, good);
  assert.deepEqual(fs.readdirSync(path.join(sceneDir, 'build')).sort(), ids);
  assert.deepEqual(fs.readdirSync(sceneDir).sort(), ['build', 'nav', 'scene.json']);

  // 7. Disabled parts are not built but kept; removed parts disappear from build/.
  const s7 = readJson(path.join(sceneDir, 'scene.json'));
  s7.parts[0].enabled = false;
  s7.parts = s7.parts.filter((p) => p.id !== 'part2');
  fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify(s7, null, 2));
  const r7 = runBuildScene(['multi']);
  assert.equal(r7.status, 0, r7.stdout + r7.stderr);
  assert.deepEqual(fs.readdirSync(path.join(sceneDir, 'build')).sort(), ['part0', 'part1']);
  assert.deepEqual(readJson(path.join(sceneDir, 'scene.json')).build.parts.map((p) => p.id), ['part0', 'part1']);
});

test('build-scene: a schema-1 scene with a flat build/ is reused as part "main"', () => {
  const src = path.join(dir, 'src', 'legacy.ply');
  writeGaussianPly(src, [[0, 0, 0], [1, 1, 1]], { shRest: 0 });
  const sceneDir = path.join(scenesRoot, 'legacy');
  fs.mkdirSync(path.join(sceneDir, 'build'), { recursive: true });
  const st = fs.statSync(src);
  for (const f of ['legacy-lod.rad', 'legacy-lod-0.radc', 'build-report.json', 'build-lod.log']) fs.writeFileSync(path.join(sceneDir, 'build', f), f);
  const v1 = {
    schemaVersion: 1, name: 'legacy', source: src, transform: transformFromTRS({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }),
    floorY: null, navigation: {}, camera: null, navTransformMatrix: null, buildOptions: {}, hotspots: [],
    build: {
      status: 'ok', transformMatrix: [...IDENTITY], radFile: 'legacy-lod.rad', source: src, sourceBytes: st.size, sourceModified: st.mtime.toISOString(),
      finishedAt: 'f', buildLodFlags: ['--quality', '--rad-chunked', '--max-sh=1'], sparkTag: 'v2.3.1', chunkCount: 1, splatCount: { input: 2, final: 3 },
    },
    buildAttempt: null,
  };
  fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify(v1, null, 2));
  // Up to date as migrated: nothing rebuilt; scene.json gets the v2 layout only when written.
  const r = runBuildScene(['legacy']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(lines(r.stdout, 'part').map((p) => p.status), ['reused']);
  assert.deepEqual(fs.readdirSync(path.join(sceneDir, 'build')).sort(), ['build-lod.log', 'build-report.json', 'legacy-lod-0.radc', 'legacy-lod.rad'], 'flat build untouched');
  const after = readJson(path.join(sceneDir, 'scene.json'));
  assert.equal(after.schemaVersion, 2);
  assert.equal(after.build.parts[0].radFile, 'legacy-lod.rad');
  // A forced rebuild moves it into build/main/.
  const r2 = runBuildScene(['legacy', '--force']);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.deepEqual(fs.readdirSync(path.join(sceneDir, 'build')), ['main']);
  assert.equal(readJson(path.join(sceneDir, 'scene.json')).build.parts[0].radFile, 'main/legacy-main-lod.rad');
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
    const l = runBuildScene(['plain', '--force']);
    assert.equal(l.status, 3);
    assert.match(l.stderr, /another scene build is running/);
  } finally {
    fs.rmSync(lock, { force: true });
  }
  assert.ok(readPlyHeader && scanPlyPositions); // readers used by build-scene are importable
});

test('schema: partition crop fields, part state and reuse', () => {
  const s = createScene({ name: 'pc', sources: ['a/p0.ply', 'a/p1.ply'], now: 't' });
  assert.equal(partCrop(s, s.parts[0]), null, 'no partition: no crop');
  s.parts[0].partitionPart = 2;
  assert.equal(partCrop(s, s.parts[0]), null, 'a partitionPart alone does nothing');
  assert.match(validateScene(JSON.parse(JSON.stringify(s))).warnings.join(), /no "partition"/);
  s.partition = 'assets/partitions/X/partition.json';
  assert.deepEqual(partCrop(s, s.parts[0]), { partition: s.partition, part: 2 });
  assert.equal(partCrop(s, s.parts[1]), null);
  const v = validateScene(JSON.parse(JSON.stringify({ ...s, parts: [{ ...s.parts[0] }, { ...s.parts[1], partitionPart: null }] })));
  assert.deepEqual(v.errors, []);
  assert.equal(v.scene.partition, s.partition);
  assert.equal(v.scene.parts[0].partitionPart, 2);
  assert.ok(!('partitionPart' in v.scene.parts[1]), 'null partitionPart dropped');
  assert.match(validateScene({ ...s, partition: 'x.bin' }).errors.join(), /partition/);
  assert.match(validateScene({ ...s, parts: [{ ...s.parts[0], partitionPart: 1.5 }] }).errors.join(), /partitionPart/);
  assert.match(validateScene({ ...s, parts: [{ ...s.parts[0], partitionPart: 255 }] }).errors.join(), /partitionPart/);

  assert.ok(sameCrop(null, null));
  assert.ok(!sameCrop(null, { partition: 'a', part: 0 }));
  assert.ok(sameCrop({ partition: 'a', part: 0, keptSplats: 5 }, { partition: 'a', part: 0 }));
  assert.ok(!sameCrop({ partition: 'a', part: 0 }, { partition: 'a', part: 1 }));

  // A build without the crop is outdated once the part should be cropped, and vice versa.
  s.build = fakeBuild(s, s.transform.matrix);
  assert.deepEqual(s.parts.map((p) => partState(s, p)), ['outdated', 'built']);
  s.build.parts[0].crop = { partition: s.partition, part: 2, keptSplats: 9 };
  assert.deepEqual(s.parts.map((p) => partState(s, p)), ['built', 'built']);
  s.build.parts[1].crop = { partition: s.partition, part: 0 };
  assert.equal(partState(s, s.parts[1]), 'outdated');

  const mtime = new Date('2026-01-01T00:00:00Z');
  const now = { matrix: [...IDENTITY], flags: [], stat: { size: 10, mtime } };
  const prev = { source: 'a.ply', sourceBytes: 10, sourceModified: mtime.toISOString(), transformMatrix: [...IDENTITY], buildLodFlags: [] };
  const crop = { partition: 'p.json', part: 1, partitionBytes: 100 };
  assert.ok(partReuseCheck(prev, { source: 'a.ply' }, now).ok);
  assert.match(partReuseCheck(prev, { source: 'a.ply' }, { ...now, crop }).reason, /crop added/);
  assert.match(partReuseCheck({ ...prev, crop }, { source: 'a.ply' }, now).reason, /crop removed/);
  assert.match(partReuseCheck({ ...prev, crop }, { source: 'a.ply' }, { ...now, crop: { ...crop, part: 2 } }).reason, /crop changed/);
  assert.match(partReuseCheck({ ...prev, crop }, { source: 'a.ply' }, { ...now, crop: { ...crop, partitionBytes: 101 } }).reason, /partition file changed/);
  assert.ok(partReuseCheck({ ...prev, crop: { ...crop, keptSplats: 3 } }, { source: 'a.ply' }, { ...now, crop }).ok);

  // Region of interest: part of the crop key; the region's digest decides reuse.
  const r = { roi: 'assets/roi/s/region6.json', roiDigest: 'aaa' };
  assert.deepEqual(partCrop({ parts: [] }, { id: 'p', roi: r.roi }), { roi: r.roi });
  assert.deepEqual(partCrop(s, { ...s.parts[0], roi: r.roi }), { partition: s.partition, part: 2, roi: r.roi }, 'both crops');
  assert.ok(!sameCrop({ roi: 'a.json' }, { roi: 'b.json' }));
  assert.deepEqual(partCrop({ parts: [] }, { id: 'p', roi: r.roi, roiOutlines: ['Outline 2'] }), { roi: r.roi, roiOutlines: ['Outline 2'] });
  assert.equal(partCrop({ parts: [] }, { id: 'p', roiOutlines: ['Outline 2'] }), null, 'outlines without a region file do nothing');
  assert.ok(!sameCrop({ roi: 'a.json', roiOutlines: ['Outline 1'] }, { roi: 'a.json', roiOutlines: ['Outline 2'] }));
  assert.ok(!sameCrop({ roi: 'a.json', roiOutlines: ['Outline 1'] }, { roi: 'a.json' }));
  assert.ok(sameCrop({ roi: 'a.json', roiOutlines: ['Outline 2', 'Outline 1'] }, { roi: 'a.json', roiOutlines: ['Outline 1', 'Outline 2'] }), 'order does not matter');
  assert.ok(sameCrop({ roi: 'a.json', roiOutline: 'Outline 1' }, { roi: 'a.json', roiOutlines: ['Outline 1'] }), 'older single-outline records still match');
  assert.match(validateScene({ ...s, parts: [{ ...s.parts[0], roiOutline: 3 }] }).errors.join(), /roiOutline/);
  assert.match(validateScene({ ...s, parts: [{ ...s.parts[0], roiOutlines: 'Outline 1' }] }).errors.join(), /roiOutlines/);
  assert.deepEqual(validateScene({ ...s, parts: [{ ...s.parts[0], roiOutline: 'Outline 1' }] }).scene.parts[0].roiOutlines, ['Outline 1'], 'roiOutline read as a list');
  assert.deepEqual(validateScene({ ...s, parts: [{ ...s.parts[0], roiOutlines: ['Outline 10', 'Outline 2', 'Outline 2'] }] }).scene.parts[0].roiOutlines, ['Outline 2', 'Outline 10'], 'sorted, unique');

  // The scene's region file: parts pick outlines in it; a part's own roi overrides it.
  const sr = { ...createScene({ name: 'sr', sources: ['a/p0.ply', 'a/p1.ply', 'a/p2.ply'], now: 't' }), roi: 'assets/roi/sr/six.json' };
  sr.parts[0].roiOutlines = ['Outline 1', 'Outline 2'];
  sr.parts[2].roi = 'assets/roi/sr/other.json';
  assert.deepEqual(partCrop(sr, sr.parts[0]), { roi: sr.roi, roiOutlines: ['Outline 1', 'Outline 2'] });
  assert.equal(partCrop(sr, sr.parts[1]), null, 'no outlines picked: not cropped');
  assert.deepEqual(partCrop(sr, sr.parts[2]), { roi: 'assets/roi/sr/other.json' }, 'own file, top-level region');
  assert.deepEqual(validateScene(JSON.parse(JSON.stringify(sr))).errors, []);
  assert.match(validateScene({ ...sr, roi: 'x.ply' }).errors.join(), /"roi"/);
  assert.match(validateScene({ ...sr, roi: null }).warnings.join(), /roiOutlines but neither/);
  assert.ok(isSafeRoiPath('assets/roi/sr/Oculus6Part.json'));
  for (const bad of ['assets/roi/sr/../x.json', 'assets/roi/x.json', 'assets/source_ply/sr/x.json', 'assets/roi/sr/x.ply', 'assets/roi/a.b/x.json', 'C:/assets/roi/sr/x.json']) assert.ok(!isSafeRoiPath(bad), bad);
  assert.ok(!sameCrop({ partition: 'p', part: 0 }, { partition: 'p', part: 0, roi: 'a.json' }));
  assert.match(partReuseCheck(prev, { source: 'a.ply' }, { ...now, crop: r }).reason, /crop added/);
  assert.ok(partReuseCheck({ ...prev, crop: r }, { source: 'a.ply' }, { ...now, crop: r }).ok);
  assert.match(partReuseCheck({ ...prev, crop: r }, { source: 'a.ply' }, { ...now, crop: { ...r, roiDigest: 'bbb' } }).reason, /ROI region changed/);
  assert.match(validateScene({ ...s, parts: [{ ...s.parts[0], roi: 'x.ply' }] }).errors.join(), /roi/);
  assert.ok(!('roi' in validateScene({ ...s, parts: [{ ...s.parts[0], roi: null }] }).scene.parts[0]));
});

test('build-scene: ROI crop keeps only the splats inside the region, alone and with a partition', () => {
  const json = gridPartition(path.join(dir, 'partition-roi'));
  const srcDir = path.join(dir, 'roi');
  fs.mkdirSync(srcDir, { recursive: true });
  // Box x -2.5..0.5, y 0..2, z 0..2 (a quad prism like Spirula's).
  const roiFile = path.join(srcDir, 'region6.json');
  const writeRegion = (halfHeight) => fs.writeFileSync(roiFile, JSON.stringify({
    type: 'prism', center: [-1, 1, 1], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], half_height: halfHeight,
    polygon: [-1.5, -1, 1.5, -1, 1.5, 1, -1.5, 1], editor: { version: 1, shapes: [] },
  }));
  writeRegion(1);
  const a = [[-2, 1, 1], [-0.5, 1, 1], [0.2, 0.5, 0.5], [2, 1, 1], [-2, 1, 2.5]]; // 3 inside the box (parts 0, 1, 1), 2 outside
  const b = [[-1.8, 0.4, 0.3], [0.4, 1.9, 1.9], [2.5, 1, 1]]; // 2 inside
  writeGaussianPly(path.join(srcDir, 'roi_a.ply'), a, { shRest: 0 });
  writeGaussianPly(path.join(srcDir, 'roi_b.ply'), b, { shRest: 0 });
  const sceneDir = makeScene('roiscn', [path.join(srcDir, 'roi_a.ply'), path.join(srcDir, 'roi_b.ply')]);
  const file = path.join(sceneDir, 'scene.json');
  const edit = (fn) => { const s = readJson(file); fn(s); fs.writeFileSync(file, JSON.stringify(s, null, 2)); };
  edit((s) => { for (const p of s.parts) p.roi = roiFile; });

  const r = runBuildScene(['roiscn']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /crop to ROI region6\.json/);
  const s1 = readJson(file);
  assert.deepEqual(s1.build.parts.map((p) => [p.crop.keptSplats, p.crop.droppedSplats, p.crop.droppedOutsideRoi]), [[3, 2, 2], [2, 1, 1]]);
  assert.ok(s1.build.parts.every((p) => p.crop.roi === roiFile && /^[0-9a-f]{16}$/.test(p.crop.roiDigest) && !('droppedOutsidePart' in p.crop)));
  close(s1.build.parts[0].bounds.bboxMin, [-2, 0.5, 0.5], 1e-6);
  close(s1.build.parts[0].bounds.bboxMax, [0.2, 1, 1], 1e-6);
  assert.deepEqual(fs.readdirSync(sceneDir).sort(), ['build', 'nav', 'scene.json'], 'no temp files left');

  // Same region with other editor outlines: reused. A changed region: rebuilt.
  assert.match(runBuildScene(['roiscn']).stdout, /up to date/);
  writeRegion(0.6); // z 0.4..1.6: drops a's (0.2, 0.5, 0.5) and b's (-1.8, 0.4, 0.3) and (0.4, 1.9, 1.9)
  const r2 = runBuildScene(['roiscn', '--part', 'roi_a']);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /--part \(ROI region changed\)/);
  const r3 = runBuildScene(['roiscn']);
  assert.equal(r3.status, 1, 'roi_b has nothing left inside');
  assert.match(r3.stdout + r3.stderr, /no splat of roi_b\.ply is kept: none lies in ROI region6\.json/);

  // ROI and partition together: a splat must be in the part's partition region AND inside the ROI.
  writeRegion(1);
  edit((s) => { s.partition = json; s.parts[0].partitionPart = 1; s.parts[1].enabled = false; });
  const r4 = runBuildScene(['roiscn']);
  assert.equal(r4.status, 0, r4.stdout + r4.stderr);
  assert.match(r4.stdout, /crop to partition part 1 and ROI region6\.json/);
  const c = readJson(file).build.parts.find((p) => p.id === 'roi_a').crop;
  assert.deepEqual([c.part, c.keptSplats, c.droppedOutsidePart, c.droppedOutsideRoi], [1, 2, 1, 2]);

  // The scene's region file + outline pairs per part (the editor's Regions): union of the picked outlines.
  const six = path.join(srcDir, 'six.json');
  const outline = (name, x0) => ({ name, kind: 'prism', op: 'add', enabled: false, origin: [x0, 1, 0], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], lo: [0, 0, 0], hi: [0, 0, 2], polygon: [0, -1, 1, -1, 1, 1, 0, 1] });
  fs.writeFileSync(six, JSON.stringify({
    type: 'union', children: [{ type: 'prism', center: [2, 1, 1], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], half_height: 1, polygon: [0, -1, 1, -1, 1, 1, 0, 1] }],
    editor: { version: 1, shapes: [outline('Outline 1', -3), outline('Outline 2', -2), outline('Outline 3', -1), outline('Outline 4', 0)] },
  }));
  edit((s) => {
    delete s.partition;
    s.roi = six;
    s.parts[0] = { ...s.parts[0], roiOutlines: ['Outline 2', 'Outline 1'] }; // x -3..-1
    delete s.parts[0].roi;
    delete s.parts[0].partitionPart;
    s.parts[1] = { ...s.parts[1], enabled: true, roiOutlines: ['Outline 3', 'Outline 4'] }; // x -1..1
    delete s.parts[1].roi;
  });
  const r5 = runBuildScene(['roiscn']);
  assert.equal(r5.status, 0, r5.stdout + r5.stderr);
  assert.match(r5.stdout, /crop to ROI six\.json "Outline 1" \+ "Outline 2"/);
  const s5 = readJson(file);
  assert.deepEqual(s5.parts.map((p) => p.roiOutlines), [['Outline 1', 'Outline 2'], ['Outline 3', 'Outline 4']], 'stored sorted');
  // a: (-2,1,1) and (-2,1,2.5 above) -> 1 kept; b: (-1.8,..) is in outlines 1-2 (dropped), (0.4,1.9,1.9) kept, (2.5,..) dropped.
  assert.deepEqual(s5.build.parts.map((p) => [p.crop.roi, p.crop.roiOutlines, p.crop.keptSplats]), [[six, ['Outline 1', 'Outline 2'], 1], [six, ['Outline 3', 'Outline 4'], 1]]);
  assert.match(runBuildScene(['roiscn']).stdout, /up to date/);
  edit((s) => { s.parts[1].roiOutlines = ['Outline 4']; });
  const r6 = runBuildScene(['roiscn']);
  assert.deepEqual(lines(r6.stdout, 'part').filter((p) => ['built', 'reused'].includes(p.status)).map((p) => `${p.status}:${p.id}`), ['reused:roi_a', 'built:roi_b']);
  edit((s) => { s.parts[1].roiOutlines = ['Outline 9']; });
  const missing = runBuildScene(['roiscn']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no outline named "Outline 9"/);
  edit((s) => { delete s.roi; for (const p of s.parts) { delete p.roiOutlines; p.roi = roiFile; } });

  // A broken region file is refused before anything runs.
  fs.writeFileSync(roiFile, JSON.stringify({ type: 'sphere' }));
  const bad = runBuildScene(['roiscn', '--force']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /roi: region6\.json: region type "sphere" is not supported/);
});

test('build-scene: partition crop drops each part\'s splats outside its own region, before the transform', () => {
  const json = gridPartition(path.join(dir, 'partition-oc'));
  const srcDir = path.join(dir, 'oc');
  fs.mkdirSync(srcDir, { recursive: true });
  // Part exports trained for partition parts 0 and 2, each with a few low-detail
  // splats in the other regions (x < -1: part 0, -1..1: part 1, > 1: part 2).
  const a = [[-2, 1, 1], [-1.6, 0.5, 0.5], [-2.5, 1.5, 0.2], [0.2, 1, 1], [2.4, 1, 1]];
  const b = [[2, 1, 1], [1.5, 0.4, 1.6], [-2.2, 1, 1]];
  writeGaussianPly(path.join(srcDir, 'oc_a.ply'), a, { shRest: 0 });
  writeGaussianPly(path.join(srcDir, 'oc_b.ply'), b, { shRest: 0 });
  const t = transformFromTRS({ position: [0, 0, 1], quaternion: [0, 0, 0, 1], scale: 2 });
  const sceneDir = makeScene('oc', [path.join(srcDir, 'oc_a.ply'), path.join(srcDir, 'oc_b.ply')], t);
  const file = path.join(sceneDir, 'scene.json');
  const edit = (fn) => { const s = readJson(file); fn(s); fs.writeFileSync(file, JSON.stringify(s, null, 2)); };
  edit((s) => { s.partition = json; s.parts[0].partitionPart = 0; s.parts[1].partitionPart = 2; });

  const dry = runBuildScene(['oc', '--dry-run']);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /crop .*oc_a\.ply to partition part 0/);
  assert.match(dry.stdout, /transform\.mjs _cropped-oc_a\.ply/);

  const r = runBuildScene(['oc']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(fs.readdirSync(sceneDir).sort(), ['build', 'nav', 'scene.json'], 'no temp files left');
  const s1 = readJson(file);
  assert.equal(s1.build.status, 'ok');
  const binBytes = fs.statSync(path.join(dir, 'partition-oc', 'partition.bin')).size;
  assert.deepEqual(s1.build.parts.map((p) => ({ part: p.crop.part, kept: p.crop.keptSplats, dropped: p.crop.droppedSplats, bytes: p.crop.partitionBytes })), [
    { part: 0, kept: 3, dropped: 2, bytes: binBytes },
    { part: 2, kept: 2, dropped: 1, bytes: binBytes },
  ]);
  // Bounds are of the cropped, then transformed, splats: only part 0's region for oc_a.
  const own = a.slice(0, 3).map((p) => mat4ApplyPoint(t.matrix, p));
  close(s1.build.parts[0].bounds.bboxMin, [0, 1, 2].map((i) => Math.min(...own.map((p) => p[i]))), 1e-5);
  close(s1.build.parts[0].bounds.bboxMax, [0, 1, 2].map((i) => Math.max(...own.map((p) => p[i]))), 1e-5);
  const rep = readJson(path.join(sceneDir, 'build', 'oc_a', 'build-report.json'));
  assert.equal(rep.input.partitionCrop.part, 0);
  const prog = lines(r.stdout, 'progress');
  assert.ok(prog.some((p) => p.stage === 'crop' && p.part?.id === 'oc_b'));
  assert.ok(prog.every((p, i) => i === 0 || p.pct >= prog[i - 1].pct), 'overall progress never goes back');
  assert.deepEqual(s1.parts.map((p) => partState(s1, p)), ['built', 'built']);

  // Unchanged: reused. Another partitionPart for one part: only that part is rebuilt.
  assert.match(runBuildScene(['oc']).stdout, /up to date/);
  edit((s) => { s.parts[1].partitionPart = 0; });
  const r2 = runBuildScene(['oc']);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.deepEqual(lines(r2.stdout, 'part').filter((p) => ['built', 'reused'].includes(p.status)).map((p) => `${p.status}:${p.id}`), ['reused:oc_a', 'built:oc_b']);
  assert.deepEqual([readJson(file).build.parts[1].crop.keptSplats, readJson(file).build.parts[1].crop.droppedSplats], [1, 2]);

  // A part number the partition does not have is refused before anything runs.
  edit((s) => { s.parts[1].partitionPart = 7; });
  const bad = runBuildScene(['oc']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /partitionPart 7 does not exist/);

  // Partition removed: every part rebuilt uncropped.
  edit((s) => { delete s.partition; s.parts[1].partitionPart = 2; });
  const r3 = runBuildScene(['oc']);
  assert.equal(r3.status, 0, r3.stdout + r3.stderr);
  const s3 = readJson(file);
  assert.deepEqual(s3.build.parts.map((p) => p.crop), [null, null]);
  close(s3.build.parts[0].bounds.bboxMax, mat4ApplyPoint(t.matrix, [2.4, 1.5, 1]), 1e-5);
});

test('build-scene: buildOptions.maxSh sets build-lod --max-sh and rebuilds when it changes', () => {
  const src = path.join(dir, 'sh', 'sh.ply');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  writeGaussianPly(src, [[0, 0, 0], [1, 1, 1]]);
  const sceneDir = makeScene('shscn', src);
  const file = path.join(sceneDir, 'scene.json');
  const r1 = runBuildScene(['shscn']);
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  assert.deepEqual(readJson(file).build.buildLodFlags, ['--quality', '--rad-chunked', '--max-sh=1']);
  assert.match(r1.stdout + r1.stderr, /--max-sh=1 drops degrees 2-3/);
  const s = readJson(file);
  s.buildOptions = { maxSh: 3 };
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  const r2 = runBuildScene(['shscn']);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /build-lod flags changed/);
  assert.match(r2.stdout, /Using --max-sh=3/);
  assert.doesNotMatch(r2.stdout + r2.stderr, /drops degrees/);
  assert.deepEqual(readJson(file).build.parts[0].buildLodFlags.slice(0, 3), ['--quality', '--rad-chunked', '--max-sh=3']);
  assert.match(validateScene({ ...s, buildOptions: { maxSh: 4 } }).errors.join(), /maxSh/);
  assert.match(validateScene({ ...s, buildOptions: { extraFlags: ['--max-sh=3'] } }).errors.join(), /buildOptions.maxSh/);
});
