#!/usr/bin/env node
// Build a scene: original source + scene transform -> scenes/<name>/build/.
//
//   node pipeline/build-scene.mjs <name> [--build-lod <path>] [--dry-run] [--keep-temp] [--no-verify]
//
// Every build starts from the ORIGINAL source named in scenes/<name>/scene.json
// (never modified) and overwrites build/, so nothing accumulates:
//   1. if the transform is not identity, bake it into a temp .ply with transform.mjs
//   2. run build-lod (build.mjs logic, fixed scope flags) into scenes/<name>/.build-tmp/
//   3. delete the temp .ply; on success swap .build-tmp/ in as build/ (the previous
//      build is only removed once the new one is in place; a failed build leaves it)
//   4. write `build` + `buildAttempt` back into scene.json (re-read first, so edits
//      saved meanwhile survive)
//
// Machine-readable lines for the viewer's build panel (one JSON object each):
//   @progress {"stage": "...", "pct": 0-100, "message": "..."}
//   @result   {"status": "ok"|"failed", "error": ..., "build": {...}}
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_ROOT, SCENES_ROOT, resolveBuildLodBin } from './lib/config.mjs';
import { buildModel, checkInputFile } from './build.mjs';
import { runTransform } from './transform.mjs';
import {
  scenePaths, readScene, updateScene, swapBuildDir, removeStaleBuildDirs, acquireBuildLock,
} from './lib/scene-files.mjs';
import { isIdentityMatrix, isValidSceneName } from '../shared/scene-schema.mjs';

export const BUILD_SCENE_USAGE = `Usage:
  node pipeline/build-scene.mjs <scene-name> [options]
  build-scene.bat <scene-name>            (repo root, Windows)
  npm run build-scene -- <scene-name>     (in pipeline/)

Options:
  --build-lod <path>   build-lod executable (default: $SPARK_BUILD_LOD or pipeline/tools/spark/...).
  --dry-run            Validate the scene and print what would run; write nothing.
  --keep-temp          Keep scenes/<name>/.build-tmp/ (and the baked temp .ply) for debugging.
  --no-verify          Skip transform.mjs's sampled self-check of the baked .ply.
  -h, --help           Show this help.

Reads scenes/<name>/scene.json, rebuilds from its original "source" with its
"transform", and replaces scenes/<name>/build/. Only one scene build runs at a time.`;

export function parseBuildSceneArgs(argv) {
  const opts = { name: null, buildLod: null, dryRun: false, keepTemp: false, verify: true, help: false };
  const errors = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const flag = a.startsWith('--') ? a.split('=')[0] : a;
    switch (flag) {
      case '-h': case '--help': opts.help = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--keep-temp': opts.keepTemp = true; break;
      case '--no-verify': opts.verify = false; break;
      case '--build-lod': {
        const eq = a.indexOf('=');
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (!v || v.startsWith('--')) errors.push('--build-lod needs a value');
        else opts.buildLod = v;
        break;
      }
      default:
        if (a.startsWith('-')) errors.push(`Unknown option: ${a}`);
        else positional.push(a);
    }
  }
  if (opts.help) return { opts, errors: [] };
  if (positional.length !== 1) errors.push(positional.length ? `Expected one scene name, got ${positional.length}` : 'Missing scene name');
  else if (!isValidSceneName(positional[0])) errors.push(`Invalid scene name "${positional[0]}" (letters, digits, _ and -, max 64 chars)`);
  opts.name = positional[0] ?? null;
  return { opts, errors };
}

/** Emit one machine-readable line. */
function emit(kind, obj) {
  console.log(`@${kind} ${JSON.stringify(obj)}`);
}

/**
 * Turns build-lod console output into coarse progress. build-lod prints
 * "Level: L, ..., frontier: a / b" while building the LoD tree (a/b -> 1) and
 * "Wrote <stem>-lod-N.radc" per chunk afterwards.
 */
