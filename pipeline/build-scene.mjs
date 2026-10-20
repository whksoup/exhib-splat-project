#!/usr/bin/env node
// Build a scene: original sources (one per part) + scene transform -> scenes/<name>/build/.
//
//   node pipeline/build-scene.mjs <name> [--force] [--part <id>]... [--build-lod <path>] [--dry-run] [--keep-temp] [--no-verify]
//
// A scene has one or more PARTS (scene.json `parts`), all in the same source
// coordinate frame, sharing one scene transform. Parts are built ONE AFTER
// ANOTHER (one build-lod process at a time, so peak RAM is that of the largest
// part, not of the whole scene):
//   for each part, in scene order:
//     reuse   unchanged since the last good build (source size + mtime, transform
//             matrix, build-lod flags, Spark tag) and its files are in build/:
//             hard-linked (or copied) into .build-tmp/<id>/, nothing rebuilt
//     build   1. if the transform is not identity, bake it into a temp .ply (transform.mjs)
//             2. build-lod into .build-tmp/<id>/ (build.mjs logic, fixed scope flags)
//             3. delete the temp .ply before the next part (disk use stays ~1 part)
//   when every part succeeded: swap .build-tmp/ in as build/ (the previous build
//   is only removed once the new one is in place; a failure leaves it untouched)
//   and write `build` + `buildAttempt` into scene.json (re-read first, so edits
//   saved meanwhile survive).
// Disabled parts are not built; their previous output is kept if present.
// --part <id> rebuilds that part, even if unchanged (repeatable); the other parts' previous
// outputs are carried over as they are (even if outdated: the viewer compensates
// per part and the build is marked "partial"). --force rebuilds even unchanged parts.
//
// Machine-readable lines for the viewer's build panel (one JSON object each):
//   @progress {"stage": "...", "pct": 0-100, "message": "...", "part": {"id", "index", "count", "pct"}}
//   @part     {"id", "index", "count", "status": "queued"|"reuse"|"building"|"built"|"reused"|"kept"|"failed", ...}
//   @result   {"status": "ok"|"failed", "error": ..., "build": {...}}
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_ROOT, SCENES_ROOT, SCOPE_FLAGS, SPARK_TAG, resolveBuildLodBin } from './lib/config.mjs';
import { buildModel, checkInputFile } from './build.mjs';
import { runTransform } from './transform.mjs';
import { formatBytes } from './lib/memory.mjs';
import {
  scenePaths, readScene, updateScene, swapBuildDir, removeStaleBuildDirs, acquireBuildLock,
} from './lib/scene-files.mjs';
import { isIdentityMatrix, isValidPartId, isValidSceneName, matricesEqual } from '../shared/scene-schema.mjs';

export const BUILD_SCENE_USAGE = `Usage:
  node pipeline/build-scene.mjs <scene-name> [options]
  build-scene.bat <scene-name> [options]  (repo root, Windows)
  npm run build-scene -- <scene-name>     (in pipeline/)

Options:
  --force              Rebuild every (selected) part, even when nothing changed.
  --part <id>          Rebuild this part, even if unchanged (repeatable). Other parts keep their previous output.
  --build-lod <path>   build-lod executable (default: $SPARK_BUILD_LOD or pipeline/tools/spark/...).
  --dry-run            Validate the scene and print what would run (reuse / build per part); write nothing.
  --keep-temp          Keep scenes/<name>/.build-tmp/ (and the baked temp .ply files) for debugging.
  --no-verify          Skip transform.mjs's sampled self-check of the baked .ply.
  -h, --help           Show this help.

Reads scenes/<name>/scene.json and builds its enabled parts one after another
from their original sources with the scene "transform", then replaces
scenes/<name>/build/ in one step. Parts whose source (size + mtime), transform
and build flags are unchanged since the last good build are reused, not rebuilt.
Only one scene build runs at a time.`;

