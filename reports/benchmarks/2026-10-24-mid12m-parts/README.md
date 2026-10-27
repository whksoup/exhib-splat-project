# Mid12M: HighRezOculus at a quarter of the density (2026-10-24)

A trained the room as 4 parts with a 12M cap each (44.5M after cropping). Mid12M trains the
same 4 parts at 3M each, 12M in total. Everything else is A's: dataset (3,426 images),
Spirula settings (replayed from Parts78's `config.json` by `pipeline/lib/spirula.mjs`), 80k
steps, transform, and per-part outline pairs. The training regions in `assets/roi/Mid12M/`
have the same digests as A's builds. The parts are seamed like A's: `build-scene` crops each
part to its outlines, and the viewer sorts all parts together.

Why 12M: a view of A wanted 20-30% of the model at 1 px (9.5-14M of 44.5M). By that ratio,
12M wants ~2.5-3.5M per view, so it fits the 5M desktop budget with no merging, at ~1.7x
the linear detail of the 4M run. `../2026-10-23-streaming-vs-count` also found that a single
10M file runs smoothly where the streamed build hitches.

## Run

```
node reports/benchmarks/2026-10-24-mid12m-parts/run.mjs queue    # started 2026-10-24 06:48 SGT, queue.log
node reports/benchmarks/2026-10-24-mid12m-parts/run.mjs scene
build-scene.bat Mid12M
```

`queue` trains Parts12, 34, 56, 78 one after another, and copies each result
(`step-*.ckpt/splat.ply`) to `assets/source_ply/Mid12M-<part>.ply`. Re-running it skips
finished parts. Spirula's early estimate for Parts12 was 7-8.5 h; the 4M run's early
estimate of 8-9 h finished in 7 h. Expect ~24-28 h for the four parts.

Then compare Mid12M with A and B at the same views and budgets using
`../2026-10-23-lowcap-retrained-lod/compare.mjs`.
