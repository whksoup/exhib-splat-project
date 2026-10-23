// Record-level splitting and cropping of a binary splat .ply, streamed so a
// multi-GB file never has to fit in RAM. Two passes over the file:
//   pass 1  read positions in 32 MB blocks, give every splat a label (1 byte each)
//   pass 2  read again, append each record to the writer of its label (8 MB write buffers)
// Every output has the input's header byte for byte except the vertex count;
// records are copied unchanged (all properties, all SH bands), in file order.
// Outputs are written as <name>.tmp and renamed when complete.
// Used by partition-split.mjs (split by partition part) and build-scene.mjs
// (crop a part to its partition part and/or its region of interest).
import fs from 'node:fs';
import path from 'node:path';

import { readPlyHeader } from './ply.mjs';

/** Header text with the vertex count replaced (exactly one `element vertex N` line). */
export function headerWithCount(headerText, count) {
  const re = /^element vertex \d+(?=\r?\n)/m;
  const matches = headerText.match(/^element vertex \d+\r?$/gm);
  if (!matches || matches.length !== 1) throw new Error('.ply header must contain exactly one "element vertex <n>" line');
  return headerText.replace(re, `element vertex ${count}`);
}

export class PartWriter {
  constructor(file, header, recordBytes, bufferBytes = 8 * 1024 * 1024) {
    this.file = file;
    this.tmp = `${file}.tmp`;
    this.fd = fs.openSync(this.tmp, 'w');
    this.headerLength = header.length;
    fs.writeSync(this.fd, header, 0, header.length, 0);
    this.pos = header.length;
    this.buf = Buffer.alloc(Math.max(recordBytes, Math.floor(bufferBytes / recordBytes) * recordBytes));
    this.used = 0;
    this.count = 0;
  }

  push(src, offset, length) {
    if (this.used + length > this.buf.length) this.flush();
    src.copy(this.buf, this.used, offset, offset + length);
    this.used += length;
    this.count++;
  }

  flush() {
    if (this.used === 0) return;
    fs.writeSync(this.fd, this.buf, 0, this.used, this.pos);
    this.pos += this.used;
    this.used = 0;
  }

  close() {
    this.flush();
    fs.closeSync(this.fd);
    this.fd = null;
  }

  abort() {
    try { if (this.fd !== null) fs.closeSync(this.fd); } catch { /* ignore */ }
    fs.rmSync(this.tmp, { force: true });
  }
}

/**
 * Open a splat .ply for record-level splitting: binary little-endian, a single
 * fixed-size "vertex" element with float32 x/y/z, not truncated.
 * @returns {{ input: string, header: object, props: Record<string, object>, stride: number, total: number, fileSize: number }}
 */
export function openSplatPly(input, log = console.log) {
  input = path.resolve(input);
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error(`input not found: ${input}`);
  const header = readPlyHeader(input);
  if (header.format !== 'binary_little_endian') throw new Error(`only binary_little_endian .ply is supported (got ${header.format})`);
  if (header.isCompressed) throw new Error('PlayCanvas compressed .ply is not supported; split the original training .ply');
  const vertex = header.elements.find((e) => e.name === 'vertex');
  if (header.elements.length !== 1 || header.elements[0] !== vertex) {
    throw new Error(`the .ply must hold only a "vertex" element (found: ${header.elements.map((e) => e.name).join(', ')})`);
  }
  if (!vertex.fixedSize) throw new Error('vertex element has list properties; cannot split by fixed-size records');
  const props = Object.fromEntries(vertex.properties.map((p) => [p.name, p]));
  for (const k of ['x', 'y', 'z']) {
    if (!props[k] || !['float', 'float32'].includes(props[k].type)) throw new Error(`vertex property "${k}" must be float32`);
  }
  const stride = vertex.stride;
  const total = vertex.count;
  const fileSize = fs.statSync(input).size;
  const bodyEnd = header.headerBytes + total * stride;
  if (bodyEnd > fileSize) throw new Error(`.ply truncated: header declares ${total} splats (${bodyEnd} bytes) but the file has ${fileSize} bytes`);
  if (bodyEnd < fileSize) log(`WARNING: ${fileSize - bodyEnd} trailing bytes after the vertex data are ignored`);
  return { input, header, props, stride, total, fileSize };
}

/** Throttled progress: o.onProgress(pass, f), or a console line when there is no callback. */
export function passProgress(o, pass, passes, name, total) {
  let last = 0;
  return (done) => {
    if (done - last < total / 20 && done !== total) return;
    last = done;
    o.onProgress?.(pass, done / total);
    if (!o.onProgress) process.stdout.write(`\r  pass ${pass}/${passes} (${name}): ${((done / total) * 100).toFixed(0)}%   ${done === total ? '\n' : ''}`);
  };
}

