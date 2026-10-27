# Streaming vs splat count: why the current build chugs (2026-10-23/24)

**Answer: streaming.** With the same renderer, view and orbit, and the same number of splats
drawn (~6.9M), the single 10M file runs at 256 fps with a 6 ms p99 frame. The streamed build
runs at 110–120 fps with a 140–210 ms p99 frame and 60–87 hitches per 20 s. Lowering the
streamed budget to 5M doesn't help. Keeping everything cached doesn't help either. Results
are below.

Prompted by the SuperSplat scene https://superspl.at/scene/15a202e6 (Parish Church of Saint
Maurice): **9,975,598 splats in one SOG file**, SH 3, 141 MB, no LoD (`meta.json`, not
`lod-meta.json`). It loads once and draws every splat, and it runs smoothly on this machine.
Our build draws at most 10M of 44.5M through streamed LoD, downloads ~1 GB per view and
hitches. Is our chug splat count, or the streaming?

## What we already know

From `../2026-10-23-spark-vs-gsl` (GSL on WebGPU, current build, GPU free): 120–150 fps
average, but **60–80 hitches per 20 s orbit, p99 frame 120–190 ms**, and 1.8–2.4 GB
re-downloaded during the orbit. A longer cooldown cut hitches by a quarter to a third.
Other knobs did nothing. What was missing is a control with the same renderer and views but
no streaming.

## Arms

Same driver as the Spark/GSL report (`../2026-10-23-spark-vs-gsl/bench-renderers.mjs`):
fresh Chrome profile, vsync off, 1600x900, pixel ratio 1, viewpoint
`cam=0,1.6,4&target=0,1.2,0`, load until settled, then the viewer's 20 s orbit
(`window.bench`). GSL on WebGPU throughout.

| Arm | What | Streams? |
| --- | --- | --- |
| A streamed 5M | HighRezOculus, 5M budget (published default) | yes |
| A streamed 10M | HighRezOculus, 10M budget | yes |
| A streamed 10M, no release | same, `gslCooldown=600000`: nothing released in the orbit, so no re-download | loads only |
| single SOG 4M | HighRezOculus merged to 4.02M (arm F of `../2026-10-23-lowcap-retrained-lod`), 63 MB | no |
| single SOG 10M | HighRezOculus merged to 9.91M, SH 3, **168 MB** (the church: 141 MB) | no |

The single files are merges (blurry, see arm F), which doesn't matter here: this measures
frame time and memory, not looks. Their merged splats are larger than trained ones, so if
anything they cost more fill rate than a trained model of the same count.

Build the single files (CPU only, ~2 min each to merge, ~2 min to pack):
`node reports/benchmarks/2026-10-23-lowcap-retrained-lod/run.mjs downsample 10000000` ·
`... pack downsampled-10000k` (the 4M one is `downsample` · `pack downsampled`).

Run (dev server on :5174, **GPU free: no training, Spirula closed**), ~6 min:

    node reports/benchmarks/2026-10-23-streaming-vs-count/bench.mjs reports/benchmarks/2026-10-23-streaming-vs-count/runs.json 2

## Read it as

- **Single SOG 10M smooth, A streamed 10M not** → the chug is streaming. Options: ship
  single files (desktop 4–10M, phones a smaller level), or keep LoD and stop the churn
  (cooldown, fewer, bigger levels).
- **A 10M "no release" ≈ single SOG** → it is the release/re-download churn. **Still
  hitchy** → GSL's page streaming itself.
- **Single SOG 10M also hitchy** → count (sort/fill) matters too, and the 5M budget is right.

## Results

Run 2026-10-24 04:15–04:22, started automatically 20 s after the L0 training exited. RTX 5080
at 0% load; 7.4 GB of VRAM was held by something other than Spirula (no Spirula process
running). Two repeats per arm, raw data in `runs.json`. Both repeats are shown as "#1 / #2".

