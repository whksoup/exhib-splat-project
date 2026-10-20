# Gaussian Splat Virtual Tour — LOD Streaming

Web-hosted Gaussian splat virtual tour streaming a 40–50M splat model to desktop, mobile, and Quest 3 browsers, built on Spark 2.0 + three.js.

Full scope: [docs/Project_Scope.md](docs/Project_Scope.md)

## Folder layout

- `docs/` — scope doc and other written project docs
- `pipeline/` — .ply → .RAD processing scripts (build-lod)
- `viewer/` — v1 prototype viewer, frozen (tag `v0.1-prototype`, port 5173)
- `viewer-v2/` — current viewer and scene editor (port 5174)
- `scenes/` — scene save files: `<name>/scene.json`, `nav/`, `build/` (build output gitignored)
- `shared/` — scene.json schema shared by the viewer and the pipeline
- `hosting/` — CDN / object storage config (CORS, Range, cache rules)
- `assets/source_ply/` — trained .ply source scans (not committed if large — see .gitignore); part files in subfolders, e.g. `parts/<scan>/part0.ply`
- `assets/partitions/<scan>/` — Spirula Studio `partition.json` (committed) + `partition.bin` (gitignored)
- `assets/rad_output/` — built .rad/.radc chunk output
- `reports/` — performance test results, go/no-go notes
- `research_notes/` — Spark/PlayCanvas research, benchmarks

## Scenes

A scene is the save file for one tour model: `scenes/<name>/scene.json`
(its source **parts**, alignment transform, floor, navigation, start camera,
build record), `scenes/<name>/nav/` (plan exports, collision GLB) and
`scenes/<name>/build/` (one streamed `.rad` + `.radc` set per part in
`build/<part>/`, regenerated). Sources stay in `assets/source_ply/` and are
never copied or modified; every build starts from the original sources with
the scene's transform.

**Multi-part scenes.** Large scans are trained in Spirula Studio in spatial
parts, so no single machine has to hold the whole model. Keep them as parts
all the way: one scene, several part sources in the same coordinate frame,
**one** transform for all of them, built **one part at a time** (`build-lod`
needs ~400 B/splat of RAM at peak, so a 19.7M-splat merge does not fit, a
part does), and each part streamed as its own paged `SplatMesh`. Spark sorts
all meshes together, so there is no seam between parts.

```sh
cd viewer-v2 && npm run dev        # http://localhost:5174: scene list -> New scene (pick one or several files) / Open
build-scene.bat <name>             # same build as the in-app Build button (repo root); --force, --part <id>
node pipeline/new-scene.mjs <name> --source assets/source_ply/parts/<scan>   # a folder, files or a glob: one part each
node pipeline/partition-split.mjs <merged.ply> --partition assets/partitions/<scan>/partition.json --out-dir assets/source_ply/parts/<scan>
```

Workflow (details in [viewer-v2/README.md](viewer-v2/README.md#scenes-the-editing-workflow)):
Spirula part exports into `assets/source_ply/parts/<scan>/` (or split a merged
file with `partition-split.mjs`), new scene with all parts, align once (moves
every part), save, build (sequential, incremental: unchanged parts are
reused), plan export, draw colliders in Rhino/Blender, pick the collision
GLB, set spawn, walk. Pipeline details: [pipeline/README.md](pipeline/README.md#scenes-build-scenemjs).

## Open questions (from scope doc, pending kick-off)

- [ ] Quest VR required at launch, or best-effort acceptable?
- [ ] Team / allocation
- [ ] Start date
- [ ] Reference device set (oldest iPhone, Android model)
- [ ] Hosting/CDN provider
- [ ] Are scans georeferenced (large coordinates)?
- [ ] SH capped at level 1 acceptable after visual check?
- [ ] Who owns hotspot content?

## Dependencies

- Rust toolchain on the build machine (`build-lod`)
- High-memory build machine (size in week 1)
- CDN/object storage account with Range + CORS control
- Test devices: Quest 3, iPhone, Android phone, desktop
