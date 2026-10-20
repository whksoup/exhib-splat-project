import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readPlyHeader, scanPlyPositions } from '../lib/ply.mjs';
import { readSogSummary } from '../lib/sog.mjs';
import { tmpDir, writeGaussianPly, writeAsciiPly, writeCompressedPly, writeZip } from './fixtures.mjs';

const dir = tmpDir();
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const PTS = [[1, 2, 3], [-4, 5, 0.5], [10, -6, 2], [0, 0, -8.5], [3, 3, 3]];
const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-5, `${a} vs ${b}`));

test('binary 3DGS .ply header: count, SH degree, stride', () => {
  const f = path.join(dir, 'gs.ply');
  const { headerBytes } = writeGaussianPly(f, PTS);
  const h = readPlyHeader(f);
  assert.equal(h.format, 'binary_little_endian');
  assert.equal(h.splatCount, 5);
  assert.equal(h.shDegree, 3);
  assert.equal(h.bytesPerSplat, 248);
  assert.equal(h.headerBytes, headerBytes);
  assert.equal(h.isCompressed, false);
});

test('SH degree derived from f_rest count (0, 1, 2)', () => {
  for (const [rest, deg] of [[0, 0], [9, 1], [24, 2]]) {
    const f = path.join(dir, `sh${rest}.ply`);
    writeGaussianPly(f, PTS, { shRest: rest });
    assert.equal(readPlyHeader(f).shDegree, deg);
  }
});

test('streaming scan gives exact bbox and centroid, across buffer boundaries', async () => {
  const f = path.join(dir, 'scan.ply');
  writeGaussianPly(f, PTS, { crlf: true });
  const h = readPlyHeader(f);
  // 2 records per read forces several reads and a partial final read.
  const b = await scanPlyPositions(f, h, { bufferBytes: 248 * 2 });
  near(b.bboxMin, [-4, -6, -8.5]);
  near(b.bboxMax, [10, 5, 3]);
  near(b.centroid, [2, 0.8, -0]);
  assert.equal(b.scannedSplats, 5);
  assert.equal(b.nonFiniteSplats, 0);
});

test('larger synthetic file (200k splats) scans with bounded buffer', async () => {
  const f = path.join(dir, 'big.ply');
  const n = 200_000;
  const pts = Array.from({ length: n }, (_, i) => [1000 + (i % 100), -(i % 7), i / n]);
  writeGaussianPly(f, pts, { shRest: 9 });
  const h = readPlyHeader(f);
  const b = await scanPlyPositions(f, h, { bufferBytes: 1 << 20 });
  assert.equal(b.scannedSplats, n);
  near(b.bboxMin, [1000, -6, 0]);
  near(b.bboxMax, [1099, 0, (n - 1) / n]);
});

test('non-finite positions are counted, not included in bounds', async () => {
  const f = path.join(dir, 'nan.ply');
  writeGaussianPly(f, [[1, 1, 1], [NaN, 0, 0], [3, 3, 3]]);
  const b = await scanPlyPositions(f, readPlyHeader(f));
  assert.equal(b.nonFiniteSplats, 1);
  near(b.centroid, [2, 2, 2]);
});

test('truncated .ply is rejected', async () => {
  const f = path.join(dir, 'trunc.ply');
  writeGaussianPly(f, PTS, { truncateBy: 10 });
  await assert.rejects(scanPlyPositions(f, readPlyHeader(f)), /truncated/);
});

test('non-ply file is rejected', () => {
  const f = path.join(dir, 'junk.ply');
  fs.writeFileSync(f, 'hello world, not a ply');
  assert.throws(() => readPlyHeader(f), /end_header|ply/);
});

test('ascii .ply', async () => {
  const f = path.join(dir, 'ascii.ply');
  writeAsciiPly(f, PTS);
  const h = readPlyHeader(f);
  assert.equal(h.format, 'ascii');
  const b = await scanPlyPositions(f, h);
  near(b.centroid, [2, 0.8, 0]);
});

test('PlayCanvas compressed .ply uses chunk bounds', async () => {
  const f = path.join(dir, 'scene.compressed.ply');
  writeCompressedPly(f, [[[0, 0, 0], [1, 2, 3]], [[-5, 1, 1], [4, 4, 9]]], 300);
  const h = readPlyHeader(f);
  assert.equal(h.isCompressed, true);
  assert.equal(h.splatCount, 300);
  assert.equal(h.shDegree, 1);
  const b = await scanPlyPositions(f, h);
  near(b.bboxMin, [-5, 0, 0]);
  near(b.bboxMax, [4, 4, 9]);
  assert.equal(b.source, 'compressed-ply-chunk-bounds');
});

test('.sog v2 meta.json summary (deflated and stored zips)', () => {
  const ln = (v) => Math.sign(v) * Math.log(Math.abs(v) + 1);
  const meta = {
    version: 2, count: 123456,
    means: { mins: [-10, -2, 0].map(ln), maxs: [30, 2, 4].map(ln), files: ['means_l.webp', 'means_u.webp'] },
    shN: { bands: 3 },
  };
  for (const deflate of [true, false]) {
    const f = path.join(dir, `m${deflate}.sog`);
    writeZip(f, { 'meta.json': JSON.stringify(meta), 'means_l.webp': 'x' }, { deflate });
    const s = readSogSummary(f);
    assert.equal(s.format, 'sog-v2');
    assert.equal(s.splatCount, 123456);
    assert.equal(s.shDegree, 3);
    near(s.bounds.bboxMin, [-10, -2, 0]);
    near(s.bounds.centroid, [10, 0, 2]);
  }
});

test('.sog without meta.json errors clearly', () => {
  const f = path.join(dir, 'nometa.sog');
  writeZip(f, { 'other.txt': 'x' });
  assert.throws(() => readSogSummary(f), /meta\.json/);
});
