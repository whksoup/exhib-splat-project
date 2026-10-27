// Spirula Studio command-line helpers shared by the training experiments
// (reports/benchmarks/*): region files for `--roi-region`, and `spirula train`
// argument lists that replay a previous run's settings.
//
// Why replay: `spirula train` has no config-file option, and the GUI's settings
// differ from the CLI defaults (e.g. floater_suppression strong, max_screen_size
// 0.1), so a run's own config.json is turned back into flags. Only keys that
// `spirula train --help-all` lists are passed; the rest are reported as skipped.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readRoi, readRoiJson } from './roi.mjs';

export const SPIRULA = process.env.SPIRULA_EXE ?? 'C:/Users/yangh/Spirula/spirula.exe';

/**
 * Write a region holding the union of some editor outlines of `sourceFile`, as
 * Spirula's ROI editor saves one (top-level union, editor block kept with those
 * outlines enabled). Checks the written file reads back with the same digest as
 * lib/roi.mjs gives those outlines. Returns the digest.
 */
export function writeOutlineUnion(sourceFile, outlines, outFile) {
  const src = readRoiJson(sourceFile);
  const want = readRoi(sourceFile, outlines);
  const children = src.editor.shapes.filter((s) => outlines.includes(s.name)).map((s) => {
    const R = s.rotation;
    const mid = (s.lo[2] + s.hi[2]) / 2;
    return { type: 'prism', center: [0, 1, 2].map((i) => s.origin[i] + R[3 * i + 2] * mid), rotation: R, half_height: (s.hi[2] - s.lo[2]) / 2, polygon: s.polygon };
  });
  const json = { type: 'union', children, editor: { ...src.editor, shapes: src.editor.shapes.map((s) => ({ ...s, enabled: outlines.includes(s.name) })) } };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(json, null, 2));
  const back = readRoi(outFile);
  if (back.digest !== want.digest) throw new Error(`${outFile}: digest ${back.digest} != the outlines' ${want.digest}`);
  return back.digest;
}

/** Flags `spirula train --help-all` lists, as snake_case. */
function trainFlags() {
  const r = spawnSync(SPIRULA, ['train', '--help-all'], { encoding: 'utf8' });
  return new Set([...(r.stdout + r.stderr).matchAll(/^ {2}--([a-z0-9-]+)/gm)].map((m) => m[1].replace(/-/g, '_')));
}

/** A run's config.json. Spirula writes infinite values as a bare Infinity (not JSON); the CLI spells them inf. */
export function readRunConfig(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/:\s*(-?)Infinity\b/g, ': "$1inf"'));
}

/** `spirula train` arguments (after "train"): `refConfig` (a config.json path) with `overrides` on top. */
export function trainArgs(refConfig, data, overrides) {
  const ref = readRunConfig(refConfig);
  const flags = trainFlags();
  const set = { ...ref, resume: null, ...overrides };
  const args = [set.preset ?? '3dgs', '--data', data];
  const skipped = [];
  for (const [k, v] of Object.entries(set)) {
    if (k === 'preset' || k === 'data') continue;
    if (!flags.has(k)) {
      skipped.push(k);
      continue;
    }
    const value = v === null ? ['none'] : v === true ? ['1'] : v === false ? ['0'] : Array.isArray(v) ? v.map(String) : [String(v)];
    args.push(`--${k.replace(/_/g, '-')}`, ...value);
  }
  return { args, skipped };
}

/**
 * Parse-check `trainArgs` without training: Spirula validates every flag before it
 * opens the dataset, so a missing dataset path is the expected stop. (It checks an
 * --init-ply before the dataset, so pass init_ply none here.) Throws on a rejected flag.
 */
export function checkTrainArgs(refConfig, overrides) {
  const { args } = trainArgs(refConfig, 'C:/spirula-check-no-such-dataset', { ...overrides, init_ply: null });
  const r = spawnSync(SPIRULA, ['train', ...args], { encoding: 'utf8' });
  const last = (r.stdout + r.stderr).trim().split(/\r?\n/).at(-1);
  if (!/dataset path does not exist/.test(last)) throw new Error(`spirula rejected the arguments: ${last}`);
}

/** The splat .ply a finished run wrote (<run>/step-*.ckpt/splat.ply), or null. */
export function runSplatPly(runDir) {
  if (!fs.existsSync(runDir)) return null;
  const ckpts = fs.readdirSync(runDir).filter((d) => /^step-\d+\.ckpt$/.test(d)).sort();
  const ply = ckpts.length ? path.join(runDir, ckpts.at(-1), 'splat.ply') : null;
  return ply && fs.existsSync(ply) ? ply : null;
}
