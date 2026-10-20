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
import { tmpDir, writeGaussianPly, FAKE_BUILD_LOD } from './fixtures.mjs';
import { parseBuildSceneArgs, makeBuildLodProgress, partReuseCheck, summariseParts } from '../build-scene.mjs';
import { parseNewSceneArgs, expandSources } from '../new-scene.mjs';
import { swapBuildDir, acquireBuildLock, readScene } from '../lib/scene-files.mjs';
import { composeMatrix } from '../lib/transform.mjs';
import { readPlyHeader, scanPlyPositions } from '../lib/ply.mjs';
import {
  createScene, validateScene, composeTransforms, transformFromTRS, transformFromMatrix, deltaMatrix,
  mat4Multiply, mat4Invert, mat4ApplyPoint, matricesEqual, isIdentityMatrix, transformChangedSinceBuild,
  navMayBeMisaligned, previewPlan, loadPlan, migrateScene, partState, buildSummary, partsFromSources, partIdFromSource,
  isSafeSceneRelPath, isSafeSourcePath, decomposeTRS, IDENTITY, SCENE_SCHEMA_VERSION,
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
