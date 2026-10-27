# Focus splice: A's detail in the boxes, a small model around them (2026-10-26)

No training: each splat is kept by its centre, in scene coordinates.

- **Inside the 13 focus boxes:** A's splats. Each part was first cropped to its own
  outlines, as A's build does, then baked.
- **Outside the boxes:** a lower-resolution model's splats, B (LowCap, 4M) or the
  weighted pilot W010 (6M).

Each combination is packed as one SOG level, loaded once with nothing streamed. The boxes
are the 13 in `scenes/LowCap`, and every model shares HighRezOculus's transform. `run.mjs`:
`prep` (W010 cropped and baked), `cut`, `pack`. The whole run took ~10 minutes, mostly
SOG packing.

| Arm | Inside the boxes | Outside | Total | SOG |
| --- | --- | --- | --- | --- |
| `a-in-b` | A, 4.17M | B, 3.66M | 7.83M | 123 MB |
| `a-in-w010` | A, 4.17M | W010, 4.50M | 8.66M | 152 MB |
| `w010` (control: same format, no splice) | W010, 1.45M | W010, 4.50M | 5.95M | 97 MB |

The cut counts equal `focus-regions.mjs quantify`'s (`cut.json`).

## Comparison

`compare.mjs`, 10M budget: a single-level SOG can't drop below its full count, so every
arm, A included, gets room for all its splats. GSL WebGPU, 1600x900, views `start`,
`near` and close-ups r2, r6, r8 and r10. Sheets are in `shots/sheet-<view>-10M.png`, numbers
in `shots/results.json`.

| Arm | Settled | Downloaded | GPU |
| --- | --- | --- | --- |
| A (streamed RAD, 10M) | 3.4-6.8 s | 0.5-1.7 GB per view | 1.1-3.5 GB |
| `w010` | 0.8-1.1 s | 102 MB once | 0.6 GB |
| `a-in-b` | 0.9-1.5 s | 128 MB once | 0.8 GB |
| `a-in-w010` | 0.8-1.9 s | 159 MB once | 0.9 GB |

- **No visible seams** in the wide views or around the boxes. A's colours sit cleanly in B's
  or W010's room, including the poster box (r2), which takes in part of a plain wall.
- **One artifact:** a thin vertical pole crossing a box edge (r8) shows a small kink where
  its A half meets its B half. Thin objects crossing a box face are where a centre cut shows.
- **Inside the boxes, the splices look like A.**
  - r8 (large printed panels): the splices show A's fine print texture where W010 is
    blotchy, a clear gain.
  - r2 (poster) and r10 (screens): W010 alone is already about as sharp as A, so the
    splice adds little there.
- **Outside the boxes** each splice is its base model: with B, the unmarked shop shelves are
  B-soft, as in W010.

## Boxes grown 1.5x (2026-10-27)

`run.mjs cut --scale 1.5` / `pack --scale 1.5`: every box 1.5x along each of its axes, about
its centre (3.4x the volume), so A also covers the edges where the 1x cut showed. Arms
`a-in-b-x1.5` and `a-in-w010-x1.5`, counts in `cut-x1.5.json`. Compared at 12M (the
x1.5 arms are over 10M), sheets in `shots-x1.5/`.

| Arm | A in the boxes | Base outside | Total | SOG | Settled | GPU |
| --- | --- | --- | --- | --- | --- | --- |
| `a-in-b` (1x) | 4.17M | 3.66M | 7.83M | 123 MB | 0.9-1.5 s | 0.8 GB |
| `a-in-b-x1.5` | 6.60M | 3.43M | **10.03M** | 171 MB | 0.8-2.2 s | 1.0 GB |
| `a-in-w010-x1.5` | 6.60M | 4.07M | 10.67M | 180 MB | 0.8-2.2 s | 1.1 GB |

- **The edge artifacts go:** at r8 the thin pole that kinked at the 1x box face is
  continuous, and the panel edges match A.
- **Cost: +2.4M splats (+58% of A's share) for the margin.** Most of it is around Oculus12
  (1.58M -> 3.33M): growing a box by a fixed factor takes in a lot of dense surroundings
  when the box is large (r7: 2.99 m³ -> 10 m³). The total passes 10M, past the mid-range
  target.
- **Interiors and far surroundings don't change.** The screens (r10), the poster (r2) and
  the unmarked shelves and tote in `near` look as at 1x.

## Fixed margin, +20 cm per face (2026-10-27)

`run.mjs cut --margin 0.2` / `pack --margin 0.2`: every face pushed out 20 cm. Arm
`a-in-b-m0.2`, counts in `cut-m0.2.json`, compared at 15M, sheets in `shots-margin/`.

| Arm | Box volume | A in the boxes | B outside | Total | SOG | GPU |
| --- | --- | --- | --- | --- | --- | --- |
| `a-in-b` (1x) | 4.25 m³ | 4.17M | 3.66M | 7.83M | 123 MB | 0.8 GB |
| `a-in-b-x1.5` | ~14.3 m³ | 6.60M | 3.43M | 10.03M | 171 MB | 1.0 GB |
| `a-in-b-m0.2` | 16.0 m³ | **10.79M** | 2.99M | **13.78M** | 221 MB | 1.4 GB |

**The prediction above was wrong: the fixed margin is the most expensive.** Most of the
boxes are thin slabs on walls and panels (r12 is 4 cm deep, others 14-17 cm). +20 cm per
face makes a 4 cm box 44 cm deep, a thick band of densely splatted wall on both sides.
1.5x adds 2 cm to the same box. The volumes are similar; the difference is how many splats
sit in the added volume. Splats lie on surfaces, so growth along a box's thin axis, into
the surface it sits on, is what costs.

Visually it gains nothing over 1.5x. At r8 both fix the pole. At r10 the left screen takes
A's texture (with A's own floater blob). The shelves, tote and screens look as at 1.5x.

**Next margin to try:** grow along the box's two long axes only (the in-plane edges where
the artifacts showed) and leave the thin axis at 1x or a few cm. That covers the edges
without taking in the wall behind.

## Read it as

- **The splice is a working tool for hero pieces.** A's best detail on chosen objects, no
  training, minutes to rebuild after redrawing a box, and one ~120-150 MB file.
- **It costs ~2.9x the splats in the boxes** (4.17M vs W010's 1.45M) for a visible gain only
  where the regions have fine texture W010 didn't reach (r8 here). Per splat, weighted
  training is more efficient; splicing is faster to iterate.
- **Combine them:** a weighted training for the room and most regions, with A spliced into
  the few boxes where W010 falls short. Keep box faces off thin objects.
