# Why the online HighRezOculus looks blurry (2026-10-23)

Compared with the SuperSplat reference https://superspl.at/scene/a6df26f1 (1.6M splats, 57 MB).

## What the reference actually is

From its `lod-meta.json` / SOG `meta.json` (PlayCanvas streamed LoD, splat-transform 1.10.2):

| LoD | Splats |
| --- | --- |
| 0 (finest) | 1,577,593 |
| 1 | 750,000 |
| 2 | 375,000 |
| 3 | 187,500 |

The coarser levels are exactly 1/2, 1/4, 1/8 of 1.5M: each was made with "sparsify and
retrain" (their credits: LichtFeld Studio, MCMC, Mip filter, PPISP, ~4000 photos). The
finest level is the whole model, so at any view the viewer can draw every splat, and every
splat was optimised for that count. All four levels together are 57 MB.

Ours: 4 parts trained to a 12M cap each (44.5M after ROI crop, 60M nodes after build-lod),
2.8 GB of `.rad`/`.radc`, SH3. build-lod's coarser nodes are geometric merges of the
leaves (Bhatt LoD), not retrained.

## Budget A/B (local dev server, GSL WebGPU, 1600x900, pixelRatio 1)

`shots.mjs`, raw numbers in `runs.json`. "Unconstrained" = `lodScale=16` (40M budget), so
GSL refines until splats reach its 1 px threshold.

| View | Published budget (5M) | Unconstrained demand at 1 px |
| --- | --- | --- |
| start (`cam=0,0,0`) | every part capped at 1.25M | 14.2M |
| near the shop shelves | every part capped at 1.25M | 13.1M |
| atrium (glass, floor) | every part capped at 1.25M | 9.5M |

- `near-5M-vs-unconstrained.png`: at 5M the box labels and the tote's "ArtScience Museum"
  are unreadable; at 13M they are readable. The detail is in the trained model and the
  build; the runtime budget throws it away.
- `start-1.5M-5M-unconstrained.png`: 1.5M (the iPhone budget), 5M, 14M on the same crop.
- `glass-floor-5M-vs-unconstrained.png`: glass and the reflective floor stay soft even
  unconstrained, so those are limited by training (view-dependent / transparent
  surfaces), not by the budget.

## GSL LoD resolution ignores the pixel ratio

`src/gsl.ts` calls `stream.setResolutionFromRenderer(camera, renderer)`, which uses
`renderer.getSize()` (CSS pixels). The start view demanded exactly 14,206,874 splats at
pixelRatio 1 and at pixelRatio 2, so on a DPR-2 screen LoD stops at about 2x2 device
pixels. It only matters once the budget stops being the limit.

## Training images

1,727 Insta360 X6 dual-fisheye stills (7776x3888, i.e. 3888x3888 per lens), 3,426 training
images after the lens split. Spectral check (`Spec.cs`, `spectra.csv`; 1D power spectrum of
the image centre against a power law fitted on 0.02-0.08 cycles/px) on 288 frames: the
spectrum is 6 dB below the fit at a median of 0.425 cycles/px (p10 0.27), i.e. the images
are sharp to about the pixel. 17 of 288 sampled frames (6%) are soft (< 0.25), 7 (2.4%)
very soft (< 0.18).

The limit is angular resolution, not blur: about 20 px/degree across a ~195° fisheye,
against ~17.6 px/degree for a 1600-px-wide viewer at 60° vertical FOV (91° horizontal). That
is enough at the capture positions and DPR 1. It is not enough for close-ups well inside the
capture distance or for DPR-2 screens. A 24 MP camera with a 24 mm lens gives ~80 px/degree.

## Online (live site)

Same script against https://oculussplat-test.exhib-splat-project.workers.dev (cold
profile, published defaults: GSL, 5M):

| View | Settled | Downloaded to settle | Resident GPU |
| --- | --- | --- | --- |
| start | 25.3 s | 1,104 MB | 2.35 GB |
| near | 22.7 s | 1,033 MB | 2.15 GB |

That is on this machine's connection. At 100 Mbit/s, 1.1 GB takes about 90 s, and at
50 Mbit/s about 3 minutes. Until then the visitor sees coarse LoD. The settled picture is
the same 5M picture as locally. One view costs about 19x the reference's whole scene (57 MB).

## Hypotheses and confidence

| # | Hypothesis | Verdict | Confidence |
| --- | --- | --- | --- |
| 1 | The runtime splat budget is far below the model's demand, so LoD shows merged parents | Confirmed: every part capped; demand 9.5-14M vs 5M desktop, 1-1.5M phones; the unconstrained render is sharp | ~85% main cause of static blur |
| 2 | The model is over-provisioned ("too high a resolution": 4 x 12M for one space) | Yes, read as "denser than any client can draw or download". The density does not blur anything itself. It forces heavy decimation and a 2.8 GB payload | ~70% |
| 3 | Merge-based LoD (build-lod, no retrain) is lossier than a model trained at that count | Not measured here. It matches how the reference was built (sparsify + retrain) | ~60% |
| 4 | Streaming/RAD: online users see coarse LoD while ~1.1 GB per view downloads | Confirmed for the first 30 s to 3 min per area, and after moves (detail is released after `cooldownMs`) | ~60% main cause of what online visitors see; ~15% of settled blur |
| 5 | Training image quality | Images are pixel-sharp (6% soft frames). Angular resolution (~20 px/deg) caps close-ups and DPR-2 | ~10% for current blur; caps the ceiling |
| 6 | Glass, reflective floor | Soft even unconstrained: limited by training | Local, not budget |
| 7 | GSL LoD in CSS px on hi-DPI | Confirmed in code and by identical demand. Hidden while budget-limited | Low today |
