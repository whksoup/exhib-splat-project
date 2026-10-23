// Synthetic test inputs, always written to a temp dir outside the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export function tmpDir(prefix = 'gsplat-pipeline-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Standard 3DGS training output layout (62 float32 = 248 bytes/splat, SH degree 3).
export const GS_PROPS = [
  'x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2',
  ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`),
  'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
];

/** Write a binary little-endian 3DGS .ply with the given centres. */
export function writeGaussianPly(file, points, { shRest = 45, crlf = false, truncateBy = 0 } = {}) {
  const props = GS_PROPS.filter((p) => !p.startsWith('f_rest_') || Number(p.slice(7)) < shRest);
  const nl = crlf ? '\r\n' : '\n';
  const header = ['ply', 'format binary_little_endian 1.0', 'comment synthetic test',
    `element vertex ${points.length}`, ...props.map((p) => `property float ${p}`), 'end_header'].join(nl) + nl;
  const stride = props.length * 4;
  const body = Buffer.alloc(points.length * stride);
  points.forEach(([x, y, z], i) => {
    const o = i * stride;
    body.writeFloatLE(x, o); body.writeFloatLE(y, o + 4); body.writeFloatLE(z, o + 8);
    body.writeFloatLE(1, o + props.indexOf('rot_0') * 4);
    body.writeFloatLE(2, o + props.indexOf('opacity') * 4);
  });
  fs.writeFileSync(file, Buffer.concat([Buffer.from(header, 'latin1'), body.subarray(0, body.length - truncateBy)]));
  return { stride, headerBytes: Buffer.byteLength(header, 'latin1') };
}

/**
 * Write a synthetic Spirula partition (partition.json + partition.bin, same
 * layout as the real files) with the given labelled points. Returns the json path.
 */
export function writePartition(folder, points, labels, numParts, { magic = 'SSPT', nodes = 3, extra = {} } = {}) {
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

/** Partition points on a 0.1 grid over x -3..3, y/z 0..2, labelled by thirds of x (<-1, <1, else). */
export function gridPartition(folder) {
  const pts = [];
  for (let x = -2.95; x < 3; x += 0.1) for (let y = 0.05; y < 2; y += 0.1) for (let z = 0.05; z < 2; z += 0.1) pts.push([x, y, z]);
  const labels = pts.map((p) => (p[0] < -1 ? 0 : p[0] < 1 ? 1 : 2));
  return writePartition(folder, pts, labels, 3);
}

export function writeAsciiPly(file, points) {
  const lines = ['ply', 'format ascii 1.0', `element vertex ${points.length}`,
    'property float x', 'property float y', 'property float z', 'property float opacity', 'end_header',
    ...points.map((p) => `${p.join(' ')} 0.5`)];
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

/** PlayCanvas-style compressed .ply: chunk table with bounds + packed vertices. */
export function writeCompressedPly(file, chunks, splatCount) {
  const chunkProps = ['min_x', 'min_y', 'min_z', 'max_x', 'max_y', 'max_z',
    'min_scale_x', 'min_scale_y', 'min_scale_z', 'max_scale_x', 'max_scale_y', 'max_scale_z'];
  const header = ['ply', 'format binary_little_endian 1.0',
    `element chunk ${chunks.length}`, ...chunkProps.map((p) => `property float ${p}`),
    `element vertex ${splatCount}`, 'property uint packed_position', 'property uint packed_rotation',
    'property uint packed_scale', 'property uint packed_color',
    `element sh ${splatCount}`, ...Array.from({ length: 9 }, (_, i) => `property uchar f_rest_${i}`),
    'end_header'].join('\n') + '\n';
  const cbuf = Buffer.alloc(chunks.length * chunkProps.length * 4);
  chunks.forEach(([lo, hi], i) => {
    [...lo, ...hi].forEach((v, j) => cbuf.writeFloatLE(v, (i * chunkProps.length + j) * 4));
  });
  const vbuf = Buffer.alloc(splatCount * 16);
  const sbuf = Buffer.alloc(splatCount * 9);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(header, 'latin1'), cbuf, vbuf, sbuf]));
}

/** Minimal zip writer (stored or deflated entries) for building fake .sog files. */
export function writeZip(file, entries, { deflate = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const comp = deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  const n = Object.keys(entries).length;
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(n, 8); eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, eocd]));
}

/**
 * Stand-in for build-lod used by the end-to-end test: mimics its CLI contract
 * (writes <stem>-lod.rad + <stem>-lod-N.radc next to the input, prints the
 * "Comment: {json}" stats block, exits 0 even on decode failure).
 */
export const FAKE_BUILD_LOD = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const input = args.filter((a) => !a.startsWith('--')).pop();
for (const a of args.filter((a) => a.startsWith('--'))) console.log('Using ' + a);
if (process.env.FAKE_FAIL_DECODE && (!process.env.FAKE_FAIL_MATCH || input.includes(process.env.FAKE_FAIL_MATCH))) { console.error('Decoding failed: "bad file"'); process.exit(0); }
const stem = input.slice(0, input.lastIndexOf('.')) + '-lod';
const buf = Buffer.alloc(50 * 1024 * 1024, 1); // touch some memory
console.log('Read: num_splats: 4 with sh_degree: 3');
console.log('Comment: ' + JSON.stringify({ input_splat_count: 4, final_splat_count: 7, lod_duration: 0.01, args, sum: buf[0] }, null, 2));
fs.writeFileSync(stem + '.rad', 'RADHEADER');
for (let i = 0; i < 2; i++) { fs.writeFileSync(stem + '-' + i + '.radc', 'CHUNK' + i); console.log('Wrote ' + path.basename(stem) + '-' + i + '.radc'); }
console.log('Wrote ' + stem + '.rad');
// Stay alive long enough for the memory sampler (PowerShell start-up is ~1 s).
setTimeout(() => { buf[1] = 2; }, Number(process.env.FAKE_LINGER_MS || 0));
`;
