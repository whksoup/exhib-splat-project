#!/usr/bin/env node
// Detects what the pipeline needs and prints exact install steps for anything
// missing. Never installs system-wide toolchains itself.
//
//   node check-deps.mjs          human-readable report, exit 1 if blocking items missing
//   node check-deps.mjs --json   machine-readable report
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  SPARK_TAG, SPARK_SRC_DIR, MIN_RUST_VERSION, MIN_NODE_MAJOR, OUTPUT_ROOT, resolveBuildLodBin,
} from './lib/config.mjs';

const isWin = process.platform === 'win32';

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  } catch {
    return null;
  }
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Find a cargo-installed tool on PATH or in ~/.cargo/bin (rustup's default). */
function findCargoTool(name) {
  const onPath = run(name, ['--version']);
  if (onPath) return { cmd: name, version: onPath, onPath: true };
  const home = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  const p = path.join(home, 'bin', isWin ? `${name}.exe` : name);
  if (fs.existsSync(p)) {
    const v = run(p, ['--version']);
    if (v) return { cmd: p, version: v, onPath: false };
  }
  return null;
}

function findMsvc() {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return null;
  const out = run(vswhere, ['-latest', '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath']);
  return out || null;
}

const RUST_INSTALL = isWin
  ? [
      'Install Rust via rustup (user-level, MSVC toolchain):',
      '  winget install --id Rustlang.Rustup -e',
      '  (or download and run https://win.rustup.rs/x86_64 , accept the default "stable-x86_64-pc-windows-msvc")',
      'Then open a NEW terminal and verify:  cargo --version   (needs rustc >= ' + MIN_RUST_VERSION + ')',
    ]
  : [
      'Install Rust via rustup:',
      "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
      'Then:  source "$HOME/.cargo/env" && cargo --version   (needs rustc >= ' + MIN_RUST_VERSION + ')',
    ];

const MSVC_INSTALL = [
  'Rust on Windows (MSVC target) needs the Visual C++ build tools (link.exe + Windows SDK):',
  '  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"',
  '  (rustup-init also offers to install these on first run.)',
];

export function checkDeps() {
  const items = [];
  const add = (name, ok, detail, fix = [], blocking = true) => items.push({ name, ok, detail, fix, blocking });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= MIN_NODE_MAJOR, `v${process.versions.node}`,
    [`Install Node.js >= ${MIN_NODE_MAJOR} from https://nodejs.org/`]);

  const git = run('git', ['--version']);
  add('git', !!git, git || 'not found',
    [isWin ? 'winget install --id Git.Git -e' : 'Install git with your package manager'],);

  const cargo = findCargoTool('cargo');
  const rustc = findCargoTool('rustc');
  let rustcVer = null;
  if (rustc) rustcVer = (/rustc (\d+\.\d+\.\d+)/.exec(rustc.version) || [])[1] || null;
  add('cargo', !!cargo,
    cargo ? `${cargo.version}${cargo.onPath ? '' : ` (found at ${cargo.cmd}, not on PATH)`}` : 'not found',
    cargo && !cargo.onPath
      ? [`Add ${path.dirname(cargo.cmd)} to PATH (or open a new terminal after installing rustup).`]
      : RUST_INSTALL);
  add('rustc >= ' + MIN_RUST_VERSION,
    !!rustcVer && compareVersions(rustcVer, MIN_RUST_VERSION) >= 0,
    rustcVer ? `rustc ${rustcVer}` : 'not found',
    rustcVer ? ['rustup update stable'] : RUST_INSTALL);

  if (isWin) {
    const msvc = findMsvc();
    add('MSVC C++ build tools', !!msvc, msvc || 'not found (vswhere did not report VC.Tools.x86.x64)', MSVC_INSTALL);
  }

  const tagFile = path.join(SPARK_SRC_DIR, '.pipeline-tag');
  const srcTag = fs.existsSync(tagFile) ? fs.readFileSync(tagFile, 'utf8').trim() : null;
  add(`Spark source (${SPARK_TAG})`, srcTag === SPARK_TAG,
    srcTag ? `pipeline/tools/spark at ${srcTag}` : 'not cloned',
    ['npm run setup        (from pipeline/; clones sparkjsdev/spark at the pinned tag and builds build-lod)']);

  const bin = resolveBuildLodBin();
  add('build-lod binary', fs.existsSync(bin), fs.existsSync(bin) ? bin : `missing: ${bin}`,
    ['npm run setup        (needs cargo; runs: cargo build --release --manifest-path tools/spark/rust/build-lod/Cargo.toml)',
      'or point SPARK_BUILD_LOD / --build-lod at an existing build-lod executable']);

  // Informational only.
  const ram = os.totalmem();
  add('system RAM', true, `${(ram / 2 ** 30).toFixed(1)} GB total (build-lod holds all splats in memory; size the machine in week 1)`, [], false);
  try {
    fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
    const st = fs.statfsSync(OUTPUT_ROOT);
    add('free disk (output volume)', true, `${((st.bavail * st.bsize) / 2 ** 30).toFixed(1)} GB free at ${OUTPUT_ROOT}`, [], false);
  } catch { /* statfs not available */ }

  return items;
}

export function printReport(items) {
  for (const it of items) {
    const mark = it.ok ? 'OK  ' : it.blocking ? 'MISS' : 'WARN';
    console.log(`[${mark}] ${it.name.padEnd(28)} ${it.detail}`);
  }
  const missing = items.filter((i) => !i.ok && i.blocking);
  if (missing.length) {
    console.log('\nTo fix:');
    const seen = new Set();
    for (const it of missing) {
      const key = it.fix.join('\n');
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`\n- ${it.name}:`);
      for (const l of it.fix) console.log(`    ${l}`);
    }
    console.log('\nNote: install order is Rust (+ MSVC build tools on Windows) -> `npm run setup` -> build.');
  }
  return missing.length === 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const items = checkDeps();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(items, null, 2));
  } else {
    printReport(items);
  }
  process.exit(items.some((i) => !i.ok && i.blocking) ? 1 : 0);
}
