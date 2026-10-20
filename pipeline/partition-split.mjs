#!/usr/bin/env node
// Split a merged splat .ply back into its spatial parts using a Spirula Studio
// scene partition (partition.json + partition.bin). Fallback for when only the
// merged file exists; real part exports from Spirula are preferred.
//
//   node pipeline/partition-split.mjs <merged.ply> --partition <partition.json> --out-dir <dir> [--prefix part] [--overwrite]
//
// Each splat goes to the part of its NEAREST partition point (k-d tree over the
// partition's labelled points). Two streaming passes over the .ply, so RAM stays
// at the partition data (~30 bytes/point) + 1 byte/splat of labels + I/O buffers,
// never the .ply itself:
//   pass 1  read positions in 32 MB blocks, label every splat
//   pass 2  read again, append each record to its part file (8 MB write buffers)
// Every output has the input's header byte for byte except the vertex count;
// records are copied unchanged (all properties, all SH bands), in file order.
// Outputs are written as <name>.tmp and renamed when complete.
//
// Also reports the share of splats whose label disagrees with their position in
// the file assuming the merge wrote the parts back to back in part order (true
// for Spirula's merges), and nearest-point distance percentiles.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readPlyHeader } from './lib/ply.mjs';
import { readPartition, KdTree } from './lib/partition.mjs';
import { formatBytes } from './lib/memory.mjs';

export const SPLIT_USAGE = `Usage:
  node pipeline/partition-split.mjs <merged.ply> --partition <partition.json> --out-dir <dir> [options]

Options:
  --partition <json>   Spirula partition.json (partition.bin next to it).
  --out-dir <dir>      Folder for the part files (created). Use a gitignored place, e.g. assets/source_ply/parts/<scan>/.
  --prefix <name>      Output names <prefix><k>.ply (default "part": part0.ply, part1.ply, ...).
  --overwrite          Replace existing part files.
  --json               Print the report as JSON at the end.
  -h, --help           Show this help.`;

export function parseSplitArgs(argv) {
  const opts = { input: null, partition: null, outDir: null, prefix: 'part', overwrite: false, json: false, help: false };
  const errors = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const flag = a.startsWith('--') ? a.split('=')[0] : a;
    const takeValue = () => {
      const eq = a.indexOf('=');
      if (a.startsWith('--') && eq > 0) return a.slice(eq + 1);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { errors.push(`${flag} needs a value`); return null; }
      i++;
      return v;
    };
    switch (flag) {
      case '-h': case '--help': opts.help = true; break;
      case '--partition': opts.partition = takeValue(); break;
      case '--out-dir': opts.outDir = takeValue(); break;
      case '--prefix': opts.prefix = takeValue(); break;
      case '--overwrite': opts.overwrite = true; break;
      case '--json': opts.json = true; break;
      default:
        if (a.startsWith('-')) errors.push(`Unknown option: ${a}`);
        else positional.push(a);
    }
  }
  if (opts.help) return { opts, errors: [] };
  if (positional.length !== 1) errors.push(positional.length ? `Expected one input .ply, got ${positional.length}` : 'Missing input .ply');
  opts.input = positional[0] ?? null;
  if (!opts.partition) errors.push('Missing --partition <partition.json>');
  if (!opts.outDir) errors.push('Missing --out-dir <dir>');
  if (opts.prefix !== null && !/^[A-Za-z0-9_-]{1,40}$/.test(opts.prefix)) errors.push('--prefix: letters, digits, _ and - only');
  return { opts, errors };
}

/** Header text with the vertex count replaced (exactly one `element vertex N` line). */
export function headerWithCount(headerText, count) {
  const re = /^element vertex \d+(?=\r?\n)/m;
  const matches = headerText.match(/^element vertex \d+\r?$/gm);
  if (!matches || matches.length !== 1) throw new Error('.ply header must contain exactly one "element vertex <n>" line');
  return headerText.replace(re, `element vertex ${count}`);
}

