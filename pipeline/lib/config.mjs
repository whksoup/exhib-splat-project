// Shared paths and pinned versions for the pipeline.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT_ROOT = path.resolve(PIPELINE_DIR, '..');

// Spark source is pinned to a release tag. build-lod is NOT shipped in the
// @sparkjsdev/spark npm package (it only publishes dist/), so we build it from
// the GitHub repo at the same tag the viewer should pin in its package.json.
export const SPARK_REPO = 'https://github.com/sparkjsdev/spark.git';
export const SPARK_TAG = process.env.SPARK_TAG || 'v2.3.1';
// rust/Cargo.toml in Spark v2.3.1 declares rust-version = "1.82".
export const MIN_RUST_VERSION = '1.82.0';
export const MIN_NODE_MAJOR = 22;

export const TOOLS_DIR = path.join(PIPELINE_DIR, 'tools');
export const SPARK_SRC_DIR = path.join(TOOLS_DIR, 'spark');
export const BUILD_LOD_MANIFEST = path.join(SPARK_SRC_DIR, 'rust', 'build-lod', 'Cargo.toml');
export const BUILD_LOD_BIN = path.join(
  SPARK_SRC_DIR, 'rust', 'target', 'release',
  process.platform === 'win32' ? 'build-lod.exe' : 'build-lod',
);

// Overridable so a build can target a scratch disk (and so tests stay out of the repo).
export const OUTPUT_ROOT = path.resolve(process.env.PIPELINE_OUTPUT_ROOT || path.join(PROJECT_ROOT, 'assets', 'rad_output'));
export const BUILD_LOG = path.resolve(process.env.PIPELINE_BUILD_LOG || path.join(PROJECT_ROOT, 'reports', 'build-log.jsonl'));

// Flags required by docs/Project_Scope.md ("Technical architecture", step 3).
// Verified against rust/build-lod/src/main.rs at v2.3.1.
export const SCOPE_FLAGS = ['--quality', '--rad-chunked', '--max-sh=1'];

/** Resolve which build-lod binary to use: --build-lod flag > env > local build. */
export function resolveBuildLodBin(override) {
  return override || process.env.SPARK_BUILD_LOD || BUILD_LOD_BIN;
}
