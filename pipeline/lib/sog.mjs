// Minimal reader for PlayCanvas SOG bundles (.sog = zip with meta.json + webp).
// Only meta.json is extracted, to report splat count, SH degree and bounds.
// build-lod (Spark v2.3.1, rust/spark-lib/src/sogs.rs) decodes .sog itself;
// this is purely for the pre-build summary.
import fs from 'node:fs';
import zlib from 'node:zlib';

function findEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** Return the uncompressed bytes of the first entry whose name ends with `suffix`. */
export function readZipEntry(filePath, suffix) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 0xffff + 22);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const eocd = findEocd(tail);
    if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record)');
    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff) throw new Error('zip64 .sog archives are not supported by the summary reader');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    let p = 0;
    for (let i = 0; i < entries; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory');
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (!name.endsWith(suffix)) continue;
      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, localOffset);
      const dataStart = localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const data = Buffer.alloc(compSize);
      fs.readSync(fd, data, 0, compSize, dataStart);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`Unsupported zip compression method ${method}`);
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// SOG stores means in log space: v' = sign(v) * ln(|v| + 1).
const unlog = (v) => Math.sign(v) * (Math.exp(Math.abs(v)) - 1);

export function summariseSogMeta(meta) {
  const version = meta.version ?? 1;
  let splatCount = null;
  let shDegree = 0;
  if (version >= 2) {
    splatCount = meta.count ?? null;
    const bands = meta.shN?.bands ?? 0;
    shDegree = Math.min(3, bands);
  } else {
    splatCount = meta.means?.shape?.[0] ?? null;
    const coeffs = meta.shN?.shape?.[1] ?? 0;
    shDegree = coeffs >= 45 ? 3 : coeffs >= 24 ? 2 : coeffs >= 9 ? 1 : 0;
  }
  let bboxMin = null, bboxMax = null, centroid = null;
  if (meta.means?.mins && meta.means?.maxs) {
    bboxMin = meta.means.mins.map(unlog);
    bboxMax = meta.means.maxs.map(unlog);
    centroid = bboxMin.map((v, i) => (v + bboxMax[i]) / 2);
  }
  return {
    format: `sog-v${version}`,
    splatCount,
    shDegree,
    bounds: {
      source: 'sog-meta',
      bboxMin, bboxMax, centroid,
      note: 'Centroid is the bounding-box centre (SOG meta has no per-splat mean).',
    },
  };
}

export function readSogSummary(filePath) {
  const bytes = readZipEntry(filePath, 'meta.json');
  if (!bytes) throw new Error('meta.json not found inside .sog archive');
  return summariseSogMeta(JSON.parse(bytes.toString('utf8')));
}
