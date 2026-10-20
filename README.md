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
- `assets/source_ply/` — trained .ply source scans (not committed if large — see .gitignore)
- `assets/rad_output/` — built .rad/.radc chunk output
- `reports/` — performance test results, go/no-go notes
- `research_notes/` — Spark/PlayCanvas research, benchmarks

## Scenes

A scene is the save file for one tour model: `scenes/<name>/scene.json`
(source reference, alignment transform, floor, navigation, start camera,
build record), `scenes/<name>/nav/` (plan exports, collision GLB) and
`scenes/<name>/build/` (the streamed `.rad` + `.radc`, regenerated). Sources
stay in `assets/source_ply/` and are never copied or modified; every build
starts from the original source with the scene's transform and replaces
`build/`.

```sh
cd viewer-v2 && npm run dev        # http://localhost:5174: scene list -> New scene / Open
build-scene.bat <name>             # same build as the in-app Build button (repo root)
node pipeline/new-scene.mjs <name> --source assets/source_ply/<file>.ply   # or create one from the command line
```

Workflow (details in [viewer-v2/README.md](viewer-v2/README.md#scenes-the-editing-workflow)):
new scene, align, save, build, plan export, draw colliders in Rhino/Blender,
pick the collision GLB, set spawn, walk.

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
