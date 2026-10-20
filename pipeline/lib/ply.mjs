// Streaming .ply header + position reader.
//
// Reads only the header into memory, then streams the vertex block in fixed
// size buffers to compute bounding box and centroid, so a 12 GB / 50M splat
// file never has to fit in RAM.
//
// Supports:
//   - binary_little_endian / binary_big_endian with fixed-size properties
//     (standard 3DGS training output, ~248 bytes/splat with SH degree 3)
//   - ascii
//   - PlayCanvas "compressed .ply" (element `chunk` with min_x..max_z bounds):
//     bounds come from the chunk table, no full scan is needed.
import fs from 'node:fs';
import readline from 'node:readline';

const TYPE_SIZES = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

const MAX_HEADER_BYTES = 1 << 20; // 1 MiB is far beyond any real splat header

/** Read and parse the header only. */
export function readPlyHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    let buf = Buffer.alloc(0);
    const chunk = Buffer.alloc(64 * 1024);
    let end = -1;
    let pos = 0;
    while (end < 0) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n === 0) break;
      pos += n;
      buf = Buffer.concat([buf, chunk.subarray(0, n)]);
      end = findHeaderEnd(buf);
      if (buf.length > MAX_HEADER_BYTES) break;
    }
    if (end < 0) throw new Error(`Not a valid .ply file (no end_header found in first ${buf.length} bytes): ${filePath}`);
    return parseHeaderText(buf.subarray(0, end).toString('latin1'), end);
  } finally {
    fs.closeSync(fd);
  }
}

function findHeaderEnd(buf) {
  const marker = 'end_header';
  const idx = buf.indexOf(marker, 0, 'latin1');
  if (idx < 0) return -1;
  let p = idx + marker.length;
  // Tolerate \r\n line endings.
  if (buf[p] === 0x0d) p++;
  if (p >= buf.length) return -1;
  if (buf[p] !== 0x0a) throw new Error('Malformed .ply header: end_header not followed by newline');
  return p + 1;
}

export function parseHeaderText(text, headerBytes) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== 'ply') throw new Error('Not a .ply file (missing "ply" magic)');
  let format = null;
  const elements = [];
  const comments = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case 'format':
        format = parts[1];
        break;
      case 'comment':
      case 'obj_info':
        comments.push(line.slice(parts[0].length + 1));
        break;
      case 'element':
        elements.push({ name: parts[1], count: Number(parts[2]), properties: [] });
        break;
      case 'property': {
        const el = elements[elements.length - 1];
        if (!el) throw new Error('property before any element in .ply header');
        if (parts[1] === 'list') {
          el.properties.push({ name: parts[4], type: 'list', countType: parts[2], itemType: parts[3] });
        } else {
          if (!(parts[1] in TYPE_SIZES)) throw new Error(`Unknown .ply property type: ${parts[1]}`);
          el.properties.push({ name: parts[2], type: parts[1] });
        }
        break;
      }
      case 'end_header':
        break;
      default:
        // ignore unknown header lines
        break;
    }
  }
  if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(format)) {
    throw new Error(`Unsupported .ply format: ${format}`);
  }
  for (const el of elements) {
    let offset = 0;
    el.fixedSize = el.properties.every((p) => p.type !== 'list');
    for (const p of el.properties) {
      if (p.type === 'list') continue;
      p.offset = offset;
      offset += TYPE_SIZES[p.type];
    }
    el.stride = el.fixedSize ? offset : null;
  }
  const vertex = elements.find((e) => e.name === 'vertex');
  if (!vertex) throw new Error('.ply has no "vertex" element');

  const allProps = elements.flatMap((e) => e.properties.map((p) => p.name));
  const fRest = allProps.filter((n) => /^f_rest_\d+$/.test(n)).length;
  // (degree+1)^2 - 1 coefficients per colour channel are stored in f_rest_*.
  const shDegree = fRest === 0 ? 0 : Math.round(Math.sqrt(fRest / 3 + 1)) - 1;
  const chunkEl = elements.find((e) => e.name === 'chunk');
  const isCompressed = !!chunkEl && vertex.properties.some((p) => p.name === 'packed_position');

  return {
    format,
    headerBytes,
    elements,
    comments,
    splatCount: vertex.count,
    shDegree,
    fRestCount: fRest,
    isCompressed,
    bytesPerSplat: vertex.stride,
  };
}

function makeReader(type, littleEndian) {
  switch (type) {
    case 'float': case 'float32': return (dv, o) => dv.getFloat32(o, littleEndian);
    case 'double': case 'float64': return (dv, o) => dv.getFloat64(o, littleEndian);
    case 'char': case 'int8': return (dv, o) => dv.getInt8(o);
    case 'uchar': case 'uint8': return (dv, o) => dv.getUint8(o);
    case 'short': case 'int16': return (dv, o) => dv.getInt16(o, littleEndian);
    case 'ushort': case 'uint16': return (dv, o) => dv.getUint16(o, littleEndian);
    case 'int': case 'int32': return (dv, o) => dv.getInt32(o, littleEndian);
    case 'uint': case 'uint32': return (dv, o) => dv.getUint32(o, littleEndian);
    default: throw new Error(`Unsupported type ${type}`);
  }
}

function newStats() {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    sum: [0, 0, 0],
    count: 0,
    nonFinite: 0,
  };
}

function addPoint(s, x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    s.nonFinite++;
    return;
  }
  s.count++;
  s.sum[0] += x; s.sum[1] += y; s.sum[2] += z;
  if (x < s.min[0]) s.min[0] = x; if (x > s.max[0]) s.max[0] = x;
  if (y < s.min[1]) s.min[1] = y; if (y > s.max[1]) s.max[1] = y;
  if (z < s.min[2]) s.min[2] = z; if (z > s.max[2]) s.max[2] = z;
}

