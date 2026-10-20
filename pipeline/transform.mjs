#!/usr/bin/env node
// Bake a viewer "Align" transform (assets/transforms/<stem>.json) into a splat file
// with PlayCanvas splat-transform, so the result matches the viewer preview exactly.
//
//   node transform.mjs <input.ply|.sog|...> --transform <json> --out <output.ply|.sog|.compressed.ply>
//
// See README.md ("Align transform bake") and lib/transform.mjs for the conventions.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { PIPELINE_DIR, PROJECT_ROOT } from './lib/config.mjs';
import { parseTransformJson, toSplatTransformActions, applyMatrix } from './lib/transform.mjs';
import { readPlyHeader, scanPlyPositions } from './lib/ply.mjs';
import { startMemoryMonitor, formatBytes } from './lib/memory.mjs';

export const TRANSFORM_USAGE = `Usage:
  node transform.mjs <input> --transform <transform.json> --out <output> [options]

Options:
  --transform <json>     Transform written by the viewer's Align mode (assets/transforms/<stem>.json). Required.
  --out <file>           Output file: .ply (full SH, recommended), .compressed.ply, .sog, .spz. Required.
  --overwrite            Replace an existing output file.
  --no-verify            Skip the post-bake check (ply -> ply only: sampled splats must equal M * input).
  --dry-run              Print the splat-transform command and exit.
  -h, --help             Show this help.

The transform is applied as three.js does it: scale, then rotate, then translate, about the world origin.
SH bands are kept (all degrees) and rotated with the splats.`;

const require = createRequire(import.meta.url);

export function splatTransformInfo() {
  // The package's "exports" map hides package.json, so locate it from the main entry.
  let dir = path.dirname(require.resolve('@playcanvas/splat-transform', { paths: [PIPELINE_DIR] }));
  while (!fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return { version: pkg.version, cli: path.join(path.dirname(pkgPath), pkg.bin['splat-transform']) };
}

export function parseTransformArgs(argv) {
  const opts = { input: null, transform: null, out: null, overwrite: false, verify: true, dryRun: false, help: false };
  const errors = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const flag = a.startsWith('--') ? a.split('=')[0] : a;
    const takeValue = () => {
      const eq = a.indexOf('=');
      if (a.startsWith('--') && eq > 0) return a.slice(eq + 1);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { errors.push(`${a} needs a value`); return null; }
      i++;
      return v;
    };
    switch (flag) {
      case '-h': case '--help': opts.help = true; break;
      case '--transform': opts.transform = takeValue(); break;
      case '--out': case '-o': opts.out = takeValue(); break;
      case '--overwrite': case '-w': opts.overwrite = true; break;
      case '--no-verify': opts.verify = false; break;
      case '--dry-run': opts.dryRun = true; break;
      default:
        if (a.startsWith('-')) errors.push(`Unknown option: ${a}`);
        else positional.push(a);
    }
  }
  if (opts.help) return { opts, errors: [] };
  if (positional.length !== 1) errors.push(positional.length ? `Expected one input file, got ${positional.length}` : 'Missing input file');
  opts.input = positional[0] ?? null;
  if (!opts.transform) errors.push('Missing --transform <json>');
  if (!opts.out) errors.push('Missing --out <output>');
  return { opts, errors };
}