export function parseBuildSceneArgs(argv) {
  const opts = { name: null, buildLod: null, dryRun: false, keepTemp: false, verify: true, force: false, parts: [], help: false };
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
      case '--dry-run': opts.dryRun = true; break;
      case '--keep-temp': opts.keepTemp = true; break;
      case '--no-verify': opts.verify = false; break;
      case '--force': opts.force = true; break;
      case '--build-lod': { const v = takeValue(); if (v) opts.buildLod = v; break; }
      case '--part': {
        const v = takeValue();
        if (v === null) break;
        if (!isValidPartId(v)) errors.push(`Invalid part id "${v}"`);
        else if (!opts.parts.includes(v)) opts.parts.push(v);
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

/** Output file stem of a part's build: <scene>-<part>-lod.rad / -lod-N.radc. */
export function partStem(sceneName, partId) {
  return `${sceneName}-${partId}`;
}

/**
 * Can the previous build of a part be reused as it is?
 * @param {object|null} prev  scene.build.parts entry
 * @param {{ source: string }} part
 * @param {{ matrix: number[], flags: string[], sparkTag?: string|null, stat: { size: number, mtime: Date } | null }} now
 * @returns {{ ok: boolean, reason: string }}
 */
export function partReuseCheck(prev, part, now) {
  if (!prev) return { ok: false, reason: 'not built yet' };
  if (prev.source !== part.source) return { ok: false, reason: 'source file changed' };
  if (!now.stat) return { ok: false, reason: 'source missing' };
  if (prev.sourceBytes !== now.stat.size) return { ok: false, reason: `source size changed (${prev.sourceBytes} -> ${now.stat.size} bytes)` };
  if (prev.sourceModified !== now.stat.mtime.toISOString()) return { ok: false, reason: 'source modified since the last build' };
  if (!matricesEqual(prev.transformMatrix, now.matrix)) return { ok: false, reason: 'transform changed' };
  if (JSON.stringify(prev.buildLodFlags ?? []) !== JSON.stringify(now.flags)) return { ok: false, reason: 'build-lod flags changed' };
  if (prev.sparkTag && now.sparkTag && prev.sparkTag !== now.sparkTag) return { ok: false, reason: `Spark tag changed (${prev.sparkTag} -> ${now.sparkTag})` };
  return { ok: true, reason: 'unchanged' };
}

/**
 * Files in build/ that belong to a part's previous build: the .rad, its .radc
 * chunks and (in a per-part folder) the report and log. Null if the .rad or a
 * chunk is missing.
 */
export function previousPartFiles(buildDir, prev) {
  const rad = prev.radFile;
  const dirRel = path.posix.dirname(rad) === '.' ? '' : path.posix.dirname(rad);
  const dir = path.join(buildDir, ...dirRel.split('/').filter(Boolean));
  const radName = path.posix.basename(rad);
  if (!radName.endsWith('-lod.rad') || !fs.existsSync(path.join(dir, radName))) return null;
  const stem = radName.slice(0, -'-lod.rad'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${stem}-lod(\\.rad|-\\d+\\.radc)$`);
  const files = fs.readdirSync(dir).filter((f) => re.test(f));
  const chunks = files.filter((f) => f.endsWith('.radc')).length;
  if (chunks === 0 || (Number.isInteger(prev.chunkCount) && chunks !== prev.chunkCount)) return null;
  // A part folder's report/log belong to it; in a schema-1 flat build/ they belong to the single part too.
  for (const extra of ['build-report.json', 'build-lod.log']) if (fs.existsSync(path.join(dir, extra))) files.push(extra);
  return { dir, files, radName };
}

/** Hard-link (or copy, across volumes) files into `toDir`. */
function linkFiles(fromDir, files, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const f of files) {
    const src = path.join(fromDir, f);
    const dst = path.join(toDir, f);
    try {
      fs.linkSync(src, dst);
    } catch {
      fs.copyFileSync(src, dst);
    }
  }
}

function sourceStat(abs) {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** Sum / union helpers for the scene-level build record. */
export function summariseParts(partBuilds) {
  const sum = (k) => partBuilds.reduce((s, p) => (Number.isFinite(p[k]) ? s + p[k] : s), 0);
  const counts = { input: 0, final: 0 };
  let anyIn = false;
  let anyFinal = false;
  let lo = null;
  let hi = null;
  let peak = null;
  for (const p of partBuilds) {
    if (Number.isFinite(p.splatCount?.input)) { counts.input += p.splatCount.input; anyIn = true; }
    if (Number.isFinite(p.splatCount?.final)) { counts.final += p.splatCount.final; anyFinal = true; }
    if (p.bounds?.bboxMin && p.bounds?.bboxMax) {
      lo = lo ? lo.map((v, i) => Math.min(v, p.bounds.bboxMin[i])) : [...p.bounds.bboxMin];
      hi = hi ? hi.map((v, i) => Math.max(v, p.bounds.bboxMax[i])) : [...p.bounds.bboxMax];
    }
    if (Number.isFinite(p.peakMemoryBytes)) peak = Math.max(peak ?? 0, p.peakMemoryBytes);
  }
  return {
    splatCount: { input: anyIn ? counts.input : null, final: anyFinal ? counts.final : null },
    bounds: lo ? { bboxMin: lo, bboxMax: hi } : null,
    chunkCount: sum('chunkCount'),
    totalBytes: sum('totalBytes'),
    peakMemoryBytes: peak,
  };
}

/**
 * Decide what happens to every part.
 * @returns {{ plan: object[], errors: string[] }}
 */
export function planPartBuilds(scene, { force = false, only = [], buildDir, matrix, flags, sparkTag = SPARK_TAG, projectRoot = PROJECT_ROOT }) {
  const errors = [];
  for (const id of only) {
    const p = scene.parts.find((x) => x.id === id);
    if (!p) errors.push(`no part "${id}" in scene "${scene.name}" (parts: ${scene.parts.map((x) => x.id).join(', ')})`);
    else if (p.enabled === false) errors.push(`part "${id}" is disabled; enable it first`);
  }
  const plan = scene.parts.map((part, index) => {
    const abs = path.resolve(projectRoot, part.source);
    const stat = sourceStat(abs);
    const prev = scene.build?.parts?.find((b) => b.id === part.id) ?? null;
    const prevFiles = prev && fs.existsSync(buildDir) ? previousPartFiles(buildDir, prev) : null;
    const selected = part.enabled !== false && (only.length === 0 || only.includes(part.id));
    const check = partReuseCheck(prev, part, { matrix, flags, sparkTag, stat });
    let action;
    let reason;
    if (!selected) {
      action = prevFiles ? 'keep' : 'none';
      reason = part.enabled === false ? 'disabled' : 'not selected (--part)';
    } else if (!force && only.length === 0 && check.ok && prevFiles) {
      action = 'reuse';
      reason = 'unchanged';
    } else {
      // Naming a part with --part asks for it to be rebuilt, like --force for that part.
      action = 'build';
      reason = force ? '--force' : only.length ? `--part (${check.reason})` : !prevFiles && check.ok ? 'previous output missing from build/' : check.reason;
      const err = checkInputFile(abs);
      if (err) errors.push(`part "${part.id}" source: ${err}`);
    }
    return { part, index, abs, stat, prev, prevFiles, action, reason, identity: isIdentityMatrix(matrix) };
  });
  if (!plan.some((p) => p.part.enabled !== false)) errors.push('every part is disabled: nothing to build');
  return { plan, errors };
}

/**
 * Build one scene. Returns an exit code (0 ok, 1 build failed, 2 usage/scene error, 3 locked).
 * @param {{ name: string, buildLod?: string|null, dryRun?: boolean, keepTemp?: boolean, verify?: boolean, force?: boolean, parts?: string[], scenesRoot?: string }} opts
 */
export async function buildScene(opts) {
  const scenesRoot = opts.scenesRoot ?? SCENES_ROOT;
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

  const matrix = [...scene.transform.matrix];
  const identity = isIdentityMatrix(matrix);
  const extra = scene.buildOptions?.extraFlags ?? [];
  const flags = [...SCOPE_FLAGS, ...extra];
  const buildLodBin = resolveBuildLodBin(opts.buildLod);
  const { plan, errors } = planPartBuilds(scene, { force: !!opts.force, only: opts.parts ?? [], buildDir: paths.build, matrix, flags });

  const count = plan.length;
  console.log(`Scene:     ${scene.name}  (${path.relative(PROJECT_ROOT, paths.dir).split(path.sep).join('/')})`);
  console.log(`Transform: ${identity ? 'identity (build straight from the sources)' : `position ${JSON.stringify(scene.transform.position)}, rotationDeg ${JSON.stringify(scene.transform.rotationDeg)}, scale ${scene.transform.scale}`}`);
  console.log(`Parts:     ${count}${opts.parts?.length ? ` (building only: ${opts.parts.join(', ')})` : ''}${opts.force ? ' (--force)' : ''}`);
  for (const p of plan) {
    const size = p.stat ? formatBytes(p.stat.size) : 'missing';
    console.log(`  ${String(p.index + 1).padStart(2)}. ${p.part.id.padEnd(16)} ${p.action.padEnd(6)} ${p.reason.padEnd(34)} ${p.part.source} (${size})`);
  }
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    emit('result', { status: 'failed', error: errors.join('; ') });
    return 2;
  }
  if (opts.dryRun) {
    console.log('\nDry run, nothing written. Would run, one part at a time:');
    for (const p of plan.filter((x) => x.action === 'build')) {
      if (!identity) console.log(`  transform.mjs ${p.part.source} -> ${path.join(paths.tmp, `_baked-${p.part.id}.ply`)} (temporary)`);
      console.log(`  build-lod ${identity ? p.part.source : `_baked-${p.part.id}.ply`} -> ${path.join(paths.tmp, p.part.id)}`);
    }
    console.log(`  then swap ${paths.tmp} into ${paths.build}`);
    return 0;
  }

  // Nothing to build and the build record would not change: done, quickly.
  const toBuild = plan.filter((p) => p.action === 'build');
  const carried = plan.filter((p) => p.action === 'reuse' || p.action === 'keep');
  const prevIds = (scene.build?.parts ?? []).map((b) => b.id).sort().join(',');
  const nextIds = carried.map((p) => p.part.id).sort().join(',');
  if (toBuild.length === 0 && scene.build && prevIds === nextIds && carried.every((p) => p.action === 'reuse' || p.part.enabled === false)
    && matricesEqual(scene.build.transformMatrix, matrix) && scene.build.status === 'ok') {
    const now = new Date().toISOString();
    for (const p of plan) emit('part', { id: p.part.id, index: p.index, count, status: p.action === 'reuse' ? 'reused' : p.action === 'keep' ? 'kept' : 'none' });
    try {
      updateScene(paths.file, (s) => {
        s.buildAttempt = { status: 'ok', startedAt: now, finishedAt: now, error: null, upToDate: true, parts: plan.map((p) => ({ id: p.part.id, status: p.action === 'reuse' ? 'reused' : p.action })) };
        return s;
      });
    } catch (e) {
      console.error(`error: could not update scene.json: ${e.message}`);
    }
    emit('progress', { stage: 'done', pct: 100, message: 'every part is up to date: nothing to build' });
    console.log('\nScene build ok: every part is up to date, nothing rebuilt (use --force to rebuild).');
    emit('result', { status: 'ok', error: null, build: scene.build, upToDate: true });
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

  // Progress: each part to build weighs its source size; carried parts weigh nothing.
  const weights = new Map(toBuild.map((p) => [p.part.id, Math.max(1, p.stat?.size ?? 1)]));
  const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0) || 1;
  let doneWeight = 0;
  const progress = (p, stage, partPct, message) => {
    const w = p ? weights.get(p.part.id) ?? 0 : 0;
    const pct = Math.min(99, 1 + (98 * (doneWeight + (w * partPct) / 100)) / totalWeight);
    emit('progress', {
      stage,
      pct: Math.round(pct * 10) / 10,
      message: p ? `part ${p.index + 1}/${count} (${p.part.id}): ${message}` : message,
      ...(p && { part: { id: p.part.id, index: p.index, count, pct: Math.round(partPct) } }),
    });
  };

  const startedAt = new Date();
  let error = null;
  let buildInfo = null;
  const attemptParts = plan.map((p) => ({ id: p.part.id, status: p.action === 'build' ? 'not-run' : p.action === 'reuse' ? 'reused' : p.action === 'keep' ? 'kept' : 'none' }));
  for (const p of plan) emit('part', { id: p.part.id, index: p.index, count, status: p.action === 'build' ? 'queued' : p.action, reason: p.reason });
  const newParts = [];
  try {
    const stale = removeStaleBuildDirs(paths.dir);
    if (stale.length) console.log(`Removed leftovers of an interrupted build: ${stale.join(', ')}`);
    fs.mkdirSync(paths.tmp, { recursive: true });

    for (const p of plan) {
      const id = p.part.id;
      const outDir = path.join(paths.tmp, id);
      const att = attemptParts[p.index];

      if (p.action === 'reuse' || p.action === 'keep') {
        // Carry the previous output over: hard links, so nothing is copied and build/ stays intact until the swap.
        linkFiles(p.prevFiles.dir, p.prevFiles.files, outDir);
        newParts.push({ ...p.prev, radFile: `${id}/${p.prevFiles.radName}`, reusedFrom: p.prev.reusedFrom ?? p.prev.finishedAt ?? null });
        console.log(`\n[part ${p.index + 1}/${count}] ${id}: ${p.action === 'reuse' ? 'unchanged, reused' : `kept as is (${p.reason})`}`);
        emit('part', { id, index: p.index, count, status: p.action === 'reuse' ? 'reused' : 'kept' });
        continue;
      }
      if (p.action !== 'build') continue;

      console.log(`\n[part ${p.index + 1}/${count}] ${id}: building from ${p.part.source} (${p.reason})`);
      emit('part', { id, index: p.index, count, status: 'building' });
      att.status = 'failed';
      const partStart = new Date();
      const t0 = Date.now();
      const bakedPly = path.join(paths.tmp, `_baked-${id}.ply`);
      let transformReport = null;
      let buildInput = p.abs;
      try {
        // 1. Bake the transform into a temp .ply (skipped for identity)
        if (!identity) {
          progress(p, 'transform', 1, 'baking the scene transform into a temporary .ply (splat-transform)');
          transformReport = await runTransform({
            input: p.abs,
            transformJson: { ...scene.transform, tool: 'viewer-align' },
            out: bakedPly,
            overwrite: true,
            verify: opts.verify !== false,
          });
          if (transformReport.status !== 'ok') throw new Error(`transform failed: ${transformReport.error}`);
          const v = transformReport.verification;
          console.log(`transform: ${transformReport.wallClockSeconds.toFixed(1)} s, peak ${formatBytes(transformReport.memory?.peakRssBytes)}${v && !v.skipped ? `, verified ${v.checked} splats (max rel error ${v.maxRelError.toExponential(2)})` : ''}`);
          buildInput = bakedPly;
          progress(p, 'transform', 15, 'transform baked');
        }

        // 2. build-lod into .build-tmp/<id>/
        const from = identity ? 2 : 16;
        progress(p, 'lod', from, 'running build-lod');
        const { code, report } = await buildModel({
          inputPath: buildInput,
          name: partStem(scene.name, id),
          outDir,
          version: null,
          extra,
          buildLodBin,
          onOutput: makeBuildLodProgress((e) => progress(p, e.stage, e.pct, e.message), { from }),
          inputExtra: {
            scene: scene.name,
            part: id,
            sceneSource: p.part.source,
            sceneTransformMatrix: matrix,
            bakedFromSource: !identity,
          },
        });
        if (code !== 0 || !report || report.status !== 'ok') throw new Error(report?.error ?? `build-lod step failed (exit ${code})`);

        const stats = report.buildLod.stats ?? {};
        const bounds = transformReport?.output?.bounds ?? report.input.bounds;
        const finished = new Date();
        const pb = {
          id,
          status: 'ok',
          radFile: `${id}/${report.output.headerFile}`,
          transformMatrix: matrix,
          source: p.part.source,
          sourceBytes: p.stat.size,
          sourceModified: p.stat.mtime.toISOString(),
          buildLodFlags: report.buildLod.args,
          sparkTag: report.buildLod.sparkTag,
          startedAt: partStart.toISOString(),
          finishedAt: finished.toISOString(),
          wallClockSeconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
          buildLodSeconds: report.timing?.wallClockSeconds ?? null,
          peakMemoryBytes: report.memory.peakRssBytes,
          splatCount: { input: stats.input_splat_count ?? report.input.splatCount ?? null, final: stats.final_splat_count ?? null },
          bounds: bounds ? { bboxMin: bounds.bboxMin, bboxMax: bounds.bboxMax } : null,
          chunkCount: report.output.chunkCount,
          totalBytes: report.output.totalBytes,
          transformStep: transformReport
            ? {
              splatTransform: transformReport.splatTransform.version,
              seconds: transformReport.wallClockSeconds,
              peakMemoryBytes: transformReport.memory?.peakRssBytes ?? null,
              maxRelError: transformReport.verification?.maxRelError ?? null,
            }
            : null,
        };
        newParts.push(pb);
        Object.assign(att, { status: 'built', seconds: pb.wallClockSeconds, peakMemoryBytes: pb.peakMemoryBytes });
        doneWeight += weights.get(id) ?? 0;
        console.log(`[part ${p.index + 1}/${count}] ${id}: ok in ${pb.wallClockSeconds} s, build-lod peak ${formatBytes(pb.peakMemoryBytes)}, ${pb.splatCount.final ?? '?'} splats, ${pb.chunkCount} chunks`);
        emit('part', { id, index: p.index, count, status: 'built', seconds: pb.wallClockSeconds, peakMemoryBytes: pb.peakMemoryBytes, splats: pb.splatCount.final });
      } catch (e) {
        att.error = e.message;
        att.seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
        emit('part', { id, index: p.index, count, status: 'failed', error: e.message });
        throw new Error(`part "${id}": ${e.message}`);
      } finally {
        // The baked .ply is as big as the part's source: never keep it past its part.
        if (!opts.keepTemp) fs.rmSync(bakedPly, { force: true });
      }
    }

    // Swap the whole build in at once -------------------------------------------
    progress(null, 'swap', 100, 'replacing build/');
    swapBuildDir(paths.tmp, paths.build);

    const finishedAt = new Date();
    const enabledIds = scene.parts.filter((x) => x.enabled !== false).map((x) => x.id);
    const complete = enabledIds.every((id) => {
      const b = newParts.find((x) => x.id === id);
      const part = scene.parts.find((x) => x.id === id);
      return b && b.source === part.source && matricesEqual(b.transformMatrix, matrix);
    });
    buildInfo = {
      status: complete ? 'ok' : 'partial',
      transformMatrix: matrix,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      wallClockSeconds: Number(((finishedAt - startedAt) / 1000).toFixed(1)),
      ...summariseParts(newParts),
      buildLodFlags: flags,
      sparkTag: SPARK_TAG,
      parts: newParts,
    };
  } catch (e) {
    error = e.message;
    console.error(`error: ${error}`);
  } finally {
    if (error && !opts.keepTemp) {
      try { fs.rmSync(paths.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
    }
  }

  // Record the result in scene.json ---------------------------------------------
  const attempt = { status: error ? 'failed' : 'ok', startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), error, parts: attemptParts };
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
  emit('progress', { stage: 'done', pct: 100, message: 'build finished' });
  console.log(`\nScene build ${buildInfo.status === 'ok' ? 'ok' : 'ok (partial: some enabled parts are missing or outdated)'}: scenes/${scene.name}/build/ (${newParts.length} part(s), ${buildInfo.chunkCount} chunks, ${buildInfo.wallClockSeconds} s)`);
  console.log('part             action   seconds   build-lod peak   splats (final)');
  for (const a of attemptParts) {
    const b = newParts.find((x) => x.id === a.id);
    console.log(`  ${a.id.padEnd(15)} ${a.status.padEnd(8)} ${String(a.seconds ?? '-').padStart(7)}   ${(a.status === 'built' ? formatBytes(a.peakMemoryBytes) : '-').padStart(14)}   ${b?.splatCount?.final ?? '-'}`);
  }
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