function finishStats(s, source) {
  const centroid = s.count ? s.sum.map((v) => v / s.count) : null;
  return {
    source,
    bboxMin: s.count ? s.min : null,
    bboxMax: s.count ? s.max : null,
    centroid,
    scannedSplats: s.count,
    nonFiniteSplats: s.nonFinite,
  };
}

/**
 * Compute bounds/centroid of splat centres.
 * @param {string} filePath
 * @param {object} header result of readPlyHeader
 * @param {{bufferBytes?: number, onProgress?: (fraction:number)=>void}} opts
 */
export async function scanPlyPositions(filePath, header, opts = {}) {
  const vertex = header.elements.find((e) => e.name === 'vertex');
  if (header.format === 'ascii') return scanAscii(filePath, header, vertex);

  const littleEndian = header.format === 'binary_little_endian';
  // Byte offset of each element block (binary, fixed-size elements only).
  let offset = header.headerBytes;
  const blockOffset = {};
  for (const el of header.elements) {
    blockOffset[el.name] = offset;
    if (!el.fixedSize) {
      if (el === vertex || header.elements.indexOf(el) < header.elements.indexOf(vertex)) {
        throw new Error(`Element "${el.name}" has list properties; cannot stream positions`);
      }
      break;
    }
    offset += el.count * el.stride;
  }

  if (header.isCompressed) {
    // PlayCanvas compressed .ply: per-chunk (256 splat) bounds give the bbox;
    // the centroid is approximated from chunk-centre weighted by chunk size.
    const chunkEl = header.elements.find((e) => e.name === 'chunk');
    const props = Object.fromEntries(chunkEl.properties.map((p) => [p.name, p]));
    for (const k of ['min_x', 'min_y', 'min_z', 'max_x', 'max_y', 'max_z']) {
      if (!props[k]) throw new Error(`Compressed .ply chunk element missing ${k}`);
    }
    const bytes = chunkEl.count * chunkEl.stride;
    const buf = Buffer.alloc(bytes);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, buf, 0, bytes, blockOffset.chunk); } finally { fs.closeSync(fd); }
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const rd = (name, i) => makeReader(props[name].type, littleEndian)(dv, i * chunkEl.stride + props[name].offset);
    const s = newStats();
    for (let i = 0; i < chunkEl.count; i++) {
      const lo = [rd('min_x', i), rd('min_y', i), rd('min_z', i)];
      const hi = [rd('max_x', i), rd('max_y', i), rd('max_z', i)];
      addPoint(s, lo[0], lo[1], lo[2]);
      addPoint(s, hi[0], hi[1], hi[2]);
    }
    const r = finishStats(s, 'compressed-ply-chunk-bounds');
    r.scannedSplats = 0;
    r.note = 'Centroid approximated from chunk bounds (PlayCanvas compressed .ply).';
    return r;
  }

  const props = Object.fromEntries(vertex.properties.map((p) => [p.name, p]));
  for (const k of ['x', 'y', 'z']) if (!props[k]) throw new Error(`.ply vertex element missing "${k}"`);
  const rx = makeReader(props.x.type, littleEndian);
  const ry = makeReader(props.y.type, littleEndian);
  const rz = makeReader(props.z.type, littleEndian);
  const ox = props.x.offset, oy = props.y.offset, oz = props.z.offset;
  const stride = vertex.stride;

  const recordsPerRead = Math.max(1, Math.floor((opts.bufferBytes || 32 * 1024 * 1024) / stride));
  const buf = Buffer.alloc(recordsPerRead * stride);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const fileSize = fs.statSync(filePath).size;
  const expectedEnd = blockOffset.vertex + vertex.count * stride;
  if (expectedEnd > fileSize) {
    throw new Error(`.ply truncated: header declares ${vertex.count} splats (${expectedEnd} bytes) but file is ${fileSize} bytes`);
  }

  const s = newStats();
  const fh = await fs.promises.open(filePath, 'r');
  try {
    let done = 0;
    let lastReport = 0;
    while (done < vertex.count) {
      const want = Math.min(recordsPerRead, vertex.count - done);
      const { bytesRead } = await fh.read(buf, 0, want * stride, blockOffset.vertex + done * stride);
      const got = Math.floor(bytesRead / stride);
      if (got === 0) throw new Error(`Unexpected EOF after ${done} splats`);
      for (let i = 0; i < got; i++) {
        const b = i * stride;
        addPoint(s, rx(dv, b + ox), ry(dv, b + oy), rz(dv, b + oz));
      }
      done += got;
      if (opts.onProgress && done - lastReport >= vertex.count / 20) {
        lastReport = done;
        opts.onProgress(done / vertex.count);
      }
    }
  } finally {
    await fh.close();
  }
  return finishStats(s, 'full-scan');
}

async function scanAscii(filePath, header, vertex) {
  if (header.elements[0] !== vertex) {
    throw new Error('ASCII .ply with elements before "vertex" is not supported by the scanner');
  }
  const idx = ['x', 'y', 'z'].map((k) => vertex.properties.findIndex((p) => p.name === k));
  if (idx.some((i) => i < 0)) throw new Error('.ply vertex element missing x/y/z');
  const s = newStats();
  const stream = fs.createReadStream(filePath, { start: header.headerBytes, encoding: 'latin1' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (n >= vertex.count) break;
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    addPoint(s, Number(parts[idx[0]]), Number(parts[idx[1]]), Number(parts[idx[2]]));
    n++;
  }
  rl.close();
  stream.destroy();
  if (n < vertex.count) throw new Error(`ASCII .ply truncated: ${n} of ${vertex.count} vertices`);
  return finishStats(s, 'full-scan');
}
