# Gaussian Splat Virtual Tour — LOD Streaming Project Scope

Oct 20, 2026 · @ka

## Summary

In four weeks we will ship a web-hosted Gaussian splat virtual tour that streams a 40–50M splat model to desktop, mobile and Quest 3 browsers, built on Spark 2.0 and three.js.

We use Spark's existing level-of-detail (LoD) system rather than a custom format. Each model is pre-processed once into a streamable .RAD file; the browser downloads only the detail the current view needs and renders a fixed splat budget per device.

Desktop and mobile are the committed targets. Quest 3 VR through WebXR is best-effort: browsers cannot use Quest's frame-doubling (ASW), so a locked 72 fps is not promised in this phase.

## Goals and success criteria

The project succeeds if a 40–50M splat model opens in seconds and stays smooth on every reference device. The targets below are proposals to confirm at kick-off.

| Criterion | Proposed target | How we measure it |
| --- | --- | --- |
| Largest model supported | 40–50M source splats | Our largest real model, end to end |
| First visible frame | 3 s or less on a 50 Mbps connection | Stopwatch from page load, cold cache |
| Full detail at the start viewpoint | 15 s or less | Visual check plus network log |
| Desktop frame rate | 60 fps | Browser performance overlay |
| iPhone and Android frame rate | 30 fps or more | Same tour route on each phone |
| Quest 3 (WebXR) frame rate | 72 fps goal, 45 fps floor, best-effort | Quest performance overlay |
| New model to live tour | One scripted run, same day | Timed run on the build machine |

## Scope

We build the pipeline, hosting and viewer around off-the-shelf Spark; anything needing a custom renderer or native app is out.

**In scope**

- Processing pipeline: trained .ply to chunked .RAD, as a repeatable script
- Hosting setup: object storage and CDN configured for streaming
- Web viewer: three.js plus Spark 2.x, with per-device splat budgets
- Tour features: hotspots, guided moves between viewpoints, info panels, loading states
- WebXR mode for Quest 3, best-effort
- Performance testing on reference devices
- Handover documentation for the pipeline and viewer

**Out of scope**

- Custom splat file format or renderer
- Native Quest app, including ASW frame doubling
- Capturing or training new scans; we assume finished .ply files are provided
- A visual editor for hotspots; hotspots live in a JSON config file
- User accounts, analytics, multi-user sessions and offline mode

## Technical architecture

The raw .ply is never served: an offline step turns it into a chunked LoD file, and the browser streams only the chunks the current view needs.

&#91;embedded content: pipeline and runtime · offline build, CDN, browser\]

The offline row runs once per model; at runtime the browser pulls chunks from the CDN as the camera moves.

1. **Source.** Trained .ply with full spherical harmonics, about 248 bytes per splat, so roughly 12 GB at 50M splats.
2. **Clean and recentre.** Crop, remove floaters and move the model near the origin. Spark's compact encoding stores positions at reduced precision, so far-off coordinates cause striping.
3. **Build the LoD tree.** Spark's `build-lod` tool with `--quality --rad-chunked --max-sh=1` writes a small .rad header plus .radc chunk files. Large buildings can be split into one .rad per zone.
4. **Host.** Object storage behind a CDN. It must serve HTTP Range requests, expose the range headers through CORS, and cache chunk files permanently under versioned paths.
5. **Render.** three.js `WebGLRenderer` with antialiasing off, a `SparkRenderer`, and one `SplatMesh` per zone loaded with `paged: true`. Spark picks the best splats for the view within the device budget and keeps them in a fixed GPU pool (16M splats by default).
6. **Tour layer.** Plain three.js for hotspots (from a JSON config), animated camera moves, UI, and WebXR through Spark's `SparkXr` wrapper.

GPU memory and per-frame work stay flat as the model grows; only download size and build time scale with splat count.

## Device targets and splat budgets

Whatever the model size, each device draws only its budget of splats per frame; Quest 3 sees about 1% of a 50M model at once. We start from Spark's platform defaults and adjust with `lodSplatScale` after week 1 testing ([Spark LoD docs](https://sparkjs.dev/docs/lod-getting-started/)).

