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

## Align transform bake (`transform.mjs`)

The viewer's Align mode (`viewer/README.md`) saves a rotation / uniform scale /
origin as `assets/transforms/<stem>.json`. `transform.mjs` bakes it into the
splat file with PlayCanvas **`@playcanvas/splat-transform` 3.10.0** (installed
in `pipeline/`, pinned exactly with `playcanvas` 2.23.0; `npm install` in `pipeline/`).

```sh
node pipeline/transform.mjs <input.ply|.sog|...> --transform assets/transforms/<stem>.json --out <output.ply> [--overwrite] [--no-verify] [--dry-run]
```

Run it **before** `build.mjs`, then build from the baked file:

```sh
node pipeline/transform.mjs assets/source_ply/scan.ply --transform assets/transforms/scan.json --out assets/source_ply/scan-aligned.ply
node pipeline/build.mjs assets/source_ply/scan-aligned.ply --name scan
```

- **Output keeps full SH** (every degree in the input, rotated with the splats). Dropping to SH 1 stays a separate `build-lod --max-sh=1` decision. Write `.ply` for the bake. `.compressed.ply`, `.sog` and `.spz` outputs also work but are quantised.
- **Match with the viewer.** The viewer previews `p' = T + R(q)·(s·p)` (three.js Object3D: scale, then rotate, then translate, about the world origin). `transform.mjs` writes exactly that. The quaternion and position are authoritative, and a JSON whose `matrix` disagrees with them is refused.
- **splat-transform conventions** (read from its source in `node_modules`, `dist/index.mjs`):
  - Actions `-s/--scale <f>`, `-r/--rotate <x,y,z>` (degrees) and `-t/--translate <x,y,z>` left-multiply a pending transform, so they apply in CLI order.
  - `-r` is PlayCanvas `Quat.setFromEulerAngles`, which equals three.js Euler order `'ZYX'`.
  - Readers tag PLY/SOG/SPZ data with `Transform.PLY`, a 180° rotation about Z, and actions act in engine space. On write, `delta = PLY⁻¹ · U · PLY` is baked into the file.
  - `transform.mjs` therefore passes U = Rz(180)·M·Rz(180)⁻¹: quaternion (x, y, z, w) becomes (−x, −y, z, w) and translation (x, y, z) becomes (−x, −y, z). It converts to Euler from the quaternion and checks the round trip. The arguments are passed as `--scale=… --rotate=… --translate=…`, so negative numbers are never read as flags.
  - Baking moves positions with the full TRS, pre-multiplies `rot_*` by the rotation, adds ln(s) to `scale_*`, and rotates `f_rest_*` (SH bands 1–3, sh-lib `RotateSH`). DC and opacity are unchanged.
- **Self-check.** For `.ply` → `.ply`, 2000 sampled splats are read back and compared with M·input; the run fails if the relative error exceeds 1e-5. It also fails if the SH degree changed. Use `--no-verify` to skip this.
- splat-transform streams the file, so memory stays well below the file size. On the 665 MB / 2.81M-splat test file, peak memory was about 590 MB and a run took 4–46 s depending on disk.

`npm test` includes `test/transform.test.mjs`. It writes a synthetic SH-3 `.ply` with asymmetric positions, random rotations and anisotropic scales, applies −90° X, then 30° Y, scale 1.7 and translate (2, −1, 3) once with three.js matrices and once with `transform.mjs`, and compares:

- positions (relative error below 1e-6);
- quaternions;
- scales;
- the band-1 SH vectors;
- SH radiance for random view directions.

## Scenes (`build-scene.mjs`)

A scene (`scenes/<name>/scene.json`, schema in `../shared/scene-schema.mjs`)
has one or more **parts**, `parts: [{ id, source, label?, enabled }]`, all in
the same source coordinate frame, and one scene `transform` that applies to
every part identically. Schema-1 files (a single `source`) are migrated on
read: the source becomes part `main` and the v1 build record becomes that
part's build (its flat `build/<name>-lod.rad` keeps working and is reused by
incremental builds). The file is written as schema 2 on the next save or build.

```sh
node pipeline/new-scene.mjs <name> --source assets/source_ply/parts/OculusV1            # folder: every splat file in it
node pipeline/new-scene.mjs <name> --source "assets/source_ply/parts/OculusV1/part*.ply" # glob (file-name part only)
node pipeline/new-scene.mjs <name> --source a.ply --source b.ply [--transform t.json ... | --transform-from <scene>]
node pipeline/build-scene.mjs <name> [--force] [--part <id>]... [--dry-run] [--keep-temp] [--no-verify]
```

Part ids come from the file names (`part0.ply` -> `part0`); `--transform-from`
copies another scene's transform (used for `oculus_parts`, which has exactly
the `oculus` transform).

