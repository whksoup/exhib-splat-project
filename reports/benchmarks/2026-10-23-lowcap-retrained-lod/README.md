# Low-cap training with retrained LoD levels (plan, 2026-10-23)

Follows `../2026-10-23-blur-diagnosis`. That report found the online blur comes from the
budget. Views need 9.5-14M splats; the viewer draws 5M (desktop) or 1-1.5M (phones), so it
shows build-lod's merged parents. Each view also downloads ~1.1 GB. The SuperSplat reference
does the opposite: a 1.58M-splat model, with coarser levels made by sparsifying and
retraining (750k / 375k / 187.5k), 57 MB in all.

Question: is a whole-room model trained at a ~4M cap, with retrained halving levels,
sharper than the current 44.5M build at the same splat budget? And is it far cheaper to
load?

## Arms

All arms come from the same dataset (`OculusV2_Output`, 3,426 images) and use the same
region (`assets/roi/LowCap/AllOutlines.json`, the union of the 8 outlines the 4 HighRezOculus
parts used). They share the HighRezOculus transform, views and budgets. Rendering is GSL
on WebGPU at 1600x900, pixel ratio 1.

| Arm | What | Loaded as |
| --- | --- | --- |
| A `current` | HighRezOculus: 4 parts x 12M cap, build-lod | `?scene=HighRezOculus` (RAD) |
| B `lowcap-rad` | L0 (4M cap, 80k steps), build-lod over it | `?scene=LowCap` (RAD) |
| C `retrained` | L0 + L1 2M + L2 1M + L3 0.5M, each retrained | `lod-meta.json` (SOG) |
| D `merged` | L0 + the same-count merge-only starts of L1-L3, no retrain | `lod-meta.json` (SOG) |
| E `l0` | L0 alone | `lod-meta.json` (SOG) |
| F `downsampled` | HighRezOculus (44.5M) merged to 4M by `miniature.mjs`, SH 3, no training | `lod-meta.json` (SOG) |

What each comparison isolates:

- **B vs A**: the cap alone, with the LoD method and format unchanged. Does a 4M model look
  better at 5M / 1.5M than 44.5M decimated to that count?
- **C vs D**: retraining the levels vs merging only. Same counts, format and packaging.
  This is hypothesis 3 of the diagnosis.
- **E vs B** at 5M, where both draw all of L0: what SOG compression costs against RAD.
- **C vs A**: the whole proposal, including download size and settle time.
- **F vs E**: same count (4M), SH, format and packaging; one is trained at 4M, the other is
  the 44.5M model merged down 11x. Is the ~8 h L0 run worth it over a few minutes of merging?

Budgets: 5M (the published desktop default), 1.5M (iPhone), 1M (Android). Views: `start`,
`near` and `atrium` from the diagnosis, plus `cashier`, `back` and `floor`.

## Steps

All commands run from the repo root. `R=reports/benchmarks/2026-10-23-lowcap-retrained-lod/run.mjs`.

