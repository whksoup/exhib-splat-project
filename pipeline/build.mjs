#!/usr/bin/env node
// Trained splat file -> Spark 2.x chunked LoD (.rad header + .radc chunks).
//
//   node build.mjs <input.ply|.sog> --name <model> [--version v1] [-- extra build-lod flags]
//
// See README.md for prerequisites and output layout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  PROJECT_ROOT, OUTPUT_ROOT, BUILD_LOG, SCOPE_FLAGS, SPARK_TAG, SPARK_SRC_DIR, resolveBuildLodBin,
} from './lib/config.mjs';
import { parseArgs, USAGE, BUILD_LOD_INPUT_EXTS } from './lib/args.mjs';
import { readPlyHeader, scanPlyPositions } from './lib/ply.mjs';
import { readSogSummary } from './lib/sog.mjs';
import { startMemoryMonitor, formatBytes } from './lib/memory.mjs';
import { checkDeps, printReport } from './check-deps.mjs';
import { cleanup } from './cleanup.mjs';

const fmtVec = (v) => (v ? `(${v.map((x) => x.toFixed(3)).join(', ')})` : 'n/a');
const rel = (p) => path.relative(PROJECT_ROOT, p).split(path.sep).join('/');

/** f16 spacing at magnitude |x|: what Spark's compact (half-float) centres can resolve. */
export function f16Step(x) {
  const a = Math.abs(x);
  if (a < 2 ** -14) return 2 ** -24;
  return 2 ** (Math.floor(Math.log2(a)) - 10);
}

/** Inspect the input file and return a summary (never loads the whole file). */
export async function inspectInput(inputPath, { scan = true, log = console.log } = {}) {
  const ext = path.extname(inputPath).toLowerCase();
  const sizeBytes = fs.statSync(inputPath).size;
  const summary = { path: inputPath, ext, sizeBytes, format: null, splatCount: null, shDegree: null, bounds: null };

  if (ext === '.ply') {
    const h = readPlyHeader(inputPath);
    Object.assign(summary, {
      format: h.isCompressed ? 'ply-compressed (PlayCanvas)' : `ply-${h.format}`,
      splatCount: h.splatCount,
      shDegree: h.shDegree,
      bytesPerSplat: h.bytesPerSplat,
      elements: h.elements.map((e) => ({ name: e.name, count: e.count, properties: e.properties.length })),
    });
    if (scan || h.isCompressed) {
      const t0 = Date.now();
      summary.bounds = await scanPlyPositions(inputPath, h, {
        onProgress: (f) => process.stdout.write(`\r  scanning positions... ${(f * 100).toFixed(0)}%   `),
      });
      if (!h.isCompressed && h.splatCount > 0) process.stdout.write('\n');
      summary.bounds.scanSeconds = (Date.now() - t0) / 1000;
    }
  } else if (ext === '.sog' || ext === '.zip') {
    try {
      Object.assign(summary, readSogSummary(inputPath));
    } catch (e) {
      log(`  (could not read SOG meta.json: ${e.message}; build-lod will still try to decode it)`);
      summary.format = ext.slice(1);
    }
  } else {
    summary.format = ext.slice(1);
  }
  return summary;
}

export function analyseSummary(s, { recentreThreshold = 10 } = {}) {
  const warnings = [];
  const b = s.bounds;
  if (b?.centroid) {
    const dist = Math.hypot(...b.centroid);
    const maxAbs = Math.max(...b.bboxMin.map(Math.abs), ...b.bboxMax.map(Math.abs));
    b.centroidDistance = dist;
    b.extent = b.bboxMax.map((v, i) => v - b.bboxMin[i]);
    b.f16StepAtFarthest = f16Step(maxAbs);
    if (dist > recentreThreshold) {
      warnings.push(
        `Centroid is ${dist.toFixed(2)} units from the origin (threshold ${recentreThreshold}). ` +
        `Spark's compact encoding stores centres at reduced (half-float) precision; at |coord| ${maxAbs.toFixed(1)} ` +
        `the step is ~${b.f16StepAtFarthest.toPrecision(2)} units, which shows as striping. Recentre the model ` +
        `before building (cleanup step, Phase 2) or plan for pagedExtSplats in the viewer.`);
    }
    if (b.nonFiniteSplats > 0) {
      warnings.push(`${b.nonFiniteSplats} splats have non-finite positions; build-lod will refuse the file unless "-- --skip-validate" is passed.`);
    }
  }
  if (s.shDegree !== null && s.shDegree > 1) {
    warnings.push(`Input has SH degree ${s.shDegree}; --max-sh=1 drops degrees 2-${s.shDegree} (scope decision, pending visual check).`);
  }
  if (s.ext === '.sog') {
    warnings.push('Input is .sog (already quantised by PlayCanvas). build-lod accepts it, but building from the original trained .ply gives better quality.');
  }
  return warnings;
}

