# Gaussian Splat Virtual Tour — LOD Streaming

Web-hosted Gaussian splat virtual tour streaming a 40–50M splat model to desktop, mobile, and Quest 3 browsers, built on Spark 2.0 + three.js.

Full scope: [docs/Project_Scope.md](docs/Project_Scope.md)

## Folder layout

- `docs/` — scope doc and other written project docs
- `pipeline/` — .ply → .RAD processing scripts (build-lod)
- `viewer/` — three.js + Spark web viewer (tour layer, hotspots, WebXR)
- `hosting/` — CDN / object storage config (CORS, Range, cache rules)
- `assets/source_ply/` — trained .ply source scans (not committed if large — see .gitignore)
- `assets/rad_output/` — built .rad/.radc chunk output
- `reports/` — performance test results, go/no-go notes
- `research_notes/` — Spark/PlayCanvas research, benchmarks

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