/** Read the named float properties of selected vertex rows of a binary .ply. */
function readPlyRows(file, header, indices, names) {
  const vertex = header.elements.find((e) => e.name === 'vertex');
  if (header.format !== 'binary_little_endian' || !vertex.fixedSize || header.elements[0] !== vertex) return null;
  const props = names.map((n) => vertex.properties.find((p) => p.name === n));
  if (props.some((p) => !p || (p.type !== 'float' && p.type !== 'float32'))) return null;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(vertex.stride);
  try {
    return indices.map((i) => {
      fs.readSync(fd, buf, 0, vertex.stride, header.headerBytes + i * vertex.stride);
      return props.map((p) => buf.readFloatLE(p.offset));
    });
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Check sampled output splat centres against M * input (ply -> ply keeps row order).
 * @returns {{ checked: number, maxAbsError: number, maxRelError: number, ok: boolean } | { skipped: string }}
 */
export function verifyBake(input, output, matrix, { samples = 2000, relTol = 1e-5 } = {}) {
  if (!/\.ply$/i.test(input) || !/\.ply$/i.test(output) || /\.compressed\.ply$/i.test(output) || /\.compressed\.ply$/i.test(input)) {
    return { skipped: 'only checked for plain .ply -> .ply' };
  }
  const hi = readPlyHeader(input);
  const ho = readPlyHeader(output);
  if (hi.isCompressed || ho.isCompressed) return { skipped: 'compressed .ply' };
  if (hi.splatCount !== ho.splatCount) return { ok: false, error: `splat count changed: ${hi.splatCount} -> ${ho.splatCount}` };
  const n = hi.splatCount;
  const step = Math.max(1, Math.floor(n / samples));
  const idx = [];
  for (let i = 0; i < n && idx.length < samples; i += step) idx.push(i);
  if (n > 0 && idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  const a = readPlyRows(input, hi, idx, ['x', 'y', 'z']);
  const b = readPlyRows(output, ho, idx, ['x', 'y', 'z']);
  if (!a || !b) return { skipped: 'non-standard .ply layout' };
  let maxAbs = 0;
  let maxRel = 0;
  let checked = 0;
  for (let k = 0; k < idx.length; k++) {
    if (!a[k].every(Number.isFinite)) continue;
    const e = applyMatrix(matrix, a[k]);
    const mag = Math.max(1, Math.hypot(...e));
    const err = Math.hypot(e[0] - b[k][0], e[1] - b[k][1], e[2] - b[k][2]);
    maxAbs = Math.max(maxAbs, err);
    maxRel = Math.max(maxRel, err / mag);
    checked++;
  }
  return { checked, maxAbsError: maxAbs, maxRelError: maxRel, ok: maxRel <= relTol, shDegreeIn: hi.shDegree, shDegreeOut: ho.shDegree };
}

/**
 * Run the bake. Returns a report object (also used by build.mjs).
 * `transform` is a JSON file path; build-scene.mjs passes `transformJson` (an object) instead.
 * @param {{ input: string, transform?: string, transformJson?: object, out: string, overwrite?: boolean, verify?: boolean, dryRun?: boolean, log?: Function, quiet?: boolean }} o
 */
export async function runTransform(o) {
  const log = o.log ?? console.log;
  const input = path.resolve(o.input);
  const out = path.resolve(o.out);
  const transformPath = o.transformJson ? null : path.resolve(o.transform);
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error(`input file not found: ${input}`);
  if (input === out) throw new Error('--out must differ from the input file');
  if (transformPath && !fs.existsSync(transformPath)) throw new Error(`transform JSON not found: ${transformPath}`);
  const json = o.transformJson ?? JSON.parse(fs.readFileSync(transformPath, 'utf8'));
  const t = parseTransformJson(json);
  for (const w of t.warnings) log(`WARNING: ${w}`);
  const { args: actionArgs, engine } = toSplatTransformActions(t);
  const st = splatTransformInfo();
  const cliArgs = [input, ...actionArgs, out, ...(o.overwrite ? ['-w'] : [])];
  const display = `node ${path.relative(process.cwd(), st.cli) || st.cli} ${cliArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  const base = {
    transformFile: transformPath ? path.relative(PROJECT_ROOT, transformPath).split(path.sep).join('/') : null,
    transform: { position: t.position, quaternion: t.quaternion, scale: t.scale, matrix: t.matrix, source: json.source ?? null, createdAt: json.createdAt ?? null },
    splatTransform: { version: st.version, args: cliArgs, engineSpace: engine },
    command: display,
  };
  log(`splat-transform ${st.version}: ${actionArgs.length ? actionArgs.join(' ') : '(identity transform: plain copy/convert)'}`);
  if (o.dryRun) {
    log(`> ${display}`);
    return { ...base, status: 'dry-run' };
  }
  if (fs.existsSync(out) && !o.overwrite) throw new Error(`output exists (pass --overwrite): ${out}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  log(`> ${display}`);
  const t0 = process.hrtime.bigint();
  const child = spawn(process.execPath, [st.cli, ...cliArgs], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const mon = startMemoryMonitor(child.pid);
  let tail = '';
  const onData = (d) => {
    const s = d.toString();
    tail = (tail + s).slice(-20000);
    if (!o.quiet) process.stdout.write(s);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exitCode = await new Promise((resolve) => {
    child.on('error', (e) => { tail += String(e); resolve(-1); });
    child.on('close', (code) => resolve(code));
  });
  const wallSeconds = Number(process.hrtime.bigint() - t0) / 1e9;
  const mem = mon.stop();
  const report = {
    ...base,
    status: 'ok',
    exitCode,
    wallClockSeconds: Number(wallSeconds.toFixed(3)),
    memory: { method: mem.method, peakRssBytes: mem.peakRssBytes || null, peakPrivateBytes: mem.peakPrivateBytes || null },
    output: { path: out, bytes: null, bounds: null, shDegree: null },
    verification: null,
  };
  if (exitCode !== 0 || !fs.existsSync(out)) {
    report.status = 'failed';
    report.error = `splat-transform exited with code ${exitCode}${fs.existsSync(out) ? '' : ' and wrote no output'}: ${tail.trim().split('\n').slice(-5).join(' | ')}`;
    return report;
  }
  report.output.bytes = fs.statSync(out).size;
  if (/\.ply$/i.test(out)) {
    const h = readPlyHeader(out);
    report.output.shDegree = h.shDegree;
    report.output.splatCount = h.splatCount;
    report.output.bounds = await scanPlyPositions(out, h);
    if (/\.ply$/i.test(input) && !readPlyHeader(input).isCompressed) {
      const hin = readPlyHeader(input);
      if (!h.isCompressed && h.shDegree !== hin.shDegree) {
        report.status = 'failed';
        report.error = `SH degree changed: ${hin.shDegree} -> ${h.shDegree}`;
      }
    }
  }
  if (o.verify !== false && report.status === 'ok') {
    report.verification = verifyBake(input, out, t.matrix);
    if (report.verification.ok === false) {
      report.status = 'failed';
      report.error = `verification failed: ${report.verification.error ?? `max relative error ${report.verification.maxRelError}`}`;
    }
  }
  return report;
}

async function main() {
  const { opts, errors } = parseTransformArgs(process.argv.slice(2));
  if (opts.help) { console.log(TRANSFORM_USAGE); return 0; }
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`\n${TRANSFORM_USAGE}`);
    return 2;
  }
  let r;
  try {
    r = await runTransform(opts);
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 2;
  }
  if (r.status === 'dry-run') return 0;
  const fmt = (v) => (v ? `(${v.map((x) => x.toFixed(3)).join(', ')})` : 'n/a');
  console.log('\n----- transform summary -----');
  console.log(`status:       ${r.status}${r.error ? ` (${r.error})` : ''}`);
  console.log(`wall clock:   ${r.wallClockSeconds.toFixed(1)} s`);
  console.log(`peak memory:  ${formatBytes(r.memory.peakRssBytes)} working set, ${formatBytes(r.memory.peakPrivateBytes)} private (${r.memory.method})`);
  console.log(`output:       ${r.output.path} (${formatBytes(r.output.bytes)})`);
  if (r.output.bounds) {
    console.log(`SH degree:    ${r.output.shDegree}`);
    console.log(`bbox min:     ${fmt(r.output.bounds.bboxMin)}`);
    console.log(`bbox max:     ${fmt(r.output.bounds.bboxMax)}`);
  }
  if (r.verification) {
    const v = r.verification;
    console.log(`verify:       ${v.skipped ? `skipped (${v.skipped})` : `${v.ok ? 'ok' : 'FAILED'}: ${v.checked} sampled splats, max abs error ${v.maxAbsError?.toExponential(2)}, max rel ${v.maxRelError?.toExponential(2)}`}`);
  }
  return r.status === 'ok' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