| Arm | Settled | Downloaded (load + orbit) | Drawn in orbit, avg (min–max) | Avg fps | 1% low fps | p99 frame | Hitches / 20 s | GSL resident GPU | Process GPU / private |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A streamed 5M | 8.7 / 4.4 s | 1.74 / 1.59 GB | 4.8M (3.4–7.5) | 128 / 129 | 2.7 / 2.8 | 209 / 125 ms | 85 / 87 | 3.0–3.2 GB | 3.8–3.9 / 10.0–10.5 GB |
| A streamed 10M | 8.3 / 4.0 s | 1.73 / 1.74 GB | 6.6–6.8M (4.2–10.2) | 116 / 120 | 2.1 / 2.4 | 187 / 142 ms | 60 / 77 | 3.5 GB | 4.3–4.4 / 11.3 GB |
| A streamed 10M, no release | 5.8 / 5.9 s | 1.73 / 1.74 GB | 6.9–7.0M (5.0–10.2) | 110 / 119 | 2.4 / 2.9 | 207 / 209 ms | 87 / 85 | 3.6 GB | 4.6 / 11.5–11.6 GB |
| single SOG 4M | 0.9 / 0.9 s | 66 MB | 3.4M (2.5–4.0) | 324 / 324 | 30.1 / 29.9 | 4.5 / 4.7 ms | 5 / 3 | 0.4 GB | 1.3 / 3.0 GB |
| **single SOG 10M** | **1.0 / 1.0 s** | **175 MB** | **6.9M (4.3–9.9)** | **256 / 256** | **6.6 / 7.7** | **5.7 / 5.9 ms** | **14 / 14** | **1.0 GB** | **2.9–3.0 / 6.3 GB** |

"Drawn" is splats in view, so a 10M file draws 4.3–9.9M as the orbit turns. The streamed
10M budget and the 10M file draw the same ~6.9M on average, so the comparison is fair.

Findings:

- **Count isn't the problem.** Drawing ~6.9M splats from one resident file gives a 6 ms p99
  frame, about 170 fps even in the slowest 1% of frames. The streamed build drawing the same
  count has a p99 of 140–210 ms, 25–35x worse.
- **The streamed budget barely matters.** The 5M budget is no smoother than 10M (85–87
  hitches, p99 125–209 ms) and only 10% faster on average. The 5M desktop default costs
  sharpness and buys almost nothing in smoothness.
- **Release churn isn't it either.** With a 10-minute cooldown (`gslCooldown=600000`) nothing
  is released in the orbit, yet it downloads the same 1.73 GB and hitches as much (85–87).
  The 20 s orbit keeps reaching detail it hasn't loaded yet. The hitches come from loading
  and uploading new pages, not from re-downloading released ones. This matches the earlier
  finding that GSL's page streaming can't be tuned from outside.
- **Memory:** the single 10M file holds 1.0 GB on the GPU (process total 2.9 GB, private
  6.3 GB). The streamed 10M build holds 3.5 GB (4.4 / 11.3 GB). It downloads 175 MB once,
  against ~1.7 GB for one view and one orbit.
- **Every arm has one frame of ~0.65–1.4 s**, including the 4M file, which has nothing to
  stream. It is likely a one-off at the start of the orbit, not streaming. Not
  investigated. The 10M file's 14 hitches against the 4M file's 3–5 suggest some cost from
  count (sorting 10M), still far below the streamed arms.

So for desktop: a single resident file of up to ~10M splats is smooth on this GPU, loads in
1 s and fits 1 GB of VRAM. What a single file can't do is go above ~10M or serve phones;
those need a smaller file (or LoD levels that are whole files, as the SuperSplat reference
does) rather than page streaming. This machine has a high-end GPU (RTX 5080), so run the
same comparison on a mid-range laptop and a phone before picking a desktop count.

### Smoke run during training (superseded)

One "single SOG 10M" run with the GPU at 94% for the training: 167 fps, p99 16.9 ms,
18 hitches. The free-GPU numbers above replace it.
