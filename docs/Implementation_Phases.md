# Implementation Phases

Each phase ends with a human review checkpoint. Work is committed per phase so it can be reviewed as a git diff.

## Phase 1: Foundation and week-1 go/no-go spike
- `pipeline/`: script that turns a .ply (or .sog, if `build-lod` accepts it) into chunked .rad/.radc with `--quality --rad-chunked --max-sh=1`, logging build time and peak memory
- `viewer/`: Vite + three.js + Spark 2.x (pinned version), `SparkRenderer` + paged `SplatMesh`, per-device splat budgets, a performance overlay (fps, splats drawn, time to first frame), model chosen with a URL parameter
- `hosting/`: CORS and cache rules, a local server that supports Range requests, and a smoke-test script for Range/CORS/cache headers

**Checkpoint 1 (go/no-go):** run the test model through the pipeline, then open it on desktop, phone and Quest 3. Record build time and memory, first frame, time to full detail, and fps in `reports/`. Decide whether to continue with Spark or compare against PlayCanvas Streamed SOG.

## Phase 2: Pipeline hardening and hosting
- Cleanup step: crop, remove floaters, recentre near the origin
- Optional split into one .rad per zone
- Versioned output paths and a deploy script for the chosen CDN (needs the provider decision)
- One scripted run from new model to live tour

**Checkpoint 2:** test against the real CDN; visual check of SH level 1 and recentring.

## Phase 3: Tour features
- Hotspots from a JSON config, animated moves between viewpoints, info panels, loading states
- Tune detail catch-up after camera moves (foveation, transition timing)

**Checkpoint 3:** walk through the tour with real hotspot content (due at the start of week 3).

## Phase 4: WebXR, performance, handover
- Quest 3 mode through `SparkXr` (best-effort): budget, `maxStdDev`, render scale, foveation
- Performance pass on all reference devices against the success criteria
- Handover docs for the pipeline and viewer

**Checkpoint 4:** final acceptance against the success criteria table.