**Build flow.** Parts are built **one after another**, never two `build-lod`
processes at once, so peak RAM is that of the largest part:

1. For each part, in scene order: if the transform is not identity, bake it into `.build-tmp/_baked-<part>.ply` (transform.mjs, verified); run `build-lod` into `.build-tmp/<part>/` (outputs `<scene>-<part>-lod.rad` + `.radc`, `build-report.json`, `build-lod.log`); delete the baked `.ply` before the next part, so temporary disk use is about one part.
2. When every part succeeded, `.build-tmp/` replaces `build/` in one rename; the previous build is removed only after that. Any failure leaves the last good `build/` and the `build` record in scene.json untouched (the attempt, with each part's status, goes to `buildAttempt`).
3. `scene.json` gets `build`: `{ status: "ok"|"partial", transformMatrix, parts: [{ id, radFile, transformMatrix, source, sourceBytes, sourceModified, buildLodFlags, sparkTag, wallClockSeconds, buildLodSeconds, peakMemoryBytes, splatCount, bounds, chunkCount, totalBytes, transformStep, reusedFrom? }], splatCount, bounds (union), chunkCount, totalBytes, peakMemoryBytes (max) }`.

**Incremental rules.** A part is **reused** (its previous files hard-linked
into the new build, nothing rebuilt) when its source path, size and mtime,
the transform matrix, the build-lod flags and the Spark tag all equal what
its last good build recorded and its `.rad` + all chunks are still in
`build/`. If nothing at all changed, the run finishes at once without
touching `build/` (0.1 s on `oculus_parts`). `--force` rebuilds every part.
`--part <id>` (repeatable) rebuilds that part even if unchanged and carries
the other parts over as they are, even when their transform is outdated: the
build is then `partial`, and the viewer shows each part with its own
correction matrix until the rest is rebuilt. Disabled parts are not built;
their previous output is kept. Removed parts disappear from `build/`.

**Progress lines** (for the editor's build panel): `@progress {stage, pct, message, part: {id, index, count, pct}}`
(overall `pct` weighs each part by source size), `@part {id, index, count, status, seconds, peakMemoryBytes}`
(`queued`, `reuse`, `keep`, `building`, `built`, `reused`, `kept`, `failed`), `@result {status, error, build}`.

**Measured** (OculusV1, 2,811,571 splats, same transform):

| Build | build-lod peak (working set) | transform step peak | wall clock |
| --- | --- | --- | --- |
| merged `oculus` (1 part) | 1.11 GB | ~0.6 GB | 50.8 s |
| `oculus_parts`, per part (935K–940K splats) | 0.355–0.358 GB | 0.56 GB | 18–22 s |
| `oculus_parts`, 3 parts sequential | 0.358 GB (max) | 0.56 GB | 59.2 s |

(Decimal GB; the console prints binary MB, e.g. 0.358 GB = 341 MB.) The union
of the part bounds equals the merged build's bounds exactly; final splat
counts 3,939,331 vs 3,939,655. The transform bake (splat-transform, a Node
process) now has the higher peak, about 0.56 GB almost regardless of part size.

## Cropping Spirula part exports to their region (`scene-partition.mjs`)

Spirula trains each partition part with its own cameras plus a ring of
neighbouring ones. Those cameras also see the other parts' regions (across
the room, through glass), so every part export holds a **low-detail copy of
the other parts**. Overlaid in one scene, those large splats sit on top of the
other parts' sharp ones and blur them. On OculusV2, about 1.1–1.5% of each
part's splats lie in another part's region, and they are 5–10× larger than
the part's own splats.

A scene can name the partition the parts were trained with. The build then
crops each part to its own region before the transform bake and build-lod. A
splat is kept only when its nearest partition point carries the part's own
label, which is the same rule `partition-split.mjs` uses (below).

```sh
node pipeline/scene-partition.mjs <scene> --partition assets/partitions/<scan>/partition.json [--part <id>=<n>]... [--dry-run]
node pipeline/scene-partition.mjs <scene> --off
node pipeline/new-scene.mjs <name> --source ... --partition assets/partitions/<scan>/partition.json
```

- **scene.json** gets `partition` (the repo-relative partition.json) and a `partitionPart` for each part.
- **Detecting the part number.** Each part's number is detected by labelling 20,000 sampled splats; a file that is not clearly one part (under 80%) is refused. Use `--part <id>=<n>` to set a part's number by hand. This is the `partition_part` in Spirula's training log.
- **Crop step.** The crop is a streaming pass into `.build-tmp/_cropped-<part>.ply`, deleted after its part.
- **Build record.** Each part's build records `crop: { partition, part, partitionBytes, keptSplats, droppedSplats, seconds }`.
- **Rebuilds.** Changing the partition, a part's number or the `partition.bin` size rebuilds that part. The viewer shows the part as outdated until then.
- **Seams.** The cut is hard (no overlap margin), as in Spirula's own merge.

## Cropping to a region of interest (`scene-roi.mjs`)

A Spirula ROI training (`--roi-region <dataset>/roi/<name>.json`) reconstructs
that region, but its export still holds the rest of the scene, faded and at low
detail. Spirula keeps no per-run copy of the region; the region file is
overwritten when it is edited.

```sh
node pipeline/scene-roi.mjs <scene> --roi <dataset>/roi/region6.json [--part <id>]... [--overwrite] [--dry-run]
node pipeline/scene-roi.mjs <scene> --off [--part <id>]...
```

- **Snapshot.** A region file outside the repo is copied to `assets/roi/<scene>/` first, and each selected part (all by default) gets `roi` pointing at the copy.
- **Sanity check.** The command prints the share of each part's sampled splats inside the region.
- **Crop rule.** The build keeps only splats whose centre is inside the region's top-level prism. That is the outline extruded over `center ± half_height`, read by `lib/roi.mjs`. The `editor` outlines are ignored.
- **Rotation.** Only near-identity rotations have been seen, so the direction of the rotation is unverified. A rotated region prints a warning.
- **With a partition.** A part can also have a `partitionPart`. A splat then has to pass both crops.
- **Rebuilds.** The build records a digest of the region geometry, so editing the region rebuilds the part, while changes to editor-only data do not.

- **Picking outlines.** One region file often holds every variant drawn, as the outlines of its `editor` block, with different ones enabled for each training. `--outline "<name>"` (repeatable) crops to those outlines' union instead of the top-level region. The part records them as `roiOutlines`; an older single `roiOutline` is read as a one-item list. A top-level `union` region (several outlines enabled at once) is read too. Copying a re-saved file compares the whole file, outlines included.
- **In the editor.** Drop the region `.json` on the Parts panel, or use **Load regions…**. It is copied to `assets/roi/<scene>/` and becomes the scene's `roi`. Each part row then shows the file's outlines as numbered **Areas** checkboxes: tick the ones the part was trained on. A part with none ticked is built whole, and a part's own `roi` overrides the scene's. Dropping a newer save of the same file replaces the copy and names the outlines whose shape changed; parts using those outlines rebuild. A chip outlined in yellow is ticked for more than one part, so that area draws twice.
- **Splat size reveals the training region, opacity doesn't.** Splats outside the region are drawn with a training weight of 0.0001, so they keep large sizes. In roiTest the median splat size inside vs outside its own outline was 0.1 vs 1.6 mm for ROI1, 0.4 vs 1.6 mm for ROI2 and 0.7 vs 2.0 mm for ROI3. Opacity was misleading.

roiTest: ROI1/2/3 use region6.json Outlines 1/2/3. Kept 480,358 of 970,967, 609,850 of 997,535 and 864,660 of 998,526 splats; 0.2 s of crop per part.

## Splitting a merged file (`partition-split.mjs`)

Fallback for when only Spirula's merged `.ply` exists. It needs the scan's
partition (`partition.json` + `partition.bin`, copied to
`assets/partitions/<scan>/`; the `.bin` is gitignored):

```sh
node pipeline/partition-split.mjs assets/source_ply/OculusMerged_1.ply \
  --partition assets/partitions/OculusV1/partition.json --out-dir assets/source_ply/parts/OculusV1 [--prefix part] [--overwrite]
```

Every splat goes to the part of its **nearest partition point** (k-d tree over
the labelled points). Two streaming passes over the `.ply` (label, then write)
keep RAM at the partition data + 1 byte/splat of labels + 32 MB read / 8 MB
write buffers, never the file itself. Each output keeps the input header byte
for byte except the vertex count, and the records unchanged in file order.
It writes `<prefix><k>.ply` plus `<prefix>-split-report.json`: per-part
counts, the share of splats labelled differently from their back-to-back
block in the file (Spirula writes the parts in order), the label mix per
tenth of the file and nearest-point distance percentiles.

On `OculusMerged_1.ply` (665 MB): part0 935,155, part1 936,798, part2
939,618 = 2,811,571 splats; 0.36 % disagree with file order (ring overlap at
the block ends); nearest-point distance p50 0.9 mm, p99 4 cm; 10 s, 127 MB RSS.
Inputs must be binary little-endian with a single `vertex` element (standard
training output); ASCII and PlayCanvas compressed `.ply` are refused.

**`partition.bin` layout.** There is no published spec; this was
reverse-engineered from one file (OculusV1, 28,496,397 bytes), so
`lib/partition.mjs` checks every field and fails with a clear message
otherwise. Little-endian:

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | char[4], u32 | `"SSPT"`, version 2 |
| 8 | char[4], u32 | `"SSLF"`, version 1 |
| 16 | u64 | N, point count (733,309) |
| 24 | u32 | M, node count of the tree below (262,143) |
| 28 | u32 | unknown (0) |
| 32 | N × 16 B | f32 x, y, z; u8 part label (0..num_parts-1); 3 bytes, probably RGB |
| 32 + 16N | M × 32 B | BVH over the points: f32 min[3], i32 a, f32 max[3], i32 c (leaf: c = count ≤ 6, a = first point; inner: c = 0, a = child) |
| after | rest (~8.4 MB) | starts with u64 frame count (1240), then floats; unknown, not read |

Points are in the training frame of the merged `.ply` (bbox (-5.81, -7.54,
-3.26) .. (2.61, 3.17, 10.94) for OculusV1). `partition.json` (`format:
"spirula-scene-partition"`, `version: 1`) holds `num_parts`, `num_points`,
`frame_names[]`, `frame_parts[]`, `parts[{core, points, ring}]` and `binary`.
The splitter uses only the point records; the BVH is ignored (we build our
own k-d tree).

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

The tests use synthetic files written to the OS temp directory and never touch the repo. They cover argument parsing, the dependency check, the `.ply` reader (binary 3DGS layout, CRLF headers, buffer-boundary reads, a 200k-splat file, NaN positions, truncated files, ASCII, PlayCanvas compressed), the `.sog` meta reader, and dry runs. An end-to-end run uses a stand-in `build-lod` script that follows the real tool's CLI contract (outputs written beside the input, `Comment:` stats block, exit 0 on decode failure), so staging, output collection, reports, version handling and failure detection are all exercised without Rust. `transform.test.mjs` checks the Align bake against three.js (see above); it uses `three` 0.186.1 as a dev dependency. `scene.test.mjs` covers the scene schema (schema 1 -> 2 migration, the multi-part load plan, the preview cap) and `build-scene.mjs` end to end: single and multi-part builds, sequential order, incremental reuse, `--part`, `--force`, a failure in part 2 of 3 keeping the previous build, disabled/removed parts and a schema-1 flat build. `partition.test.mjs` writes a synthetic partition (same binary layout) and merged `.ply` and checks the reader's validation, the k-d tree against brute force, and that the split keeps headers and records byte for byte.

## Known caveats

- **Memory.** `build-lod` decodes the whole input into memory before building the tree. This happens in `process_file_lod_tsplat`, and there is no streaming or out-of-core mode (about 400 B/splat at peak: 2.8M splats peaked at 1.1 GB; the 19.7M-splat `mergedOpenSiliconLab.ply` crashed). Use multi-part scenes (above): each part is built on its own, so peak memory follows the largest part.
- **Peak memory is best-effort.** On Windows a PowerShell loop samples the kernel's `PeakWorkingSet64` and `PeakPagedMemorySize64` once a second. On Linux the pipeline reads `VmHWM`; on macOS it polls `ps` RSS. Because the Windows counters are peaks kept by the OS, only growth in the final second can be missed. A process that exits in under about 1 second, before PowerShell starts, records `null`.
- **Recentring** is not automatic. `build-lod` can crop but has no translate option. Use Align mode + `transform.mjs` (above) before the build. In v2.3.1 the RAD file stores centres as f32, but Spark's default paged pool stores them at half precision at runtime, so far-off coordinates stripe. The pipeline only warns about this for now (using the f16 step at the farthest coordinate). The Phase 2 cleanup step must recentre the model before the build.
- **`--max-sh=1`** (the default) drops SH degrees 2 and 3. Whether that is acceptable is still an open visual-check question in the scope.
  - **Keeping more SH.** A scene can keep more with `buildOptions.maxSh` (0–3) in `scene.json`, or the **SH** selector at the bottom of the editor's Parts panel. Spirula trains degree 3. Changing it rebuilds every part, because the build-lod flags are part of the reuse check.
  - **Cost.** SH 3 stores 45 SH values per splat instead of 9, so the SH data on disk grows about 5×. In the viewer's streaming pool each splat takes 96 B instead of 48 B with full-precision splats, about 3.2 GB for the 512-page desktop default.
  - **What it changes.** SH only adds view-dependent colour (sheen, reflections), not geometric sharpness.
- **SOG input** works directly, but its quality is capped by PlayCanvas's quantisation. If the source `.ply` is lost and conversion is needed, PlayCanvas `splat-transform` can turn SOG back into `.ply`, but nothing is gained compared with feeding the `.sog` directly.
- **Windows long paths.** `setup` clones with `core.longpaths=true`. Keep the project path short.
- **`build-lod` GPU feature.** The default build enables `wgpu`, which is only used by the optional `--cluster-sh`. It compiles on a standard MSVC toolchain, and the pipeline does not use that flag.