| # | Step | Command | Time (estimate) |
| --- | --- | --- | --- |
| 0 | Region, flag check, packaging smoke test | `node $R region` · `node $R args L0 --check` · `node $R pack smoke` | done |
| 1 | Train L0 (close the Spirula GUI first; it holds ~12 GB of VRAM) | `node $R train L0` | ~8-9 h (Spirula's ETA at step 200; the 12M parts took 9.5-10.4 h) |
| 2 | Export L0 to `assets/source_ply/LowCap-L0.ply` | Spirula Studio, as for Oculus12..78 (see Open points) | min |
| 3 | Scene + build-lod arm B | `node $R scene` · `build-scene.bat LowCap` | ~2 min |
| 4 | Merge-only starts of L1-L3 | `node $R init L1` (L2, L3) | ~1 min each |
| 5 | **Pilot**: retrain L1, export to `LowCap-L1.ply`, check it before L2/L3 | `node $R train L1` | ~1-1.5 h |
| 6 | Retrain L2, L3 and export them | `node $R train L2` · `node $R train L3` | ~1 h each |
| 7 | Crop + bake every level, bake the merge-only starts | `node $R prep L0` (to L3) · `node $R prep-init L1` (to L3) | ~1 min each |
| 8 | Pack the SOG arms | `node $R pack retrained` · `pack merged` · `pack l0` | ~1 min each |
| 8b | Arm F: merge HighRezOculus to 4M, bake, pack (CPU only, can run during step 1) | `node $R downsample` · `node $R pack downsampled` | merge 87 s, rest ~min |
| 9 | Compare (dev server on :5174) | `node compare.mjs <out>` · `powershell -File sheet.ps1 <out>` | ~1 h (90 runs) |

The retrains (step 5) start from the merged copy of L0 at the level's final count, so they
don't grow. MCMC only relocates dead splats. They use the 12M runs' settings plus
`noise_lr 8`, `means_lr 3.2e-5` and `sh_degree_warmup_every 1`. **Those three values are a
guess.** In the pilot, compare L1 with its merge-only start at 1.5M (`compare.mjs <out>
retrained,merged near,start 1.5M` after packing). If the retrain hasn't clearly helped, try
the 12M runs' original rates or more steps before spending time on L2/L3.

## Decision rules

- **Adopt C** if, at 5M, `near`/`start` text is at least as readable as A, and at 1.5M C is
  clearly sharper than A, with a view's download at most ~10% of A's (A: 0.86-1.2 GB).
- **C clearly beats D**: retraining is worth its ~3 h. **C ≈ D**: use merged levels, or
  build-lod (B), and skip the retrains.
- **B ≈ C at 5M but B worse at 1.5M**: the low cap fixes desktop and the retrained levels
  fix phones.
- **E clearly worse than B at 5M**: SOG compression costs detail. Pack with less compression
  (`--sh-iterations`, or SH 1) or stay on RAD with a better LoD.
- **F ≈ E**: training at 4M buys nothing over merging the big model. Make the coarse
  levels by merging, and spend GPU time on short retrains of merged starts instead of new
  full runs. **E clearly beats F**: train at the target count.
- **Quality ceiling**: A unconstrained (`lodScale=16`, see the diagnosis). No arm can beat
  it, because it is the 44.5M model at 1 px.

Judge from the sheets (`sheet-<view>-<budget>.png`). The sharpness number in `sharpness.csv`
is a weak signal: on the smoke test it gave 0.5 ("sharp") for a visibly soft render. Online
load time is `downloadedMB x 8 / Mbit/s`. CDP throttling doesn't reach GSL's worker
fetches, so it isn't emulated.

## Verified so far

- `assets/roi/LowCap/AllOutlines.json` has the same region digest as the 8 outlines read by
  `lib/roi.mjs`.
- `args L0 --check` / `args L1 --check`: Spirula parses all ~200 flags taken from the
  Parts78 `config.json`. `config.json` writes `Infinity`, which is mapped to `inf`.
- **Viewer**: `lod-meta.json` streams on the GSL path (`viewer-v2/src/gsl.ts`) and takes part
  in the budget split. Typecheck and the 59 unit tests pass.
- **Smoke pack**: the two HighRezOculus miniatures (3M + 1.5M, merge-only, SH 1) were baked
  and packed, and line up with the HighRezOculus views exactly. Runs at 5M budget:

  | View | A settled | A downloaded | Smoke settled | Smoke downloaded |
  | --- | --- | --- | --- | --- |
  | start | 3.9 s | 1,051 MB | 0.9 s | 69 MB |
  | cashier | 3.7 s | 1,064 MB | 1.1 s | 66 MB |
  | back | 4.3 s | 858 MB | 1.0 s | 66 MB |
  | floor | 4.9 s | 1,211 MB | 1.1 s | 69 MB |

  The merge-only miniature is visibly blurry, with a dotted grid on dark surfaces. This is
  an early hint that merging alone loses detail. It is not evidence yet: SH 1 and SOG
  compression also differ. That is what arms D and E control for.

- **Arm F preview** (`F-preview/`, `compare.mjs F-preview current,downsampled near,start 5M,1.5M`):
  the merge kept 44,518,753 splats after the crop and wrote 4,022,917 at SH 3 in 87 s. Packed,
  it is 63 MB. Every shot settled in ~1 s, against 4.2 s / ~1,050 MB for A at 5M.
  It looks much worse than A: blurry overall, the shop sign barely readable, the same
  dotted grid on dark surfaces (bags, boxes) as the smoke test. **The grid is still there at
  SH 3**, so it comes from the merge or SOG, not SH 1. A at **1.5M** is still clearly
  sharper than F drawing all 4M: build-lod's per-view cut beats one uniform merge of the
  whole room by a wide margin. Arm E will separate merge from SOG.
  A single-level arm draws all its splats at any budget (F drew 4.02M at "1.5M"), so E and F
  only compare cleanly at 5M.

## Results: A, B, E, F (2026-10-24)

L0 finished at 04:15 (80,000 steps, 7 h 03 m), 3,999,158 splats, of which 3,993,425 are
inside the region. Arm B (`scene` + `build-scene.bat LowCap`, 12:48): 5.6M nodes, 281 MB of
RAD, built in 50 s. Arm E (`prep L0` · `pack l0`): 63 MB, the same size as F.

`compare.mjs E-vs-F current,lowcap-rad,l0,downsampled <all 6 views> 5M,1.5M`, 48 shots, all
settled. Judged by looking at the full frames: `sheet.ps1` is blocked by this machine's
PowerShell execution policy, so there are no sheets or `sharpness.csv` yet.

| Arm | Downloaded per view | Settled | GPU resident | Drawn at 5M | Drawn at 1.5M |
| --- | --- | --- | --- | --- | --- |
| A `current` | 833–1,215 MB (5M), 441–593 MB (1.5M) | 3.6–4.4 s | 1.8–2.5 GB | 4.7–5.1M | 1.45–1.52M |
| B `lowcap-rad` | 144–242 MB | 1.7–2.7 s | 0.3–0.5 GB | 1.0–2.0M | 1.0–1.5M |
| E `l0` | 33–66 MB | 0.9–1.1 s | 0.2–0.4 GB | 2.0–4.0M | same (one level) |
| F `downsampled` | 66 MB | 0.9–1.1 s | 0.4 GB | 3.0–4.0M | same (one level) |

B draws only 1.0–2.0M at a 5M budget: at these views the 4M model reaches GSL's 1 px stop
before the budget does. The SOG packs are split into 4 spatial chunks (`0_0`..`0_3`), so E
loads only the chunks in view (`back`: 33 MB, 2.0M splats).

Findings:

- **E beats F by a wide margin (decision: train at the target count).** At the same 4M,
  SH 3 and SOG packaging, F is blurry with the dotted grid and E is clean (`near`, `floor`).
  Merging 44.5M down to 4M is no substitute for training at 4M.
- **E ≈ B at 5M.** SOG compression costs nothing visible next to RAD, so the "E clearly
  worse" rule doesn't apply. SOG packaging is fine.
- **The 4M model is sharper than A at 5M at mid range.** `near`: the box titles on the
  shelves (MARBLE RUN, AIR ROCKETS, WORLD ATLAS, DINOSAURS, OCEANS) are readable in E/B and
  not in A. `floor`: E's shelf boxes, the tote print and the cashier signage are crisper
  than A's. This answers "B vs A": yes, at the desktop budget.
- **A still wins on the nearest objects.** `near`: the line-art print on the hanging black
  bag and the "ArtScience Museum" text on the totes are crisp in A and reduced to a few
  streaks in E/B. A 4M cap across the whole room doesn't keep sub-centimetre detail on
  things 0.5 m from the camera. That is the cost of the cap, and the 44.5M build's real
  advantage. It only shows if the budget lets A draw it.
- **Phones: B at 1.5M is far sharper than A at 1.5M** (`near`: A's box art is mush; B
  matches its own 5M shot, because it never needed more than ~1.8M). It downloads 220–240 MB
  per view against A's ~530 MB.
- **Load:** E/F download 33–66 MB and settle in ~1 s, against A's ~1 GB and ~4 s.

So for desktop and phones, the 4M model (as B, or as E with a smaller level for phones)
already beats the current published build at the published budgets, except for close-up
detail on the nearest objects. Next is the L1 pilot (`init L1` · `train L1`, ~1–1.5 h), to see
whether retrained 2M/1M/0.5M levels hold up for phones (arm C vs D).

## Open points

- **PLY export from the CLI.** Settled: the L0 run (finished 2026-10-24 04:15, 80,000 steps
  in 7 h 03 m) wrote `step-000080000.ckpt\splat.ply` itself, so step 2 is a copy to
  `assets/source_ply/LowCap-L0.ply`, not a GUI export. (The smoke checks had only seen
  `state.tar`.)
- **GSL 1.4.0 and SOG under a scaled group**: placement is right (bounds match), but splats
  draw as large blobs. So the SOG arms bake the transform with `pipeline/transform.mjs`, and
  the viewer refuses a `lod-meta.json` with a model matrix. Worth reporting upstream.
- **Merge-only start for the retrains**: `miniature.mjs` (moment-matched merge, crops to the
  region). `splat-transform --decimate-adaptive` is the alternative if the merge's grid
  pattern survives retraining. Arm F shows the grid at SH 3 as well, so check for it in the
  L1 pilot before L2/L3.
- **Pose-matched metrics** (render at training camera poses and compare with the photos)
  would remove the judgement from the sheets. Not set up: the poses are fisheye warped to
  pinhole faces.
