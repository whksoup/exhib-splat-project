# Processing pipeline: trained splats to Spark chunked LoD

`build.mjs` converts a trained Gaussian splat file into Spark 2.x's streamable LoD format by running Spark's own `build-lod` tool with the flags from the scope: `--quality --rad-chunked --max-sh=1`. The output is a small `.rad` header plus `.radc` chunk files, which the viewer loads with `paged: true`.

## How `build-lod` is obtained (verified)

These facts were checked against the Spark source at tag **v2.3.1** (`rust/build-lod/src/main.rs`, `rust/spark-lib/src/decoder.rs`, `package.json`) and against https://sparkjs.dev/docs/lod-getting-started/:

- `build-lod` is a Rust program in the Spark GitHub repo (`rust/build-lod`). The `@sparkjsdev/spark` npm package does **not** include it, because it only publishes `dist/`. Upstream runs it with `npm run build-lod -- <inputs> [flags]`, which is `cargo run --manifest-path rust/build-lod/Cargo.toml --release --`.
- To make runs repeatable, `npm run setup` clones the repo at a pinned tag into `pipeline/tools/spark/` (gitignored) and builds the release binary once. `build.mjs` then calls that binary directly, which also lets it measure the tool's own memory use.
- It needs Rust **>= 1.82** (the `rust-version` in Spark's workspace). On Windows it also needs the MSVC C++ build tools. Always build in release mode: the docs warn that debug builds make LoD construction very slow.
- **Accepted inputs** (from the usage text and the decoder's extension table): `.ply` (including PlayCanvas `.compressed.ply`), `.spz`, `.splat`, `.ksplat`, **`.sog`**, `.zip` (SOGS bundle), and `.rad`. A PlayCanvas `.sog` file can therefore be passed in directly with no conversion. Building from the original trained `.ply` is still preferred, because SOG is already quantised.
- **Flags used.** `--quality` selects bhatt-lod with base 1.75. It is already the default in v2.3.1, but we pass it explicitly. `--rad-chunked` writes a chunked RAD file. `--max-sh=1` caps spherical harmonics at degree 1; values are clamped to the range 0 to 3.
- Other real flags can be passed through after `--`: `--min-box=x,y,z`, `--max-box=x,y,z`, `--within-dist=x,y,z,r` (cropping), `--skip-validate`, `--csplat` / `--gsplat`, `--cluster-sh[=iters]`, and `--inflate`. The pipeline rejects passthrough flags that would change the output format (`--rad`, `--spz*`, `--quick`, `--tiny-lod`, `--max-sh=`, `--unlod`).
- **Output location.** `build-lod` has no output-directory option. It writes `<input-stem>-lod.rad` and `<input-stem>-lod-<N>.radc` **next to the input file**. The `.rad` header refers to the chunks by name, so the files must never be renamed after the build.
- **Exit code.** If decoding fails or the input contains invalid (non-finite) splats, `build-lod` prints an error and still **exits 0**. `build.mjs` therefore checks the output files and stderr instead of relying on the exit code.

## Prerequisites

| Need | Check | Install |
| --- | --- | --- |
| Node.js >= 22 | `node -v` | https://nodejs.org/ |
| git | `git --version` | `winget install --id Git.Git -e` |
| Rust >= 1.82 (rustup, MSVC toolchain on Windows) | `cargo --version` | `winget install --id Rustlang.Rustup -e`, or run https://win.rustup.rs/x86_64. Open a new terminal afterwards. |
| MSVC C++ build tools (Windows only) | detected through vswhere | `winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| Enough RAM for the largest model | (see caveats) | to be sized in week 1 |

`npm run check-deps` detects all of these and prints the exact command for anything that is missing. It never installs anything itself.

## Install

```sh
cd pipeline
npm run check-deps      # what's missing?
npm run setup           # clone sparkjsdev/spark@v2.3.1 into tools/spark and cargo build --release build-lod
```

To pin a different Spark tag, use `SPARK_TAG=v2.x.y npm run setup` and keep the same tag in the viewer's `package.json`. To use a `build-lod` binary that was built somewhere else, pass `--build-lod <path>` or set `SPARK_BUILD_LOD`.

## Usage

```sh
node build.mjs <input.ply|.sog|.spz|.splat|.ksplat|.zip> --name <model> [--version vN] [options] [-- extra build-lod flags]

# examples
node build.mjs ../assets/source_ply/coit.ply --name coit                 # -> assets/rad_output/coit/v1/
node build.mjs ../assets/source_ply/coit.ply --name coit --dry-run       # inspect + show command only
node build.mjs scan.ply --name lobby -- --within-dist=0,0,0,40           # crop with build-lod's own flag
```

| Option | Meaning |
| --- | --- |
| `--name` | Output name (letters, digits, `. _ -`). Required. |
| `--version` | Version folder. By default the next free `vN` is used. A folder that already holds `.rad`/`.radc` files is never overwritten, because the CDN caches versioned paths permanently. |
| `--no-scan` | Read the `.ply` header only and skip the bounds/centroid pass. |
| `--recentre-threshold <d>` | Warn when the centroid is more than `d` units from the origin. The default is 10. |
| `--cleanup` | Calls the cleanup hook. This is a Phase 2 stub and currently does nothing. |
| `--dry-run` | Inspect the input and print the command. Nothing is written. |
| `--build-lod <path>` | Use a different `build-lod` executable. A `.mjs`/`.js` path is run with Node. |

What a run does:

1. **Inspect the input** without loading it into memory. For `.ply` it parses the header (splat count, SH degree, bytes per splat), then streams the vertex block in 32 MB reads to compute the bounding box and centroid. For PlayCanvas compressed `.ply` it reads the chunk bounds table, and for `.sog` it reads `meta.json` from the zip. It warns about a centroid far from the origin (striping risk), SH degree above 1 (which gets dropped), and non-finite positions.
2. **Cleanup hook** (`cleanup.mjs`). This is a pass-through until Phase 2.
3. **Stage.** The input is hard-linked into `<out>/_input/<name>.<ext>`, so outputs are named after `--name` and written straight into the output folder without copying a 12 GB file. If hard-linking fails (for example, the input is on a different drive), `build-lod` runs next to the source file and the outputs are moved afterwards, keeping the source file's name.
4. **Run** `build-lod --quality --rad-chunked --max-sh=1 [extra] <input>`, mirroring its output to the console and to `build-lod.log`.
5. **Record** wall-clock time and peak memory. Write `build-report.json` and append one line to `reports/build-log.jsonl`. Failed runs are logged too.

### Environment variables

| Variable | Default |
| --- | --- |
| `PIPELINE_OUTPUT_ROOT` | `assets/rad_output` |
| `PIPELINE_BUILD_LOG` | `reports/build-log.jsonl` |
| `SPARK_TAG` | `v2.3.1` |
| `SPARK_BUILD_LOD` | `pipeline/tools/spark/rust/target/release/build-lod(.exe)` |

## Output layout

```
assets/rad_output/<name>/<version>/
  <name>-lod.rad          header (load this URL in the viewer with paged: true)
  <name>-lod-0.radc       chunk files, fetched on demand
  <name>-lod-1.radc
  ...
  build-lod.log           full build-lod console output
  build-report.json       input summary, warnings, args, Spark tag/commit, build-lod's own stats
                          (input/final splat counts, lod_duration, chunk_duration, encodings),
                          wall clock, peak memory, output file list, machine info
reports/build-log.jsonl   one JSON line per run (same report without the file list)
```

`assets/rad_output/*` is gitignored. Only `build-log.jsonl` and the per-build reports are meant for review.

## Tests

```sh
npm test
```

The tests use synthetic files written to the OS temp directory and never touch the repo. They cover argument parsing, the dependency check, the `.ply` reader (binary 3DGS layout, CRLF headers, buffer-boundary reads, a 200k-splat file, NaN positions, truncated files, ASCII, PlayCanvas compressed), the `.sog` meta reader, and dry runs. An end-to-end run uses a stand-in `build-lod` script that follows the real tool's CLI contract (outputs written beside the input, `Comment:` stats block, exit 0 on decode failure), so staging, output collection, reports, version handling and failure detection are all exercised without Rust.

## Known caveats

- **Memory.** `build-lod` decodes the whole input into memory before building the tree. This happens in `process_file_lod_tsplat`, and there is no streaming or out-of-core mode. Peak memory at 50M splats is the main week-1 unknown. If it does not fit, use a high-memory machine or split the model into zones (for example with `--min-box`/`--max-box`, one build per zone).
- **Peak memory is best-effort.** On Windows a PowerShell loop samples the kernel's `PeakWorkingSet64` and `PeakPagedMemorySize64` once a second. On Linux the pipeline reads `VmHWM`; on macOS it polls `ps` RSS. Because the Windows counters are peaks kept by the OS, only growth in the final second can be missed. A process that exits in under about 1 second, before PowerShell starts, records `null`.
- **Recentring is not done yet.** `build-lod` can crop but has no translate option. In v2.3.1 the RAD file stores centres as f32, but Spark's default paged pool stores them at half precision at runtime, so far-off coordinates stripe. The pipeline only warns about this for now (using the f16 step at the farthest coordinate). The Phase 2 cleanup step must recentre the model before the build.
- **`--max-sh=1`** drops SH degrees 2 and 3. Whether that is acceptable is still an open visual-check question in the scope.
- **SOG input** works directly, but its quality is capped by PlayCanvas's quantisation. If the source `.ply` is lost and conversion is needed, PlayCanvas `splat-transform` can turn SOG back into `.ply`, but nothing is gained compared with feeding the `.sog` directly.
- **Windows long paths.** `setup` clones with `core.longpaths=true`. Keep the project path short.
- **`build-lod` GPU feature.** The default build enables `wgpu`, which is only used by the optional `--cluster-sh`. It compiles on a standard MSVC toolchain, and the pipeline does not use that flag.
