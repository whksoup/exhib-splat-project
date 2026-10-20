// partition-split.mjs: Spirula partition reader (validation of the
// reverse-engineered partition.bin layout), k-d tree nearest point, and the
// streaming split of a merged .ply on synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir, writeGaussianPly, GS_PROPS } from './fixtures.mjs';
import { readPartition, KdTree } from '../lib/partition.mjs';
import { partitionSplit, parseSplitArgs, headerWithCount } from '../partition-split.mjs';
import { readPlyHeader } from '../lib/ply.mjs';

const PIPELINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = tmpDir('gsplat-partition-test-');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Deterministic PRNG. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * Write a synthetic partition (same layout as Spirula's): points labelled by
 * which third of the X range they lie in.
 */
function writePartition(folder, points, labels, numParts, { magic = 'SSPT', nodes = 3, extra = {} } = {}) {
  fs.mkdirSync(folder, { recursive: true });
  const n = points.length;
  const head = Buffer.alloc(32);
  head.write(magic, 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.write('SSLF', 8, 'latin1');
  head.writeUInt32LE(1, 12);
  head.writeBigUInt64LE(BigInt(n), 16);
  head.writeUInt32LE(nodes, 24);
  const pts = Buffer.alloc(n * 16);
  points.forEach(([x, y, z], i) => {
    pts.writeFloatLE(x, i * 16);
    pts.writeFloatLE(y, i * 16 + 4);
    pts.writeFloatLE(z, i * 16 + 8);
    pts[i * 16 + 12] = labels[i];
    pts[i * 16 + 13] = 200; // the 3 unknown bytes (colour?)
  });
  const tree = Buffer.alloc(nodes * 32);
  const tail = Buffer.alloc(16);
  tail.writeBigUInt64LE(5n, 0);
  fs.writeFileSync(path.join(folder, 'partition.bin'), Buffer.concat([head, pts, tree, tail]));
  const json = {
    format: 'spirula-scene-partition', version: 1, num_parts: numParts, num_frames: 0, num_points: n,
    options: { method: 'viewgraph', parts: numParts }, binary: 'partition.bin', frame_names: [], frame_parts: [],
    parts: Array.from({ length: numParts }, () => ({ core: 0, points: 0, ring: [] })), ...extra,
  };
  fs.writeFileSync(path.join(folder, 'partition.json'), JSON.stringify(json));
  return path.join(folder, 'partition.json');
}

const labelOfX = (x) => (x < -1 ? 0 : x < 1 ? 1 : 2);

/** Partition points on a 0.1 grid over x -3..3, y/z 0..2 (or `n` random points), labelled by labelOfX. */
function syntheticPartition(folder, n = 0, seed = 1) {
  const pts = [];
  if (n > 0) {
    const r = rng(seed);
    for (let i = 0; i < n; i++) pts.push([r() * 6 - 3, r() * 2, r() * 2]);
  } else {
    for (let x = -2.95; x < 3; x += 0.1) for (let y = 0.05; y < 2; y += 0.1) for (let z = 0.05; z < 2; z += 0.1) pts.push([x, y, z]);
  }
  const labels = pts.map((p) => labelOfX(p[0]));
  return { json: writePartition(folder, pts, labels, 3), pts, labels };
}

test('readPartition: reads the layout and refuses anything unexpected', () => {
  const { json, labels } = syntheticPartition(path.join(dir, 'p-ok'), 3000);
  const p = readPartition(json);
  assert.equal(p.count, 3000);
  assert.equal(p.numParts, 3);
  assert.deepEqual(p.labelCounts, [0, 1, 2].map((k) => labels.filter((l) => l === k).length));
  assert.ok(p.bbox.min[0] >= -3 && p.bbox.max[0] <= 3);

  const bad = (name, mutate, re) => {
    const f = path.join(dir, name);
    syntheticPartition(f, 50);
    mutate(f);
    assert.throws(() => readPartition(path.join(f, 'partition.json')), re, name);
  };
  bad('p-magic', (f) => { const b = fs.readFileSync(path.join(f, 'partition.bin')); b.write('XXXX', 0, 'latin1'); fs.writeFileSync(path.join(f, 'partition.bin'), b); }, /bad magic/);
  bad('p-version', (f) => { const b = fs.readFileSync(path.join(f, 'partition.bin')); b.writeUInt32LE(3, 4); fs.writeFileSync(path.join(f, 'partition.bin'), b); }, /version 3/);
  bad('p-short', (f) => { const b = fs.readFileSync(path.join(f, 'partition.bin')); fs.writeFileSync(path.join(f, 'partition.bin'), b.subarray(0, 32 + 49 * 16)); }, /bytes/);
  bad('p-label', (f) => { const b = fs.readFileSync(path.join(f, 'partition.bin')); b[32 + 12] = 7; fs.writeFileSync(path.join(f, 'partition.bin'), b); }, /label 7/);
  bad('p-format', (f) => { const j = JSON.parse(fs.readFileSync(path.join(f, 'partition.json'))); j.format = 'other'; fs.writeFileSync(path.join(f, 'partition.json'), JSON.stringify(j)); }, /format/);
  bad('p-escape', (f) => { const j = JSON.parse(fs.readFileSync(path.join(f, 'partition.json'))); j.binary = '../partition.bin'; fs.writeFileSync(path.join(f, 'partition.json'), JSON.stringify(j)); }, /plain file name/);
  bad('p-nobin', (f) => fs.rmSync(path.join(f, 'partition.bin')), /not found/);
});

test('KdTree: nearest point equals brute force', () => {
  const r = rng(7);
  const n = 5000;
  const pos = new Float32Array(n * 3);
  const lab = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = r() * 10; pos[i * 3 + 1] = r() * 0.1; pos[i * 3 + 2] = r() * 3; // flat, like a scanned floor
    lab[i] = i % 5;
  }
  // duplicates and collinear points must not break the build
  pos.set([1, 0, 1, 1, 0, 1, 1, 0, 1], 0);
  const tree = new KdTree(pos, lab);
  for (let q = 0; q < 500; q++) {
    const x = r() * 14 - 2, y = r() * 2 - 1, z = r() * 5 - 1;
    let best = Infinity;
    let bestLab = -1;
    for (let i = 0; i < n; i++) {
      const d = (x - pos[i * 3]) ** 2 + (y - pos[i * 3 + 1]) ** 2 + (z - pos[i * 3 + 2]) ** 2;
      if (d < best) { best = d; bestLab = lab[i]; }
    }
    const k = tree.nearest(x, y, z);
    assert.ok(Math.abs(tree.bestD - best) < 1e-9, `query ${q}: ${tree.bestD} vs ${best}`);
    assert.ok(tree.lab[k] === bestLab || Math.abs(tree.bestD - best) < 1e-12, 'label of the nearest point');
  }
});

test('headerWithCount replaces only the vertex count', () => {
  const h = 'ply\nformat binary_little_endian 1.0\ncomment element vertex 5\nelement vertex 123\nproperty float x\nend_header\n';
  assert.equal(headerWithCount(h, 7), h.replace('element vertex 123', 'element vertex 7'));
  assert.equal(headerWithCount(h.replace(/\n/g, '\r\n'), 7), h.replace(/\n/g, '\r\n').replace('element vertex 123', 'element vertex 7'));
  assert.throws(() => headerWithCount('ply\nend_header\n', 1), /exactly one/);
});

test('partition-split: streams a merged .ply into per-part files', async () => {
  const { json } = syntheticPartition(path.join(dir, 'split-part'));
  // Merged file like Spirula's: part 0 block, then part 1, then part 2, with a
  // little ring overlap at the end of blocks 0 and 1 (splats in the next part's
  // region) and 5 strays from part 0's region at the start of block 2.
  const r = rng(3);
  const pts = [];
  const expect = [];
  const ranges = [[-3, -1], [-1, 1], [1, 3]];
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < 400; i++) {
      let region = k;
      if (i >= 390 && k < 2) region = k + 1;
      if (k === 2 && i < 5) region = 0;
      const [lo, hi] = ranges[region];
      const x = lo + 0.3 + r() * (hi - lo - 0.6); // well inside its region: the nearest grid point is unambiguous
      pts.push([x, 0.1 + r() * 1.8, 0.1 + r() * 1.8]);
      expect.push(region);
    }
  }
  pts.push([NaN, 0, 0]); // no position: stays with its file-order neighbour (part 2)
  expect.push(2);
  const merged = path.join(dir, 'merged.ply');
  const { stride } = writeGaussianPly(merged, pts, { crlf: true });
  // Tag every record so we can check the bytes travel unchanged.
  const buf = fs.readFileSync(merged);
  const hb = readPlyHeader(merged).headerBytes;
  for (let i = 0; i < pts.length; i++) buf.writeFloatLE(i, hb + i * stride + GS_PROPS.indexOf('f_rest_44') * 4);
  fs.writeFileSync(merged, buf);

  const out = path.join(dir, 'split-out');
  const rep = await partitionSplit({ input: merged, partition: json, outDir: out, log: () => {}, onProgress: () => {}, readBytes: 1000 * stride });
  const counts = [0, 1, 2].map((k) => expect.filter((l) => l === k).length);
  assert.deepEqual(rep.parts.map((p) => p.splats), counts);
  assert.equal(rep.sumOfParts, pts.length);
  assert.equal(rep.nonFiniteSplats, 1);
  // counts 395/400/406: the 5 strays shift every block boundary by 5 -> 5 disagreements per block.
  assert.deepEqual(counts, [395, 400, 406]);
  assert.equal(rep.fileOrder.disagreeingSplats, 15);
  assert.ok(rep.nearestPointDistance.p99 < 0.1);
  assert.deepEqual(fs.readdirSync(out).sort(), ['part0.ply', 'part1.ply', 'part2.ply']);

  const inHeader = buf.subarray(0, hb).toString('latin1');
  const seen = new Set();
  for (let k = 0; k < 3; k++) {
    const f = path.join(out, `part${k}.ply`);
    const h = readPlyHeader(f);
    assert.equal(h.splatCount, counts[k]);
    const text = fs.readFileSync(f).subarray(0, h.headerBytes).toString('latin1');
    assert.equal(text, inHeader.replace(/element vertex \d+/, `element vertex ${counts[k]}`), 'header identical except the count');
    const body = fs.readFileSync(f).subarray(h.headerBytes);
    assert.equal(body.length, counts[k] * stride);
    let prevTag = -1;
    for (let i = 0; i < counts[k]; i++) {
      const tag = body.readFloatLE(i * stride + GS_PROPS.indexOf('f_rest_44') * 4);
      assert.ok(tag > prevTag, 'file order kept');
      prevTag = tag;
      seen.add(tag);
      const src = buf.subarray(hb + tag * stride, hb + (tag + 1) * stride);
      assert.ok(body.subarray(i * stride, (i + 1) * stride).equals(src), 'record bytes unchanged');
      assert.equal(expect[tag], k, `splat ${tag} in part ${k}`);
    }
  }
  assert.equal(seen.size, pts.length, 'every splat written exactly once');

  // Refuses to overwrite; --overwrite works; CLI end to end.
  await assert.rejects(partitionSplit({ input: merged, partition: json, outDir: out, log: () => {}, onProgress: () => {} }), /exists/);
  const cli = spawnSync(process.execPath, [path.join(PIPELINE, 'partition-split.mjs'), merged, '--partition', json, '--out-dir', out, '--overwrite', '--prefix', 'p'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /all accounted for/);
  assert.ok(fs.existsSync(path.join(out, 'p2.ply')));
  assert.ok(fs.existsSync(path.join(out, 'p-split-report.json')));
  assert.ok(!fs.readdirSync(out).some((f) => f.endsWith('.tmp')));
});

test('partition-split: argument parsing and unsupported inputs', async () => {
  assert.deepEqual(parseSplitArgs(['a.ply', '--partition', 'p.json', '--out-dir', 'o']).errors, []);
  assert.match(parseSplitArgs(['a.ply']).errors.join(), /--partition/);
  assert.match(parseSplitArgs(['a.ply', '--partition', 'p.json', '--out-dir', 'o', '--prefix', '../x']).errors.join(), /prefix/);
  const { json } = syntheticPartition(path.join(dir, 'split-bad'), 100);
  const ascii = path.join(dir, 'ascii.ply');
  fs.writeFileSync(ascii, 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n');
  await assert.rejects(partitionSplit({ input: ascii, partition: json, outDir: path.join(dir, 'o1'), log: () => {} }), /binary_little_endian/);
  const trunc = path.join(dir, 'trunc.ply');
  writeGaussianPly(trunc, [[0, 0, 0], [1, 1, 1]], { truncateBy: 10 });
  await assert.rejects(partitionSplit({ input: trunc, partition: json, outDir: path.join(dir, 'o2'), log: () => {} }), /truncated/);
});