/** Pull the pretty-printed JSON that build-lod prints after "Comment: ". */
export function parseBuildLodComment(stdout) {
  const i = stdout.lastIndexOf('Comment: {');
  if (i < 0) return null;
  let depth = 0;
  const start = i + 'Comment: '.length;
  for (let j = start; j < stdout.length; j++) {
    if (stdout[j] === '{') depth++;
    else if (stdout[j] === '}' && --depth === 0) {
      try { return JSON.parse(stdout.slice(start, j + 1)); } catch { return null; }
    }
  }
  return null;
}

export function nextVersion(modelDir) {
  if (!fs.existsSync(modelDir)) return 'v1';
  const nums = fs.readdirSync(modelDir).map((d) => /^v(\d+)$/.exec(d)?.[1]).filter(Boolean).map(Number);
  return `v${nums.length ? Math.max(...nums) + 1 : 1}`;
}

function findLodOutputs(dir, stem) {
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}-lod(\\.rad|-\\d+\\.radc)$`);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)) : [];
}

function moveFile(src, dst) {
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(src, dst);
    fs.unlinkSync(src);
  }
}

function sparkCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SPARK_SRC_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

function appendBuildLog(entry) {
  fs.mkdirSync(path.dirname(BUILD_LOG), { recursive: true });
  fs.appendFileSync(BUILD_LOG, JSON.stringify(entry) + '\n');
}

async function main() {
  const { opts, errors } = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return 0; }
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`\n${USAGE}`);
    return 2;
  }

  const inputPath = path.resolve(opts.input);
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    console.error(`error: input file not found: ${inputPath}`);
    return 2;
  }
  const ext = path.extname(inputPath).toLowerCase();
  if (!BUILD_LOD_INPUT_EXTS.includes(ext)) {
    console.error(`error: build-lod does not accept "${ext}" files. Supported: ${BUILD_LOD_INPUT_EXTS.join(' ')}`);
    return 2;
  }

  // 1. Inspect input -------------------------------------------------------
  console.log(`Input: ${inputPath} (${formatBytes(fs.statSync(inputPath).size)})`);
  let summary;
  try {
    summary = await inspectInput(inputPath, { scan: opts.scan });
  } catch (e) {
    console.error(`error: could not read input: ${e.message}`);
    return 1;
  }
  const warnings = analyseSummary(summary, { recentreThreshold: opts.recentreThreshold });
  console.log(`  format:       ${summary.format}`);
  console.log(`  splats:       ${summary.splatCount?.toLocaleString('en-US') ?? 'unknown'}`);
  console.log(`  SH degree:    ${summary.shDegree ?? 'unknown'}`);
  if (summary.bytesPerSplat) console.log(`  bytes/splat:  ${summary.bytesPerSplat}`);
  if (summary.bounds) {
    const b = summary.bounds;
    console.log(`  bbox min:     ${fmtVec(b.bboxMin)}`);
    console.log(`  bbox max:     ${fmtVec(b.bboxMax)}`);
    console.log(`  extent:       ${fmtVec(b.extent)}`);
    console.log(`  centroid:     ${fmtVec(b.centroid)}  (|c| = ${b.centroidDistance?.toFixed(3)})${b.note ? `  [${b.note}]` : ''}`);
  } else if (ext === '.ply') {
    console.log('  bounds:       skipped (--no-scan)');
  }
  for (const w of warnings) console.warn(`WARNING: ${w}`);

  // 2. Cleanup hook (Phase 2) ----------------------------------------------
  const cleaned = await cleanup(inputPath, { header: summary, bounds: summary.bounds, enabled: opts.cleanup });
  const buildInput = cleaned.path;

  // 3. Output location ------------------------------------------------------
  const modelDir = path.join(OUTPUT_ROOT, opts.name);
  const version = opts.version || nextVersion(modelDir);
  const outDir = path.join(modelDir, version);
  // A folder left by a failed run (log/report only) may be reused; one holding
  // .rad/.radc output may not.
  const existing = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  if (existing.some((f) => /\.radc?$/.test(f) || f === '_input')) {
    console.error(`error: ${rel(outDir)} already contains build output. Versioned outputs are immutable (CDN caches them forever); choose a new --version.`);
    return 2;
  }

  const buildLodBin = resolveBuildLodBin(opts.buildLod);
  const buildExt = ext === '.zip' ? '.zip' : ext;
  const stagedName = `${opts.name}${buildExt}`;
  const args = [...SCOPE_FLAGS, ...opts.extra];

  if (opts.dryRun) {
    console.log('\nDry run, nothing written. Would run:');
    console.log(`  ${buildLodBin} ${args.join(' ')} ${path.join(outDir, '_input', stagedName)}`);
    console.log(`  output -> ${rel(outDir)}/${opts.name}-lod.rad + ${opts.name}-lod-<N>.radc`);
    if (!fs.existsSync(buildLodBin)) console.log('  (build-lod binary not present yet: run `npm run check-deps`)');
    return 0;
  }

  // 4. Dependencies ---------------------------------------------------------
  if (!fs.existsSync(buildLodBin)) {
    console.error('\nbuild-lod is not available. Dependency check:\n');
    printReport(checkDeps());
    return 1;
  }

  // 5. Stage input -----------------------------------------------------------
  // build-lod has no output-dir option: it writes <input-stem>-lod.rad and
  // <input-stem>-lod-<N>.radc next to the input file. We hard-link the input
  // into a staging folder inside the output dir (no 12 GB copy) so outputs land
  // there and are named after --name. If hard-linking fails (different volume),
  // we build beside the original file and move the results.
  fs.mkdirSync(outDir, { recursive: true });
  const stageDir = path.join(outDir, '_input');
  fs.mkdirSync(stageDir, { recursive: true });
  let runInput = path.join(stageDir, stagedName);
  let staged = true;
  try {
    fs.linkSync(buildInput, runInput);
  } catch (e) {
    staged = false;
    fs.rmdirSync(stageDir);
    runInput = buildInput;
    console.warn(`WARNING: could not hard-link input into the output folder (${e.code}); building beside the source file and moving outputs.`);
  }
  const runDir = path.dirname(runInput);
  const stem = path.basename(runInput, path.extname(runInput));
  if (!staged) {
    const clash = findLodOutputs(runDir, stem);
    if (clash.length) {
      console.error(`error: ${runDir} already contains ${clash[0]} (and ${clash.length - 1} more); move them away first.`);
      return 1;
    }
  }

  // 6. Run build-lod ----------------------------------------------------------
  const logPath = path.join(outDir, 'build-lod.log');
  const logStream = fs.createWriteStream(logPath);
  console.log(`\n> ${buildLodBin} ${args.join(' ')} ${runInput}\n`);
  logStream.write(`> ${buildLodBin} ${args.join(' ')} ${runInput}\n\n`);

  const startedAt = new Date();
  const t0 = process.hrtime.bigint();
  // A .mjs/.js "binary" (wrapper script, or the test stub) is run with this Node.
  const isScript = /\.(m?js)$/i.test(buildLodBin);
  const child = isScript
    ? spawn(process.execPath, [buildLodBin, ...args, runInput], { cwd: runDir, windowsHide: true })
    : spawn(buildLodBin, [...args, runInput], { cwd: runDir, windowsHide: true });
  const mon = startMemoryMonitor(child.pid);
  let stdout = '';
  let stderrTail = '';
  child.stdout.on('data', (d) => {
    const s = d.toString();
    stdout = (stdout + s).slice(-2_000_000); // keep the tail; the stats "Comment:" block is printed last
    process.stdout.write(s);
    logStream.write(s);
  });
  child.stderr.on('data', (d) => { const s = d.toString(); stderrTail = (stderrTail + s).slice(-20000); process.stderr.write(s); logStream.write(s); });
  const exitCode = await new Promise((resolve) => {
    child.on('error', (e) => { stderrTail += String(e); resolve(-1); });
    child.on('close', (code) => resolve(code));
  });
  const wallSeconds = Number(process.hrtime.bigint() - t0) / 1e9;
  const mem = mon.stop();
  await new Promise((r) => logStream.end(r));

  // 7. Collect outputs ---------------------------------------------------------
  const produced = findLodOutputs(runDir, stem);
  for (const f of produced) {
    if (runDir !== outDir) moveFile(path.join(runDir, f), path.join(outDir, f));
  }
  if (staged) {
    fs.unlinkSync(runInput); // removes only the staging hard link; the source file is untouched
    fs.rmdirSync(stageDir);
  }
  const files = produced.map((f) => ({ file: f, bytes: fs.statSync(path.join(outDir, f)).size }));
  const header = files.find((f) => f.file.endsWith('.rad'));
  const chunks = files.filter((f) => f.file.endsWith('.radc'));

  // build-lod returns exit code 0 on decode/validation failure, so check output too.
  let failure = null;
  if (exitCode !== 0) failure = `build-lod exited with code ${exitCode}`;
  else if (/Decoding failed/.test(stderrTail)) failure = 'build-lod could not decode the input';
  else if (/Stopping processing due to invalid splats/.test(stderrTail)) failure = 'input has invalid (non-finite) splats; rerun with "-- --skip-validate" to drop the check';
  else if (!header) failure = 'build-lod finished but produced no .rad file';
  else if (chunks.length === 0) failure = 'no .radc chunk files produced (was --rad-chunked honoured?)';

  const lodInfo = parseBuildLodComment(stdout);
  const report = {
    status: failure ? 'failed' : 'ok',
    error: failure,
    name: opts.name,
    version,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    input: {
      path: inputPath,
      relativePath: rel(inputPath),
      sizeBytes: summary.sizeBytes,
      format: summary.format,
      splatCount: summary.splatCount,
      shDegree: summary.shDegree,
      bounds: summary.bounds,
      cleanupApplied: cleaned.applied,
    },
    warnings,
    buildLod: {
      binary: buildLodBin,
      sparkTag: SPARK_TAG,
      sparkCommit: sparkCommit(),
      args,
      exitCode,
      // build-lod's own stats: input/final splat counts, lod_duration, chunk_duration, encodings
      stats: lodInfo,
    },
    timing: { wallClockSeconds: Number(wallSeconds.toFixed(3)) },
    memory: {
      method: mem.method,
      peakRssBytes: mem.peakRssBytes || null,
      peakPrivateBytes: mem.peakPrivateBytes || null,
      samples: mem.samples,
      note: 'Best-effort sampling (1 s). Windows: PeakWorkingSet64 / PeakPagedMemorySize64 of the build-lod process.',
      error: mem.error,
    },
    output: {
      dir: rel(outDir),
      headerFile: header?.file ?? null,
      headerBytes: header?.bytes ?? null,
      chunkCount: chunks.length,
      totalBytes: files.reduce((a, f) => a + f.bytes, 0),
      files,
    },
    machine: {
      platform: `${process.platform}-${process.arch}`,
      os: `${os.type()} ${os.release()}`,
      cpu: os.cpus()[0]?.model ?? null,
      cpuCount: os.cpus().length,
      totalMemBytes: os.totalmem(),
      hostname: os.hostname(),
      node: process.version,
    },
  };
  fs.writeFileSync(path.join(outDir, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
  const { files: _omit, ...outputSummary } = report.output;
  appendBuildLog({ ...report, output: outputSummary, input: { ...report.input, bounds: undefined, centroid: summary.bounds?.centroid ?? null } });

  console.log('\n----- build summary -----');
  console.log(`status:       ${report.status}${failure ? ` (${failure})` : ''}`);
  console.log(`wall clock:   ${wallSeconds.toFixed(1)} s`);
  console.log(`peak memory:  ${formatBytes(mem.peakRssBytes)} working set, ${formatBytes(mem.peakPrivateBytes)} private (${mem.method})`);
  console.log(`output:       ${rel(outDir)}/ (${header?.file ?? 'no header'} + ${chunks.length} chunks, ${formatBytes(report.output.totalBytes)})`);
  console.log(`report:       ${rel(path.join(outDir, 'build-report.json'))}, appended to ${rel(BUILD_LOG)}`);
  return failure ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
