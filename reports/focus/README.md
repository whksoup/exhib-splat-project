# Focus-region measurements

`node pipeline/focus-regions.mjs quantify <scene> --compare <scene>... --json <file>`
(see `pipeline/README.md`, "Focus regions").

## 2026-10-25: first 13 regions (`LowCap-regions-2026-10-25.json`)

The 13 boxes were drawn by hand in the editor, all Hero, with default names. They were
saved in `scenes/LowCap/scene.json`, but LowCap, Mid12M and HighRezOculus share one
transform, so the same boxes measure all three. The union covers 4.25 m³; r7 alone is
2.99 m³.

| Model | Total (cropped) | In the 13 regions | Share | Median splat size in the regions |
| --- | --- | --- | --- | --- |
| A, HighRezOculus (4 x 12M) | 44.5M | 4.17M | 9.4% | 0.3-2.6 mm (r13: 6.3) |
| Mid12M (4 x 3M) | 9.84M | 845k | 8.6% | 0.55-4.7 mm (r13: 10) |
| B, LowCap (4M) | 3.99M | 334k | 8.4% | 0.95-7.6 mm (r13: 15) |

- **The share is the same at every cap (8-9%).** Training spends splats on these areas in
  proportion to the rest of the room; nothing prioritises them. Splats per region scale
  with the total, so "the density of an N-million model" in the regions is about
  N x 9.4% of A's density here.
- **A has the finest detail in the regions:** 0.3-0.9 mm in r2, r3, r6, r8, r9, r10, r11.
  The photos support at least that. B is 3-7x coarser there (r6: 6.2 mm against 0.86 mm).
- **r13 is coarse in every model** (6-15 mm), as glass or reflective surfaces are: a Low
  candidate rather than Hero. r4 (5 x 4 x 4 cm, 1.2k splats in A) looks accidental.