class PartWriter {
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

/** Approximate percentiles from a log-spaced histogram of distances (metres). */
function makeDistHistogram() {
  const BINS = 200; // 1e-6 m .. 1e4 m, 20 bins/decade
  const h = new Float64Array(BINS);
  let n = 0;
  return {
    add(d) {
      const b = d <= 1e-6 ? 0 : Math.min(BINS - 1, Math.floor((Math.log10(d) + 6) * 20));
      h[b]++;
      n++;
    },
    percentile(p) {
      if (n === 0) return null;
      const target = p * n;
      let acc = 0;
      for (let b = 0; b < BINS; b++) {
        acc += h[b];
        if (acc >= target) return 10 ** ((b + 1) / 20 - 6); // bin upper edge
      }
      return null;
    },
  };
}

/**
 * Split `input` into one .ply per partition part.
 * @param {{ input: string, partition: string, outDir: string, prefix?: string, overwrite?: boolean, log?: (s: string) => void, onProgress?: (pass: number, f: number) => void, readBytes?: number }} o
 * @returns {Promise<object>} report
 */
export async function partitionSplit(o) {
  const log = o.log ?? console.log;
  const t0 = Date.now();
  const input = path.resolve(o.input);
  const prefix = o.prefix ?? 'part';
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

  const tP = Date.now();
  const part = readPartition(o.partition);
  const tree = new KdTree(part.positions, part.labels);
  const k = part.numParts;
  log(`partition: ${part.count.toLocaleString('en-US')} labelled points, ${k} parts (${part.labelCounts.join(' / ')} points), bbox (${part.bbox.min.map((v) => v.toFixed(2)).join(', ')}) .. (${part.bbox.max.map((v) => v.toFixed(2)).join(', ')}); k-d tree in ${((Date.now() - tP) / 1000).toFixed(1)} s`);
  log(`input:     ${input} (${formatBytes(fileSize)}, ${total.toLocaleString('en-US')} splats, ${stride} B/splat)`);

  fs.mkdirSync(o.outDir, { recursive: true });
  const outFiles = Array.from({ length: k }, (_, i) => path.join(path.resolve(o.outDir), `${prefix}${i}.ply`));
  for (const f of outFiles) {
    if (path.resolve(f) === input) throw new Error('output would overwrite the input');
    if (fs.existsSync(f) && !o.overwrite) throw new Error(`${f} exists (pass --overwrite)`);
  }

  const ox = props.x.offset, oy = props.y.offset, oz = props.z.offset;
  const records = Math.max(1, Math.floor((o.readBytes ?? 32 * 1024 * 1024) / stride));
  const buf = Buffer.alloc(records * stride);
  const labels = new Uint8Array(total);
  const counts = new Array(k).fill(0);
  const hist = makeDistHistogram();
  let nonFinite = 0;
  let maxDist = 0;

  // Pass 1: label ------------------------------------------------------------
  const fd = fs.openSync(input, 'r');
  try {
    let done = 0;
    let prev = 0;
    let lastReport = 0;
    while (done < total) {
      const want = Math.min(records, total - done);
      const got = fs.readSync(fd, buf, 0, want * stride, header.headerBytes + done * stride);
      if (got !== want * stride) throw new Error(`short read at splat ${done}`);
      for (let i = 0; i < want; i++) {
        const b = i * stride;
        const x = buf.readFloatLE(b + ox), y = buf.readFloatLE(b + oy), z = buf.readFloatLE(b + oz);
        let l;
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          l = tree.label(x, y, z);
          const d = Math.sqrt(tree.bestD);
          hist.add(d);
          if (d > maxDist) maxDist = d;
        } else {
          l = prev; // no position: keep it with its file-order neighbours
          nonFinite++;
        }
        labels[done + i] = l;
        counts[l]++;
        prev = l;
      }
      done += want;
      if (done - lastReport >= total / 20 || done === total) {
        lastReport = done;
        o.onProgress?.(1, done / total);
        if (!o.onProgress) process.stdout.write(`\r  pass 1/2 (label): ${((done / total) * 100).toFixed(0)}%   `);
      }
    }
    if (!o.onProgress) process.stdout.write('\n');
    const tLabel = Date.now();

    // Pass 2: write ----------------------------------------------------------
    const headerText = Buffer.alloc(header.headerBytes);
    fs.readSync(fd, headerText, 0, header.headerBytes, 0);
    const text = headerText.toString('latin1');
    const writers = [];
    try {
      for (let p = 0; p < k; p++) writers.push(new PartWriter(outFiles[p], Buffer.from(headerWithCount(text, counts[p]), 'latin1'), stride));
      done = 0;
      lastReport = 0;
      while (done < total) {
        const want = Math.min(records, total - done);
        const got = fs.readSync(fd, buf, 0, want * stride, header.headerBytes + done * stride);
        if (got !== want * stride) throw new Error(`short read at splat ${done} (file changed during the split?)`);
        for (let i = 0; i < want; i++) writers[labels[done + i]].push(buf, i * stride, stride);
        done += want;
        if (done - lastReport >= total / 20 || done === total) {
          lastReport = done;
          o.onProgress?.(2, done / total);
          if (!o.onProgress) process.stdout.write(`\r  pass 2/2 (write): ${((done / total) * 100).toFixed(0)}%   `);
        }
      }
      if (!o.onProgress) process.stdout.write('\n');
      for (const w of writers) w.close();
      for (let p = 0; p < k; p++) {
        if (writers[p].count !== counts[p]) throw new Error(`internal error: part ${p} wrote ${writers[p].count} of ${counts[p]} splats`);
        fs.renameSync(writers[p].tmp, outFiles[p]);
      }
    } catch (e) {
      for (const w of writers) w.abort();
      throw e;
    }

    // File-order agreement: the merge is assumed to hold parts back to back in label order.
    let disagree = 0;
    const blockOf = new Array(k).fill(0);
    {
      let start = 0;
      for (let p = 0; p < k; p++) {
        blockOf[p] = start;
        start += counts[p];
      }
      let p = 0;
      for (let i = 0; i < total; i++) {
        while (p < k - 1 && i >= blockOf[p + 1]) p++;
        if (labels[i] !== p) disagree++;
      }
    }
    // Label mix per tenth of the file (shows the back-to-back layout at a glance).
    const deciles = [];
    for (let d = 0; d < 10; d++) {
      const a = Math.floor((d * total) / 10);
      const b = Math.floor(((d + 1) * total) / 10);
      const c = new Array(k).fill(0);
      for (let i = a; i < b; i++) c[labels[i]]++;
      deciles.push(c.map((v) => Number(((v / Math.max(1, b - a)) * 100).toFixed(1))));
    }

    const report = {
      input,
      partition: path.resolve(o.partition),
      totalSplats: total,
      bytesPerSplat: stride,
      parts: outFiles.map((f, p) => ({ part: p, file: f, splats: counts[p], bytes: fs.statSync(f).size, partitionPoints: part.labelCounts[p] })),
      sumOfParts: counts.reduce((a, b) => a + b, 0),
      nonFiniteSplats: nonFinite,
      fileOrder: {
        assumption: 'merged file = parts written back to back in part order',
        disagreeingSplats: disagree,
        disagreeingShare: total ? disagree / total : 0,
        labelSharePerTenthOfFile: deciles,
      },
      nearestPointDistance: { p50: hist.percentile(0.5), p90: hist.percentile(0.9), p99: hist.percentile(0.99), max: maxDist, note: 'metres in source units, log-histogram estimate (bin upper edge, 12% bins)' },
      seconds: { label: (tLabel - t0) / 1000, total: (Date.now() - t0) / 1000 },
      memory: { rssBytes: process.memoryUsage().rss, labelBytes: total, partitionBytes: part.count * 16 },
    };
    return report;
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const { opts, errors } = parseSplitArgs(process.argv.slice(2));
  if (opts.help) { console.log(SPLIT_USAGE); return 0; }
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`\n${SPLIT_USAGE}`);
    return 2;
  }
  let r;
  try {
    r = await partitionSplit(opts);
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  console.log('\n----- partition split -----');
  for (const p of r.parts) console.log(`part ${p.part}: ${p.splats.toLocaleString('en-US').padStart(12)} splats  ${formatBytes(p.bytes).padStart(10)}  ${p.file}`);
  console.log(`sum:    ${r.sumOfParts.toLocaleString('en-US')} of ${r.totalSplats.toLocaleString('en-US')} splats${r.sumOfParts === r.totalSplats ? ' (all accounted for)' : ' (MISMATCH)'}`);
  if (r.nonFiniteSplats) console.log(`non-finite positions: ${r.nonFiniteSplats} (kept with their file-order neighbour's part)`);
  console.log(`file order: ${pct(r.fileOrder.disagreeingShare)} of splats are labelled differently from their back-to-back block`);
  console.log(`label share per tenth of the file: ${r.fileOrder.labelSharePerTenthOfFile.map((c) => c.join('/')).join('  ')}`);
  const d = r.nearestPointDistance;
  console.log(`distance to nearest partition point: p50 ${d.p50?.toPrecision(2)}, p90 ${d.p90?.toPrecision(2)}, p99 ${d.p99?.toPrecision(2)}, max ${d.max.toPrecision(3)}`);
  console.log(`time:   ${r.seconds.total.toFixed(1)} s (labelling ${r.seconds.label.toFixed(1)} s); process RSS ${formatBytes(r.memory.rssBytes)}`);
  const reportFile = path.join(path.resolve(opts.outDir), `${opts.prefix}-split-report.json`);
  fs.writeFileSync(reportFile, JSON.stringify(r, null, 2) + '\n');
  console.log(`report: ${reportFile}`);
  if (opts.json) console.log(JSON.stringify(r));
  return r.sumOfParts === r.totalSplats ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