| Device | Spark default budget (splats on screen) | Commitment | Extra tuning |
| --- | --- | --- | --- |
| Desktop | 2.5M | Committed | None expected |
| iPhone | 1.5M | Committed | Cap pixel ratio if needed |
| Android phone | 1M | Committed | Cap pixel ratio if needed |
| Quest 3 (WebXR) | 500K | Best-effort | `maxStdDev` √5, lower render scale, foveation settings |

The Quest numbers match what others report: a developer with a custom native pipeline shows about 400K splats at once, and another team measured roughly 600K as the Quest 3 ceiling.

## Timeline

Four one-week phases with two checkpoints; the week 1 go/no-go is where we confirm the approach or change course.

&#91;embedded content: four-week plan · 2 gates\]

If week 1 fails on Quest only, we continue with VR as best-effort. If it fails on desktop or mobile, we compare against PlayCanvas Streamed SOG (about one day) before going further.

## Risks and mitigations

The biggest risks are Quest frame rate and the unknown build cost at 50M splats; week 1 tests both before we commit further.

| Risk | Effect if it happens | Mitigation | Checked in |
| --- | --- | --- | --- |
| Quest 3 can't hold 72 fps in WebXR | VR feels choppy in dense areas | VR stays best-effort; tune budget, `maxStdDev` and render scale; native app as a later phase | Week 1, week 4 |
| `build-lod --quality` is slow or runs out of memory at 50M | Pipeline can't process our largest model | Time it on the real model in week 1; use a high-memory cloud machine or split into zones | Week 1 |
| Large or georeferenced coordinates | Striping and jitter artefacts | Recentre during cleanup; switch the page pool to `pagedExtSplats` (doubles memory per splat) only if needed | Week 2 |
| Detail lags after fast camera moves | Blurry view for a moment after jumping between hotspots | Animate transitions instead of instant jumps; tune foveation | Week 3 |
| Spark 2.x is six months old | Breaking changes or bugs | Pin the version; track releases; report issues upstream | Ongoing |
| Mobile Safari memory limits | Tab reloads on older iPhones | Test on the oldest supported iPhone; lower budget for it | Week 1 |
| CDN range or CORS misconfigured | Streaming fails or falls back to full downloads | Smoke test against the real CDN in week 1 | Week 1 |
| Floaters and bad training in the source scan | LoD makes them cheaper, not invisible | Cleanup step in the pipeline; flag scans needing retraining early | Week 2 |

## Assumptions, open questions and dependencies

The plan assumes finished scans and one developer full-time; the open questions below should be settled at kick-off.

**Assumptions**

- Trained .ply files for the tour exist before week 1, including the largest (40–50M) model
- At least one developer works on this full-time for the four weeks
- Hotspot text and media arrive by the start of week 3
- Users reach the tour on recent browsers with WebGL2

**Open questions**

- [ ] Is Quest VR required at launch, or is best-effort acceptable?
- [ ] Who is on the team, and at what allocation?
- [ ] What is the start date?
- [ ] Which exact devices are the reference set (oldest iPhone, Android model)?
- [ ] Which hosting and CDN provider do we use?
- [ ] Are the scans georeferenced (large coordinates)?
- [ ] Is reduced colour detail (spherical harmonics capped at level 1) acceptable after a visual check?
- [ ] Who owns hotspot content?

**Dependencies**

- Rust toolchain on the build machine, needed by `build-lod`
- A build machine with enough memory for the largest model (to be sized in week 1)
- CDN or object storage account with Range and CORS control
- Test devices: Quest 3, an iPhone, an Android phone, a desktop

## References

- [Spark 2.0 new features](https://sparkjs.dev/docs/new-features-2.0/)
- [Spark level-of-detail guide and build-lod tool](https://sparkjs.dev/docs/lod-getting-started/)
- [Spark performance tuning](https://sparkjs.dev/docs/performance/)
- [Streaming 3DGS worlds on the web, World Labs](https://www.worldlabs.ai/blog/spark-2.0)
- [Spark 2.0 launch thread, including the 40M+ Coit Tower demo](https://x.com/sparkjsdev/status/2044090505982816449)
- [World Labs 60M-splat world on Spark 2.0](https://x.com/theworldlabs/status/2049887780449489232?lang=en)
- [Streamed SOG format, PlayCanvas (alternative considered)](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog.md)
- Reddit r/GaussianSplatting, "Optimizing big Gaussian Splatting scenes on Quest 3" (custom native approach, shared as screenshots)
