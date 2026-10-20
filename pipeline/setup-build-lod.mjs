#!/usr/bin/env node
// Fetches Spark at the pinned tag into pipeline/tools/spark and builds the
// `build-lod` Rust tool in release mode. Project-local; needs cargo on PATH.
//
// This is the equivalent of Spark's own `npm run build-lod` script
// ("cargo run --manifest-path rust/build-lod/Cargo.toml --release --"), split
// into a one-off build so the pipeline can run (and memory-profile) the
// binary directly instead of going through npm -> cargo -> build-lod.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  SPARK_REPO, SPARK_TAG, SPARK_SRC_DIR, TOOLS_DIR, BUILD_LOD_MANIFEST, BUILD_LOD_BIN,
} from './lib/config.mjs';
import { checkDeps, printReport } from './check-deps.mjs';

function sh(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited with code ${r.status}`);
}

const deps = checkDeps().filter((d) => ['node', 'git', 'cargo', 'MSVC C++ build tools'].includes(d.name) || d.name.startsWith('rustc'));
if (deps.some((d) => !d.ok)) {
  console.error('Cannot build build-lod yet:\n');
  printReport(deps);
  process.exit(1);
}

fs.mkdirSync(TOOLS_DIR, { recursive: true });
const tagFile = path.join(SPARK_SRC_DIR, '.pipeline-tag');
if (!fs.existsSync(path.join(SPARK_SRC_DIR, '.git'))) {
  sh('git', ['-c', 'core.longpaths=true', 'clone', '--depth', '1', '--branch', SPARK_TAG, SPARK_REPO, SPARK_SRC_DIR]);
} else {
  const current = fs.existsSync(tagFile) ? fs.readFileSync(tagFile, 'utf8').trim() : null;
  if (current !== SPARK_TAG) {
    sh('git', ['fetch', '--depth', '1', 'origin', 'tag', SPARK_TAG], { cwd: SPARK_SRC_DIR });
    sh('git', ['checkout', '--force', SPARK_TAG], { cwd: SPARK_SRC_DIR });
  }
}
fs.writeFileSync(tagFile, SPARK_TAG + '\n');

const cargo = checkDeps().find((d) => d.name === 'cargo');
const cargoCmd = /found at (.+), not on PATH/.exec(cargo.detail)?.[1] || 'cargo';
sh(cargoCmd, ['build', '--release', '--manifest-path', BUILD_LOD_MANIFEST]);

if (!fs.existsSync(BUILD_LOD_BIN)) {
  console.error(`Build finished but ${BUILD_LOD_BIN} was not found.`);
  process.exit(1);
}
console.log(`\nbuild-lod ready: ${BUILD_LOD_BIN}`);
