# Hybrid LoD: A near, B far (option 3, 2026-10-24)

One streamed SOG (`lod-meta.json`) with two levels:

- **Level 0 (finest):** A, HighRezOculus's 4 parts. 44.5M splats, each part cropped to its
  outline pair exactly as A's build does (same kept counts).
- **Level 1:** B, the 4M whole-room run (`../2026-10-23-lowcap-retrained-lod`), cropped to
  all 8 outlines.

Both are baked into scene coordinates, which GSL 1.4.0 needs for SOG streams (see the
lowcap README). GSL's `SogStreamScheduler` picks a level per chunk by distance. In its
default "target" mode it widens the distance bands until the splat budget is full, so chunks
near the camera should draw A and the rest B. Chunks are ~4 m wide (`--lod-chunk-extent 4`;
the default of 16 m would be a quarter of the room per chunk).

## What to look for

- **Near detail:** does it match A unconstrained, e.g. the box labels on the `near` view of
  `../2026-10-23-blur-diagnosis`?
- **Seams.** A and B were trained separately, each with its own per-photo colour correction
  and floaters. Where an A chunk meets a B chunk, and as chunks switch while moving, look for
  colour shifts, edges and popping. This is the main risk. If seams show, the fix is coarse
  levels made from A (merge, then retrain) instead of an independent B.
- **Cost:** download per view and settle time, against A (~1.1 GB, 4-5 s locally) and B
  (~200 MB, ~2 s).

## Run

```
node reports/benchmarks/2026-10-24-hybrid-lod/run.mjs prep   # done: Hybrid-A-<part>-scene.ply
node reports/benchmarks/2026-10-24-hybrid-lod/run.mjs pack   # GPU SOG compression, pack.log
```

A first pack with `-g cpu`, run alongside the Mid12M training, was stopped after 6.5 h: its SH
k-means had got through 1 of 78 files. The pack now runs on the GPU and is queued after the
Mid12M training.

View at `http://localhost:5174/?config=/models/Hybrid/ab/viewer.json`.

## Results (2026-10-25)

Packed on the GPU in 14.3 min: 78 chunk files, **833 MB** in total (A's RAD build is 2.8 GB).
The comparison used `../2026-10-23-lowcap-retrained-lod/compare.mjs`: fresh Chrome profile,
GSL WebGPU, 1600x900, 6 views x 2 budgets. Raw numbers are in `shots/results.json`, crops in
`shots/sheet-<view>-<budget>.png`.

Per view, ranges over the 6 views:

| Arm | Budget | Drawn | Downloaded | Settled | GPU |
| --- | --- | --- | --- | --- | --- |
| A (current, 44.5M RAD) | 5M | 4.7-5.0M | 863-1,184 MB | 3.8-4.5 s | 1.8-2.5 GB |
| B (LowCap 4M RAD) | 5M | 1.0-2.0M | 144-242 MB | 1.7-2.6 s | 0.3-0.5 GB |
| Mid12M (4 x 3M RAD) | 5M | 2.1-4.1M | 285-525 MB | 2.1-3.5 s | 0.7-1.2 GB |
| **Hybrid (A + B SOG)** | 5M | 4.7-4.9M | **134-157 MB** | **1.5-1.8 s** | 0.7-0.9 GB |
| A | 1.5M | 1.5M | 444-593 MB | 1.7-2.4 s | 1.0-1.3 GB |
| B | 1.5M | 1.0-1.5M | 144-226 MB | 1.6-2.4 s | 0.3-0.5 GB |
| Mid12M | 1.5M | 1.5M | 271-363 MB | 1.4-1.9 s | 0.6-0.8 GB |
| Hybrid | 1.5M | **1.3-3.4M (over budget)** | 50-75 MB | 0.9-1.0 s | 0.3-0.4 GB |

- **Sharpness at 5M:** the hybrid is the sharpest of the four at close range. On the `near`
  view, the tote's "ArtScience Museum" and the box labels are crisp, sharper than A's own 5M
  render, which is merged down from 44.5M. Mid12M is next, then B, then A.
- **Seams:** none visible in the static views. A soft patch in the `start` view is the glass
  display case, equally soft in Mid12M. Chunk switching while moving (popping, colour jumps
  between A and B chunks) has not been checked: walk the scene.
- **Phone budget:** the hybrid overshoots 1.5M by up to 2.3x, because its coarsest level is
  B's whole 4M. It needs coarser levels (B merged and retrained to 2M / 1M / 0.5M, the L1-L3
  steps of the lowcap plan) to meet a 1-1.5M budget.
- **Download:** SOG is ~6x smaller per view than A's RAD, and settles in under 2 s locally.
  At 50 Mbit/s that is ~20-25 s per view, against ~2.5-3 min for A.
- **Seams while walking (user check, 2026-10-25):** fine.

## Frame cost (2026-10-25)

`bench.mjs`: the orbit benchmark of `../2026-10-23-streaming-vs-count` (fresh profile, vsync
off, 1600x900, 20 s orbit), on an RTX 5080, one run each, raw data in `bench.json`.
"Mid12M single SOG" is Mid12M's 9.84M splats packed as one SOG level (`run.mjs pack-sog` in
`../2026-10-24-mid12m-parts`): **171 MB** for the whole room, loaded once, nothing streams.

| Arm | Budget | Drawn (orbit avg) | Avg fps | p99 frame | Hitches / 20 s | Process GPU |
| --- | --- | --- | --- | --- | --- | --- |
| Hybrid (streamed SOG LoD) | 5M | 5.2M | 199 | 122 ms | 81 | 3.8 GB |
| Hybrid | 2M | 2.7M | 340 | 38 ms | 77 | 1.9 GB |
| Hybrid | 1M | 2.3M (over budget) | 417 | 16 ms | 72 | 1.5 GB |
| Mid12M RAD (streamed build-lod) | 5M | 2.5M | 246 | 66 ms | 63 | 1.6 GB |
| Mid12M RAD | 2M | 1.9M | 278 | 26 ms | 59 | 1.4 GB |
| Mid12M RAD | 1M | 1.0M | 322 | 13 ms | 51 | 1.1 GB |
| **Mid12M single SOG** | (all) | 6.4M | 238 | **6 ms** | **9** | 2.8 GB |

Streaming is what hitches, whichever format: both streamed arms hitch 50-80 times per orbit,
and the single file 9 times while drawing the most splats. That matches the 10M single-file
arm of `../2026-10-23-streaming-vs-count` (6 ms p99, 14 hitches).
