# Spark vs Gaussian Splat Lite on HighRezOculus (2026-10-23)

Scene `HighRezOculus`: 4 parts, 60M splats after LoD, 2.8 GB of `.rad` + `.radc`,
SH3. The builds are the same for both renderers (Spark `build-lod` v2.3.1).

Machine: RTX 5080 (Chrome 'ANGLE D3D11' for Spark), 64 GB RAM, Windows 11.
Chrome with a fresh profile per run (cold cache; the dev server sends
`no-store`), background throttling and vsync off, a 1600x900 window, pixel ratio 1,
viewpoint `cam=0,1.6,4&target=0,1.2,0`. Per run: load until the viewer reports
LoD "settled" (4 min limit), then the viewer's 20 s orbit benchmark
(`window.bench`). RAM is the Chrome processes' working set / private bytes;
GPU memory is Windows' dedicated GPU usage of those processes.
"Stalls" = seconds the page did not answer a DevTools ping (main thread blocked).

Script: `bench-renderers.mjs` (needs the dev server on :5174).
Raw data: `runs.json`, `runs-followup.json`.

| Run | Settled | Drawn splats (orbit avg) | Avg fps | Worst frame | Stalls (total) | RAM working set / private | GPU memory |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Spark 5M | 146.5 s | 5.0M | 45* | 15.0 s | 18, 179 s | 7.3 / 12.4 GB | 4.8 GB |
| GSL 5M, WebGPU | 3.3 s | 4.1M | 139 | 1.5 s | none | 6.0 / 9.0 GB | 3.2 GB |
| GSL 5M, WebGL2 backend | 4.8 s | 5.0M | 48 | 12.1 s | 2, 16 s | 8.8 / 11.7 GB | 3.2 GB |
| Spark 10M | never (4 min) | 8.8M | — | 4.2 s | 27, 260 s | 10.8 / 19.0 GB | 6.4 GB |
| GSL 10M, WebGPU | 4.5 s | 6.7M | 121 | 1.5 s | none | 7.4 / 11.2 GB | 4.2 GB |

\* Spark's average swings between runs (45 and 228 fps at 5M): between stalls its
frames are ~1 ms, so the average depends on how many multi-second stalls land in
the 20 s window. The stalls are the problem, not draw speed.

Findings:

- Spark's paged loader blocks the main thread for 2–29 s at a time, again and
  again, while loading and while moving; at 10M it never finishes loading.
  GSL on WebGPU settles in 3–5 s with no stalls.
- GSL is not smooth either: ~100 hitches per 20 s orbit (p99 frame 110–220 ms)
  and it re-downloads ~1.9 GB (5M) / 2.3 GB (10M) in that orbit, because unused
  detail is released after `cooldownMs` (2 s). Freezing the per-part budget
  split made no difference (`runs-followup.json`), so this is GSL's own
  streaming, not the viewer's budget sharing. Next knobs: `cooldownMs`,
  `maxConcurrentLoads`, `fadeDurationMs`.
- The WebGL2 backend of GSL keeps the fast load but not the frame rate: the
  gain comes from WebGPU.
- Quality: Spark is a little sharper at the same view (`quality-crop.png`:
  Spark 5M, GSL 5M, GSL 10M). GSL settled on 3.5M visible splats of a 5M budget
  (5.5M of 10M), so raising the budget barely changes it; matching Spark's blur
  settings (preBlur 0, blur 0.3, focalAdjustment 1) didn't close the gap either.
- GSL's own GPU timestamps (~0.5–1 ms/frame) look too low to trust; Spark's
  EXT_disjoint_timer_query numbers (4–8 ms) are not comparable with them.

## Tuning round (same setup)

Raw data: `runs-tuning.json` (knobs, first demand split), `runs-tuning2.json`
(demand split that holds while the camera is still). GSL on WebGPU throughout.

**Detail gap: it was the viewer's budget split, not GSL.** GSL stops refining at
1 px (`pixelThreshold: 1`, hard-coded), so a part that is far or mostly
off-screen uses a fraction of an equal share (Oculus12: 160k of 1.25M) while the
other parts are capped. The split now goes by demand: a part under 90% of its
share keeps its use + 25%, the capped parts share the rest by screen coverage.
While the camera is still it re-splits only until the streams go idle (8 s at
most), then holds; without that hold the 10M runs never settled.

| Run | Settled | Drawn at the start view | Orbit avg | Avg fps | p99 frame | Hitches / 20 s | Re-downloaded in orbit | Private / GPU memory |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Spark 5M (first round) | 146 s | 5.0M | 5.0M | 45* | — | (stalls) | — | 12.4 / 4.8 GB |
| GSL 5M, old coverage split | 3.2 s | 3.5M | 4.2M | 147 | 164 ms | 102 | 1.9 GB | 9.4 / 3.3 GB |
| GSL 5M, demand split | 5.2 s | 4.7M | 4.7M | 142 | 191 ms | 83 | 2.1 GB | 9.4 / 3.4 GB |
| GSL 10M, old coverage split (first round) | 4.5 s | 5.5M | 6.7M | 121 | 147 ms | 108 | 2.3 GB | 11.2 / 4.2 GB |
| GSL 10M, demand split | 4.9 s | 6.9M | 7.1M | 121 | 184 ms | 82 | 2.4 GB | 11.6 / 4.3 GB |
| GSL 5M, demand, cooldown 10 s | 9.5 s | 4.3M | 4.2M | 149 | 124 ms | 61 | 1.8 GB | 10.2 / 3.8 GB |
| GSL 10M, demand, cooldown 10 s | 4.8 s | 6.9M | 7.1M | 126 | 184 ms | 69 | 1.9 GB | 12.1 / 4.8 GB |

Single knobs at 5M (`runs-tuning.json`, first demand split; run-to-run noise on
hitches is about ±15):

| Knob | Hitches | Re-downloaded | fps | Private / GPU memory |
| --- | --- | --- | --- | --- |
| defaults (cooldown 2 s, 4 loads, fade 200 ms) | 91 | 2.1 GB | 141 | 9.8 / 3.4 GB |
| `gslCooldown=10000` | 62 | 1.7 GB | 145 | 10.5 / 3.9 GB |
| `gslCooldown=30000` | 71 | 1.7 GB | 156 | 11.0 / 4.0 GB |
| `gslLoads=8` | 92 | 2.2 GB | 144 | 10.8 / 3.5 GB |
| `gslFade=0` | 100 | 2.2 GB | 153 | 8.7 / 3.0 GB |
| `gslMemMB=4000` | 73 | 2.1 GB | 144 | 9.6 / 3.4 GB |

Findings:

- The demand split draws 34% more splats at 5M and 26% more at 10M at the same
  frame rate, and closes most of the sharpness gap (`quality-crop-demand.png`:
  Spark 5M, GSL 5M, GSL 10M). GSL 10M looks about as sharp as Spark 5M here.
- A longer cooldown is the only knob that moves the hitches: 10 s cuts them by
  about a quarter to a third and re-downloads ~0.4 GB less, for ~0.5 GB more GPU
  memory and ~0.8 GB more private memory. More loads, no fade and a bigger cache
  do nothing measurable. 60–80 hitches per 20 s orbit remain: that is GSL's own
  page streaming and is not tunable from outside.
- Following this round the viewer's GSL path defaults to `cooldownMs` 10000
  (`DEFAULT_COOLDOWN_MS` in `viewer-v2/src/gsl.ts`); `?gslCooldown=2000` restores
  GSL's own default. The other knobs keep GSL's defaults.