export function makeBuildLodProgress(onProgress, { from = 5, lodTo = 88, chunksTo = 97 } = {}) {
  let buf = '';
  let chunks = 0;
  let last = -1;
  const send = (pct, stage, message) => {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    if (p === last) return;
    last = p;
    onProgress({ stage, pct: p, message });
  };
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const lvl = /^Level: (-?\d+),.*frontier: (\d+) \/ (\d+)/.exec(line);
      if (lvl) {
        const f = Number(lvl[2]) / Math.max(1, Number(lvl[3]));
        send(from + (lodTo - from) * f, 'lod', `LoD level ${lvl[1]}`);
        continue;
      }
      if (/^Wrote .*-lod-\d+\.radc/.test(line)) {
        chunks++;
        // Chunk count is not known up front; approach chunksTo asymptotically.
        send(lodTo + (chunksTo - lodTo) * (1 - Math.exp(-chunks / 25)), 'chunks', `wrote ${chunks} chunks`);
      }
    }
  };
}

/**
 * Build one scene. Returns an exit code (0 ok, 1 build failed, 2 usage/scene error, 3 locked).
 * @param {{ name: string, buildLod?: string|null, dryRun?: boolean, keepTemp?: boolean, verify?: boolean, scenesRoot?: string }} opts
 */
