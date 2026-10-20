// Numerical match: three.js Object3D TRS (what the viewer's Align mode previews)
// vs. transform.mjs (PlayCanvas splat-transform) output, on a synthetic 3DGS .ply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GS_PROPS, tmpDir } from './fixtures.mjs';
import {
  parseTransformJson, toSplatTransformActions, playcanvasEulerToQuat, quatToPlaycanvasEuler,
} from '../lib/transform.mjs';
import { readPlyHeader } from '../lib/ply.mjs';

const PIPELINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = tmpDir('gsplat-transform-test-');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Deterministic PRNG so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Synthetic splats: asymmetric positions, random unit quaternions, anisotropic scales, non-zero SH (deg 3). */
function makeSplats(n, seed = 7) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const q = new THREE.Quaternion(r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    out.push({
      p: [i * 0.37 - 1.1 + r(), 2.5 * r() - 0.3, -3 * r() + 0.9 * i],
      q: [q.x, q.y, q.z, q.w],
      logScale: [Math.log(0.01 + r() * 0.2), Math.log(0.02 + r() * 0.05), Math.log(0.005 + r() * 0.3)],
      opacity: r() * 4 - 2,
      dc: [r() - 0.5, r() - 0.5, r() - 0.5],
      rest: Array.from({ length: 45 }, () => (r() - 0.5) * 0.8),
    });
  }
  return out;
}