/**
 * Pass 1: labelOf(x, y, z) -> 0..numLabels-1 for every splat (1 byte per splat).
 * A splat with no finite position keeps its file-order neighbour's label.
 */
export function labelSplats(fd, ply, labelOf, numLabels, buf, records, report) {
  const { header, props, stride, total } = ply;
  const ox = props.x.offset, oy = props.y.offset, oz = props.z.offset;
  const labels = new Uint8Array(total);
  const counts = new Array(numLabels).fill(0);
  let nonFinite = 0;
  let done = 0;
  let prev = 0;
  while (done < total) {
    const want = Math.min(records, total - done);
    const got = fs.readSync(fd, buf, 0, want * stride, header.headerBytes + done * stride);
    if (got !== want * stride) throw new Error(`short read at splat ${done}`);
    for (let i = 0; i < want; i++) {
      const b = i * stride;
      const x = buf.readFloatLE(b + ox), y = buf.readFloatLE(b + oy), z = buf.readFloatLE(b + oz);
      let l;
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        l = labelOf(x, y, z);
      } else {
        l = prev; // no position: keep it with its file-order neighbours
        nonFinite++;
      }
      labels[done + i] = l;
      counts[l]++;
      prev = l;
    }
    done += want;
    report(done);
  }
  return { labels, counts, nonFinite };
}

/** Pass 2: append every record to writers[labels[i]] (a null writer drops its records). */
export function writeByLabel(fd, ply, labels, writers, buf, records, report) {
  const { header, stride, total } = ply;
  let done = 0;
  while (done < total) {
    const want = Math.min(records, total - done);
    const got = fs.readSync(fd, buf, 0, want * stride, header.headerBytes + done * stride);
    if (got !== want * stride) throw new Error(`short read at splat ${done} (file changed during the split?)`);
    for (let i = 0; i < want; i++) writers[labels[done + i]]?.push(buf, i * stride, stride);
    done += want;
    report(done);
  }
}

export function readHeaderText(fd, headerBytes) {
  const b = Buffer.alloc(headerBytes);
  fs.readSync(fd, b, 0, headerBytes, 0);
  return b.toString('latin1');
}

/**
 * Keep the splats whose label is `keep`; drop the rest.
 * @param {{ input: string, out: string, labelOf: (x: number, y: number, z: number) => number, numLabels: number, keep: number, emptyHint?: string, readBytes?: number, log?: (s: string) => void, onProgress?: (pass: number, f: number) => void }} o
 * @returns {{ input: string, out: string, totalSplats: number, keptSplats: number, droppedSplats: number, counts: number[], nonFiniteSplats: number, seconds: number }}
 */
export function cropPly(o) {
  const t0 = Date.now();
  const ply = openSplatPly(o.input, o.log ?? console.log);
  const out = path.resolve(o.out);
  if (out === ply.input) throw new Error('output would overwrite the input');
  const records = Math.max(1, Math.floor((o.readBytes ?? 32 * 1024 * 1024) / ply.stride));
  const buf = Buffer.alloc(records * ply.stride);
  const fd = fs.openSync(ply.input, 'r');
  try {
    const { labels, counts, nonFinite } = labelSplats(fd, ply, o.labelOf, o.numLabels, buf, records, passProgress(o, 1, 2, 'label', ply.total));
    const kept = counts[o.keep];
    if (kept === 0) throw new Error(`no splat of ${path.basename(ply.input)} is kept${o.emptyHint ? `: ${o.emptyHint}` : ''}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const writer = new PartWriter(out, Buffer.from(headerWithCount(readHeaderText(fd, ply.header.headerBytes), kept), 'latin1'), ply.stride);
    try {
      const writers = Array.from({ length: o.numLabels }, (_, l) => (l === o.keep ? writer : null));
      writeByLabel(fd, ply, labels, writers, buf, records, passProgress(o, 2, 2, 'write', ply.total));
      writer.close();
      if (writer.count !== kept) throw new Error(`internal error: wrote ${writer.count} of ${kept} splats`);
      fs.renameSync(writer.tmp, out);
    } catch (e) {
      writer.abort();
      throw e;
    }
    return {
      input: ply.input,
      out,
      totalSplats: ply.total,
      keptSplats: kept,
      droppedSplats: ply.total - kept,
      counts,
      nonFiniteSplats: nonFinite,
      seconds: (Date.now() - t0) / 1000,
    };
  } finally {
    fs.closeSync(fd);
  }
}