export async function buildScene(opts) {
  const scenesRoot = opts.scenesRoot ?? SCENES_ROOT;
  const progress = (stage, pct, message = '') => emit('progress', { stage, pct, message });
  let paths;
  let scene;
  try {
    paths = scenePaths(scenesRoot, opts.name);
    if (!fs.existsSync(paths.file)) throw new Error(`scene not found: ${paths.file}`);
    scene = readScene(paths.file);
    if (scene.name !== opts.name) throw new Error(`scene.json name "${scene.name}" does not match folder "${opts.name}"`);
  } catch (e) {
    console.error(`error: ${e.message}`);
    emit('result', { status: 'failed', error: e.message });
    return 2;
  }

  const sourcePath = path.resolve(PROJECT_ROOT, scene.source);
  const srcErr = checkInputFile(sourcePath);
  if (srcErr) {
    console.error(`error: scene source: ${srcErr}`);
    emit('result', { status: 'failed', error: `scene source: ${srcErr}` });
    return 2;
  }
  const matrix = [...scene.transform.matrix];
  const identity = isIdentityMatrix(matrix);
  const extra = scene.buildOptions?.extraFlags ?? [];
  const buildLodBin = resolveBuildLodBin(opts.buildLod);
  const bakedPly = path.join(paths.tmp, `${scene.name}.ply`);

  console.log(`Scene:     ${scene.name}  (${path.relative(PROJECT_ROOT, paths.dir).split(path.sep).join('/')})`);
  console.log(`Source:    ${scene.source}`);
  console.log(`Transform: ${identity ? 'identity (build straight from the source)' : `position ${JSON.stringify(scene.transform.position)}, rotationDeg ${JSON.stringify(scene.transform.rotationDeg)}, scale ${scene.transform.scale}`}`);
  if (opts.dryRun) {
    console.log('\nDry run, nothing written. Would run:');
    if (!identity) console.log(`  transform.mjs ${scene.source} -> ${bakedPly} (temporary)`);
    console.log(`  build-lod ${identity ? scene.source : bakedPly} -> ${paths.tmp}, then swap into ${paths.build}`);
    return 0;
  }

  let release;
  try {
    release = acquireBuildLock(scenesRoot, scene.name);
  } catch (e) {
    console.error(`error: ${e.message}`);
    emit('result', { status: 'failed', error: e.message });
    return e.code === 'ELOCKED' ? 3 : 2;
  }

  const startedAt = new Date();
  let error = null;
  let buildInfo = null;
  try {
    const stale = removeStaleBuildDirs(paths.dir);
    if (stale.length) console.log(`Removed leftovers of an interrupted build: ${stale.join(', ')}`);
    fs.mkdirSync(paths.tmp, { recursive: true });

    // 1. Bake the transform into a temp .ply (skipped for identity) ---------
    let buildInput = sourcePath;
    let transformReport = null;
    if (!identity) {
      progress('transform', 2, 'baking scene transform into a temporary .ply (splat-transform)');
      transformReport = await runTransform({
        input: sourcePath,
        transformJson: { ...scene.transform, tool: 'viewer-align' },
        out: bakedPly,
        overwrite: true,
        verify: opts.verify !== false,
      });
      if (transformReport.status !== 'ok') throw new Error(`transform failed: ${transformReport.error}`);
      const v = transformReport.verification;
      console.log(`transform: ${transformReport.wallClockSeconds.toFixed(1)} s${v && !v.skipped ? `, verified ${v.checked} splats (max rel error ${v.maxRelError.toExponential(2)})` : ''}`);
      buildInput = bakedPly;
      progress('transform', 25, 'transform baked');
    }

    // 2. build-lod into the temp dir ----------------------------------------
    const from = identity ? 3 : 26;
    progress('lod', from, 'running build-lod');
    const { code, report } = await buildModel({
      inputPath: buildInput,
      name: scene.name,
      outDir: paths.tmp,
      version: null,
      extra,
      buildLodBin,
      onOutput: makeBuildLodProgress((p) => emit('progress', p), { from }),
      inputExtra: {
        scene: scene.name,
        sceneSource: scene.source,
        sceneTransformMatrix: matrix,
        bakedFromSource: !identity,
      },
    });
    // The temp .ply is never kept next to the build (it is as big as the source).
    if (!opts.keepTemp) fs.rmSync(bakedPly, { force: true });
    if (code !== 0 || !report || report.status !== 'ok') throw new Error(report?.error ?? `build-lod step failed (exit ${code})`);

    // 3. Swap into build/ ---------------------------------------------------
    progress('swap', 98, 'replacing build/');
    swapBuildDir(paths.tmp, paths.build);

    const finishedAt = new Date();
    const stats = report.buildLod.stats ?? {};
    const bounds = transformReport?.output?.bounds ?? report.input.bounds;
    const srcStat = fs.statSync(sourcePath);
    buildInfo = {
      status: 'ok',
      transformMatrix: matrix,
      radFile: report.output.headerFile,
      source: scene.source,
      sourceBytes: srcStat.size,
      sourceModified: srcStat.mtime.toISOString(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      wallClockSeconds: Number(((finishedAt - startedAt) / 1000).toFixed(1)),
      splatCount: { input: stats.input_splat_count ?? report.input.splatCount ?? null, final: stats.final_splat_count ?? null },
      bounds: bounds ? { bboxMin: bounds.bboxMin, bboxMax: bounds.bboxMax } : null,
      buildLodFlags: report.buildLod.args,
      sparkTag: report.buildLod.sparkTag,
      chunkCount: report.output.chunkCount,
      totalBytes: report.output.totalBytes,
      peakMemoryBytes: report.memory.peakRssBytes,
      transformStep: transformReport
        ? { splatTransform: transformReport.splatTransform.version, seconds: transformReport.wallClockSeconds, maxRelError: transformReport.verification?.maxRelError ?? null }
        : null,
    };
  } catch (e) {
    error = e.message;
    console.error(`error: ${error}`);
  } finally {
    if (error && !opts.keepTemp) {
      try { fs.rmSync(paths.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
    }
  }

  // 4. Record the result in scene.json -------------------------------------
  const attempt = { status: error ? 'failed' : 'ok', startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), error };
  try {
    updateScene(paths.file, (s) => {
      s.buildAttempt = attempt;
      if (buildInfo) s.build = buildInfo;
      return s;
    });
  } catch (e) {
    console.error(`error: could not update scene.json: ${e.message}`);
    error ??= `could not update scene.json: ${e.message}`;
  }
  release();

  if (error) {
    console.log(`\nScene build FAILED: ${error}${fs.existsSync(paths.build) ? ' (previous build/ left unchanged)' : ''}`);
    emit('result', { status: 'failed', error });
    return 1;
  }
  progress('done', 100, 'build finished');
  console.log(`\nScene build ok: scenes/${scene.name}/build/${buildInfo.radFile} (${buildInfo.chunkCount} chunks, ${buildInfo.wallClockSeconds} s)`);
  if (buildInfo.bounds) console.log(`bounds:    min ${JSON.stringify(buildInfo.bounds.bboxMin)}  max ${JSON.stringify(buildInfo.bounds.bboxMax)}`);
  emit('result', { status: 'ok', error: null, build: buildInfo });
  return 0;
}

async function main() {
  const { opts, errors } = parseBuildSceneArgs(process.argv.slice(2));
  if (opts.help) { console.log(BUILD_SCENE_USAGE); return 0; }
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`\n${BUILD_SCENE_USAGE}`);
    return 2;
  }
  return buildScene(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