function writePly(file, splats) {
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${splats.length}`,
    ...GS_PROPS.map((p) => `property float ${p}`), 'end_header'].join('\n') + '\n';
  const stride = GS_PROPS.length * 4;
  const body = Buffer.alloc(splats.length * stride);
  const at = (name) => GS_PROPS.indexOf(name) * 4;
  splats.forEach((s, i) => {
    const o = i * stride;
    const w = (name, v) => body.writeFloatLE(v, o + at(name));
    ['x', 'y', 'z'].forEach((k, j) => w(k, s.p[j]));
    s.dc.forEach((v, j) => w(`f_dc_${j}`, v));
    s.rest.forEach((v, j) => w(`f_rest_${j}`, v));
    w('opacity', s.opacity);
    s.logScale.forEach((v, j) => w(`scale_${j}`, v));
    // PLY stores rot_0 = w, rot_1..3 = x, y, z
    w('rot_0', s.q[3]); w('rot_1', s.q[0]); w('rot_2', s.q[1]); w('rot_3', s.q[2]);
  });
  fs.writeFileSync(file, Buffer.concat([Buffer.from(header, 'latin1'), body]));
}

function readPly(file) {
  const h = readPlyHeader(file);
  const v = h.elements.find((e) => e.name === 'vertex');
  const buf = fs.readFileSync(file);
  const get = (i, name) => {
    const p = v.properties.find((pp) => pp.name === name);
    return p ? buf.readFloatLE(h.headerBytes + i * v.stride + p.offset) : undefined;
  };
  return Array.from({ length: h.splatCount }, (_, i) => ({
    p: ['x', 'y', 'z'].map((k) => get(i, k)),
    q: [get(i, 'rot_1'), get(i, 'rot_2'), get(i, 'rot_3'), get(i, 'rot_0')],
    logScale: [0, 1, 2].map((j) => get(i, `scale_${j}`)),
    opacity: get(i, 'opacity'),
    dc: [0, 1, 2].map((j) => get(i, `f_dc_${j}`)),
    rest: Array.from({ length: 45 }, (_, j) => get(i, `f_rest_${j}`)),
  }));
}

// Standard 3DGS SH basis (eval_sh in graphdeco-inria/gaussian-splatting, also what Spark uses).
const C1 = 0.4886025119029199;
const C2 = [1.0925484305920792, -1.0925484305920792, 0.31539156525252005, -1.0925484305920792, 0.5462742152960396];
const C3 = [-0.5900435899266435, 2.890611442640554, -0.4570457994644658, 0.3731763325901154, -0.4570457994644658, 1.445305721320277, -0.5900435899266435];
/** View-dependent part (bands 1-3) of channel c for unit direction d. f_rest is channel-major (15 per channel). */
function evalSH(rest, c, [x, y, z]) {
  const k = (j) => rest[c * 15 + j];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, yz = y * z, xz = x * z;
  let r = -C1 * y * k(0) + C1 * z * k(1) - C1 * x * k(2);
  r += C2[0] * xy * k(3) + C2[1] * yz * k(4) + C2[2] * (2 * zz - xx - yy) * k(5) + C2[3] * xz * k(6) + C2[4] * (xx - yy) * k(7);
  r += C3[0] * y * (3 * xx - yy) * k(8) + C3[1] * xy * z * k(9) + C3[2] * y * (4 * zz - xx - yy) * k(10)
    + C3[3] * z * (2 * zz - 3 * xx - 3 * yy) * k(11) + C3[4] * x * (4 * zz - xx - yy) * k(12)
    + C3[5] * z * (xx - yy) * k(13) + C3[6] * x * (xx - 3 * yy) * k(14);
  return r;
}

/** Transform JSON exactly as the viewer's Align mode writes it (src/align/transformJson.ts). */
function viewerJson(obj, source) {
  obj.updateMatrix();
  const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'XYZ');
  return {
    source,
    position: obj.position.toArray(),
    rotationDeg: [e.x, e.y, e.z].map(THREE.MathUtils.radToDeg),
    eulerOrder: 'XYZ',
    quaternion: obj.quaternion.toArray(),
    scale: obj.scale.x,
    matrix: obj.matrix.toArray(),
    appliedOrder: 'scale, then rotate, then translate, about the world origin (three.js Object3D: M = T * R * S)',
    createdAt: new Date().toISOString(),
    tool: 'viewer-align',
  };
}

function runCli(args) {
  return spawnSync(process.execPath, [path.join(PIPELINE, 'transform.mjs'), ...args], { encoding: 'utf8' });
}

test('PlayCanvas Euler mapping round-trips, including gimbal lock', () => {
  const r = rng(3);
  const cases = [[0.7071067811865476, 0, 0, 0.7071067811865476], [0, 0.7071067811865476, 0, 0.7071067811865476], [0, -0.7071067811865476, 0, 0.7071067811865476]];
  for (let i = 0; i < 200; i++) {
    const q = new THREE.Quaternion(r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    cases.push([q.x, q.y, q.z, q.w]);
  }
  for (const q of cases) {
    const back = playcanvasEulerToQuat(...quatToPlaycanvasEuler(q));
    const dot = Math.abs(back.reduce((a, v, i) => a + v * q[i], 0));
    assert.ok(1 - dot < 1e-12, `round trip failed for ${q}`);
  }
  // PlayCanvas setFromEulerAngles == three.js Euler order 'ZYX'
  const e = [33, -71, 128];
  const tq = new THREE.Quaternion().setFromEuler(new THREE.Euler(...e.map(THREE.MathUtils.degToRad), 'ZYX'));
  const pq = playcanvasEulerToQuat(...e);
  [tq.x, tq.y, tq.z, tq.w].forEach((v, i) => assert.ok(Math.abs(v - pq[i]) < 1e-14));
});

test('parseTransformJson rejects inconsistent or non-uniform input', () => {
  const o = new THREE.Object3D();
  o.position.set(1, 2, 3);
  const j = viewerJson(o, 'x.ply');
  assert.doesNotThrow(() => parseTransformJson(j));
  assert.throws(() => parseTransformJson({ ...j, matrix: j.matrix.map((v, i) => (i === 12 ? v + 1 : v)) }), /disagrees/);
  assert.throws(() => parseTransformJson({ ...j, scale: [1, 2, 1] }), /uniform/);
  assert.throws(() => parseTransformJson({ ...j, quaternion: [0, 0, 0] }), /quaternion/);
  // -90 X in three.js -> +90 X in PlayCanvas engine space (file space is Rz(180) away), translate x/y negated.
  o.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const { args } = toSplatTransformActions(parseTransformJson(viewerJson(o, 'x.ply')));
  assert.deepEqual(args, ['--rotate=90,0,0', '--translate=-1,-2,3']);
});

test('transform.mjs output matches three.js TRS: positions, rotations, scales, SH', (t) => {
  const splats = makeSplats(64);
  const input = path.join(dir, 'synthetic.ply');
  writePly(input, splats);

  // Non-trivial transform: -90 deg about X, then +30 deg about Y (world axes), scale 1.7, translate (2,-1,3).
  const obj = new THREE.Object3D();
  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(-90));
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(30));
  obj.quaternion.copy(qy).multiply(qx);
  obj.scale.setScalar(1.7);
  obj.position.set(2, -1, 3);
  const json = viewerJson(obj, input);
  const jsonPath = path.join(dir, 'synthetic.json');
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));

  const output = path.join(dir, 'synthetic-aligned.ply');
  const res = runCli([input, '--transform', jsonPath, '--out', output]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /verify:\s+ok/);

  const hdr = readPlyHeader(output);
  assert.equal(hdr.shDegree, 3, 'full SH must be kept');
  const got = readPly(output);
  assert.equal(got.length, splats.length);

  const M = obj.matrix;
  const R = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(obj.quaternion));
  const r = rng(11);
  let maxPos = 0, maxQ = 0, maxS = 0, maxSH = 0, maxDC = 0;
  splats.forEach((s, i) => {
    const g = got[i];
    // Positions: p' = M p
    const e = new THREE.Vector3(...s.p).applyMatrix4(M);
    const err = e.distanceTo(new THREE.Vector3(...g.p)) / Math.max(1, e.length());
    maxPos = Math.max(maxPos, err);
    // Rotations: q' = q_M * q (up to sign)
    const eq = obj.quaternion.clone().multiply(new THREE.Quaternion(...s.q));
    const dot = Math.abs(eq.x * g.q[0] + eq.y * g.q[1] + eq.z * g.q[2] + eq.w * g.q[3]) / Math.hypot(...g.q);
    maxQ = Math.max(maxQ, 1 - dot);
    // Scales: exp(log s) * 1.7
    s.logScale.forEach((ls, j) => { maxS = Math.max(maxS, Math.abs(Math.exp(g.logScale[j]) / (Math.exp(ls) * 1.7) - 1)); });
    // Opacity and DC unchanged
    assert.ok(Math.abs(g.opacity - s.opacity) < 1e-6);
    s.dc.forEach((v, j) => { maxDC = Math.max(maxDC, Math.abs(g.dc[j] - v)); });
    // SH: colour seen from direction d in the input == colour seen from R d in the output.
    for (let k = 0; k < 8; k++) {
      const d = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
      const dr = d.clone().applyMatrix3(R);
      for (let c = 0; c < 3; c++) {
        maxSH = Math.max(maxSH, Math.abs(evalSH(s.rest, c, d.toArray()) - evalSH(g.rest, c, dr.toArray())));
      }
    }
    // Band 1 explicitly (3DGS order per channel: k0 ~ -y, k1 ~ z, k2 ~ -x): coefficient vector v = (-k2, -k0, k1) rotates as R v.
    for (let c = 0; c < 3; c++) {
      const v = new THREE.Vector3(-s.rest[c * 15 + 2], -s.rest[c * 15], s.rest[c * 15 + 1]).applyMatrix3(R);
      const gv = new THREE.Vector3(-g.rest[c * 15 + 2], -g.rest[c * 15], g.rest[c * 15 + 1]);
      assert.ok(v.distanceTo(gv) < 1e-5, `band-1 SH not rotated consistently (splat ${i}, ch ${c})`);
    }
  });
  t.diagnostic(`max errors: pos rel ${maxPos.toExponential(2)}, quat 1-|dot| ${maxQ.toExponential(2)}, scale rel ${maxS.toExponential(2)}, SH ${maxSH.toExponential(2)}`);
  assert.ok(maxPos < 1e-6, `positions: max rel error ${maxPos}`);
  assert.ok(maxQ < 1e-6, `rotations: max 1-|dot| ${maxQ}`);
  assert.ok(maxS < 1e-5, `scales: max rel error ${maxS}`);
  assert.ok(maxDC < 1e-6, `DC changed by ${maxDC}`);
  assert.ok(maxSH < 1e-5, `SH radiance: max abs error ${maxSH}`);
});

test('transform.mjs CLI: argument errors, refuses to overwrite, dry run prints command', () => {
  assert.equal(runCli([]).status, 2);
  const input = path.join(dir, 'small.ply');
  writePly(input, makeSplats(4, 99));
  const o = new THREE.Object3D();
  o.rotation.set(-Math.PI / 2, 0, 0);
  const jsonPath = path.join(dir, 'small.json');
  fs.writeFileSync(jsonPath, JSON.stringify(viewerJson(o, input)));
  const dry = runCli([input, '--transform', jsonPath, '--out', path.join(dir, 'never.ply'), '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /--rotate=90,0,0/);
  assert.ok(!fs.existsSync(path.join(dir, 'never.ply')));
  const out = path.join(dir, 'small-out.ply');
  assert.equal(runCli([input, '--transform', jsonPath, '--out', out]).status, 0);
  const again = runCli([input, '--transform', jsonPath, '--out', out]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /--overwrite/);
  assert.equal(runCli([input, '--transform', jsonPath, '--out', out, '--overwrite']).status, 0);
});
