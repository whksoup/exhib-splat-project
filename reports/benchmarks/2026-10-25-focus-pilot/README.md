# Focus-region pilot: does `--roi-outside-weight` move splats into the regions? (2026-10-25)

**Yes.** At weight 0.1 the 13 hand-drawn regions hold **24.4%** of the model, against
8.4-9.4% in every model trained without it. In 9 of the 13 regions the splats are as fine
as A's, which has 2.9x more splats in them and a 7.4x bigger model.

## Setup

Two whole-room runs on A's dataset (3,426 images) and settings (`pipeline/lib/spirula.mjs`
replays Parts78's `config.json`):

- 6M cap, 20k steps (A's parts ran 80k).
- Training region: the 13 focus regions (`assets/roi/FocusPilot/regions-2026-10-25.json`,
  `focus-regions.mjs export LowCap`).
- `--roi-mask-pixels 0`, so the whole room trains and the region only steers where splats
  are added or relocated.
- `--roi-outside-weight` 0.1 (W010) and 0.3 (W030).

Each run took ~2 h 05 min. The scenes `FocusPilot-W010` / `-W030` are cropped to the 8 room
outlines like LowCap (B). Raw numbers are in `quantify.json`, the log in `pilot.log`.

## Results

| Model | Total | In the 13 regions | Share | Rest of the room |
| --- | --- | --- | --- | --- |
| B, LowCap (4M, 80k) | 3.99M | 334k | 8.4% | 3.66M |
| Mid12M (4 x 3M, 80k) | 9.84M | 845k | 8.6% | 9.00M |
| A, HighRezOculus (4 x 12M, 80k) | 44.5M | 4.17M | 9.4% | 40.35M |
| **W030** (6M, 20k, weight 0.3) | 5.96M | 785k | **13.2%** | 5.17M |
| **W010** (6M, 20k, weight 0.1) | 5.95M | **1.45M** | **24.4%** | 4.50M |

Median splat size (mm) in the regions where it matters most:

| Region | B | Mid12M | W030 | **W010** | A |
| --- | --- | --- | --- | --- | --- |
| r2 | 0.95 | 0.80 | 0.61 | **0.41** | 0.56 |
| r3 | 1.54 | 1.17 | 1.03 | **0.78** | 0.87 |
| r6 | 6.21 | 2.44 | 2.31 | **1.27** | 0.87 |
| r8 | 2.75 | 2.14 | 1.47 | **1.12** | 0.85 |
| r9 | 1.92 | 1.27 | 1.09 | **0.55** | 0.69 |
| r10 | 0.95 | 0.55 | 0.72 | **0.37** | 0.31 |
| r12 | 7.19 | 4.72 | 5.73 | 5.52 | 2.61 |
| r13 | 14.78 | 10.04 | 7.24 | 4.54 | 6.30 |

- **The weight works and is steep:** 0.3 moves the share from ~9% to 13%, 0.1 to 24%. The
  30-35% of the ~5.6M plan needs something like 0.05; that's a guess, as the response isn't linear.
- **Where the regions have detail, W010 matches A:** r2, r3, r9 and r10 are as fine as or
  finer than A's, and r1, r6 and r8 are within 1.2-1.5x. This is with 1.45M splats in the
  regions against A's 4.17M, and 20k steps against 80k.
- **r12 and r13 barely gain** at any weight: flat or reflective areas the photos don't
  resolve. They are Low candidates, which would free their share for the others.
- **The rest of the room** gets 4.50M, still more than all of B (3.66M). Its sharpness hasn't
  been looked at yet.

## Visual check (2026-10-26)

Both scenes were built (~380 MB each, ~80 s), then compared with `compare.mjs` against A,
Mid12M and B: 5M budget, GSL, 1600x900, at `start`, `near`, `cashier` and close-ups of four
regions, with the camera in front of each box. Sheets are in
`shots/sheet-<view>-5M.png`, numbers in `shots/results.json`.

- **Inside the regions, W010 looks like Mid12M,** a model 1.65x bigger with 4x the
  training steps, and better than B:
  - r10 (two screens): W010 and Mid12M show the map screen's text and lines crisply.
    A at 5M is the softest there, because it is budget-limited.
  - r2 (poster): W010 and Mid12M make the small print legible ("How do your thoughts and
    opinions compare to others?"); B blurs it.
  - r6 and r8 (large flat panels): little difference between models, as expected for
    low-texture surfaces.
- **Outside the regions, W010 drops toward B.** The shop shelves weren't marked. In the
  `near` view their box labels are clearly softer in W010 than in Mid12M, and about as
  soft as B. W030 sits between. The weight takes splats from what isn't marked, so
  anything that should stay sharp has to be marked.
- **Cost:** W010 settles in 1.4-3 s and downloads 130-320 MB per view as RAD (380 MB in
  total). As a single SOG it would be about 100 MB.

## Same-schedule control (2026-10-26)

W100: the same 6M / 20k run with `--roi-outside-weight 1` (the region off), ~2 h. Numbers
are in `quantify-w100.json`.

| Region | W100 (weight 1) | **W010 (weight 0.1)** |
| --- | --- | --- |
| All 13 regions | 531k, **8.9%** | 1.45M, **24.4%** |
| r2 size | 0.83 mm | 0.41 mm |
| r6 size | 5.06 mm | 1.26 mm |
| r8 size | 1.68 mm | 1.12 mm |
| r10 size | 0.87 mm | 0.37 mm |

Unweighted, 20k steps lands on the same ~9% as the 80k-step models. The weighting alone
is responsible for the 2.7x concentration and the 1.5-4x finer splats in the regions.

## Online samples (2026-10-26)

Published to https://oculussplat-test.exhib-splat-project.workers.dev as single SOG files:
Sample1-A-in-B-1_5x (10.0M, 179 MB), Sample2-W010-focus-6M (5.95M, 102 MB),
Sample3-Mid12M (9.84M, 178 MB) and Sample4-Unweighted-6M (5.96M, 103 MB, this W100).
Each opens at `?config=models/<name>/viewer.json` and settled on the live site in 7-12 s.

Sample1 was republished on 2026-10-27 from `a-in-b-x1.5-b1` (10.06M): the 1.5x splice plus each
one-sided box's backing, which fixes a ghost on the r3 panel (../2026-10-26-focus-splice).

## Not checked yet

- **Steps:** whether 80k steps sharpen the rest of the room as well.
