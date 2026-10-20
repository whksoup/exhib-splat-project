# Viewer

Web viewer for the Gaussian splat tour: Vite + TypeScript + three.js + Spark.
Phase 1 is the week-1 go/no-go performance spike. It has a paged .rad
streaming viewer, per-device splat budgets and a performance overlay. Tour
features (Phase 3) and WebXR (Phase 4) come later.

Pinned versions (exact, no ranges): `@sparkjsdev/spark` 2.3.1 (matches the
`build-lod` tag used by `pipeline/`), `three` 0.186.1, `vite` 8.3.2,
`typescript` 5.9.3. Node 20+ is required. It was tested with Node 24.

## Install and run

```sh
cd viewer
npm install
npm run dev          # http://localhost:5173  (also printed: http://<LAN-IP>:5173)
npm run typecheck
npm run build        # -> dist/ (static files, relative base, deployable to any CDN path)
npm run preview      # serve dist/ on :4173 with the same /models and /source mounts
```

The dev and preview servers mount these directories:

| URL prefix | Directory | Contents |
| --- | --- | --- |
| `/models/` | `../assets/rad_output/` | `build-lod` output: `<stem>-lod.rad` and `<stem>-lod-N.radc` |
| `/source/` | `../assets/source_ply/` | plain `.ply` / `.spz` / `.sog` files for quick comparison |

These mounts are served by a small middleware (`dev-server/modelFiles.ts`)
with real HTTP Range support: `206` with `Content-Range`, suffix ranges, and
`416`. Vite's built-in static serving can't reach files outside the project
root. The middleware also sends `Cache-Control: no-store`, so every reload is
a cold-cache load and first-frame timings stay comparable. It also adds the
CORS and `Timing-Allow-Origin` headers that the real CDN must send. Production
hosting rules live in `../hosting/`.

You can check the Range support by hand:

```sh
curl -s -o /dev/null -D - -H "Range: bytes=0-65535" http://localhost:5173/models/<name>/<ver>/<stem>-lod.rad
# expect: HTTP/1.1 206 Partial Content, Content-Range: bytes 0-65535/<size>
```

If you open the viewer with no `?model=`, it lists every model file the dev
server can find. Tap a file to open it, which saves typing URLs on a phone.

## URL parameters

| Param | Example | Meaning |
| --- | --- | --- |
| `model` | `/models/office/v1/office-lod.rad` | Model URL. Repeat it to load several zones, one `SplatMesh` each. |
| `paged` | `0` / `1` | Paged streaming. On by default for `.rad`. `0` loads the whole `.rad` at once. |
| `lod` | `1` / `quality` | Plain files only. Builds an LoD tree in the browser so budgets apply. Rough cost: 1–3 s per 1M splats. |
| `type` | `ply`, `spz`, `pcsogszip`, `rad` | Forces the file type when the extension is misleading. |
| `flip` | `0` | Turns off the default 180° X rotation. That rotation corrects the usual Y-down 3DGS convention. |
| `budget` | `1500000`, `1.5M`, `500k` | Base splat budget, sent to `SparkRenderer.lodSplatCount`. Leave it unset to get Spark's platform default. |
| `lodScale` | `0.8` | Budget multiplier, sent to `SparkRenderer.lodSplatScale`. This is the main tuning knob. |
| `device` | `desktop`, `iphone`, `android`, `quest`, `visionpro` | Forces a profile: that profile's budget and pixel-ratio cap. |
| `pixelRatio` | `1` | Renderer pixel ratio. By default it is `devicePixelRatio`, capped at 2 on desktop, 1.5 on phones and 1 on Quest. |
| `maxStdDev` | `sqrt5`, `2.236` | `SparkRenderer.maxStdDev`. The default is √8. The scope suggests √5 for Quest. |
| `lodRenderScale` | `2` | `SparkRenderer.lodRenderScale`, the minimum splat size in pixels. |
| `extSplats` | `1` | `pagedExtSplats` for paged meshes, `extSplats` for plain files. Fixes striping on large coordinates. |
| `meshLodScale` | `1.5` | `SplatMesh.lodScale` for each mesh. |
| `cam`, `target`, `fov` | `cam=0,1.6,4&target=0,1.2,0&fov=60` | Start viewpoint. With no viewpoint, plain files are auto-framed. Paged files start at `0,0,3` and look at the origin. |
| `controls` | `orbit` / `fly` | Starting camera mode. Press `C` to switch. |
| `overlay` | `0` | Hides the performance overlay at start. Press `P` to toggle it. |
| `settleMs` | `1500` | How long Spark must stay idle before LoD counts as "settled". |
| `config` | `configs/example.json` | JSON file holding any of the above, plus `models: [{url, position, rotation, scale, flip, lodScale}]`. URL params override it. |

Example: `?config=configs/example.json&lodScale=0.7`.

## Controls

- **Orbit** (default). Mouse: left-drag rotates, right-drag pans, wheel zooms. Touch: one finger rotates, two fingers pinch and pan.
- **Fly** (Spark's `SparkControls`). Move with WASD/arrows, Q/E or PageUp/PageDown for down/up. Drag to look. On touch, drag to look and use two fingers to slide. Gamepads also work.
- Keys: `P` toggles the overlay, `C` switches orbit/fly, `R` resets the fps measurement window, `V` returns to the start view.

## Performance overlay

| Line | What it shows |
| --- | --- |
| FPS / Frame | Rolling window of about 240 frames: average fps, 1% low (average of the slowest 1% of frames), frame time. |
| Measured | Same stats since the last **Reset fps stats** (`R`). Press it once LoD has settled, then walk the test route. |
| Splats | `SparkRenderer.activeSplats` (splats drawn this frame) against the effective budget, `(lodSplatCount ?? defaultSplatTarget()) * lodSplatScale`, and where that budget came from. |
| Device | Detected or forced profile and the pixel ratio in use. |
| 1st splat | Time from navigation start to the first rendered frame with `activeSplats > 0`. |
| LoD settled | Start of the first stretch of at least `settleMs` with no outstanding LoD work. See below. `(moved first)` means the camera moved before settling, so the number isn't "at the start viewpoint". |
| Network / Range | Model requests and MB. Range shows `ok` (206) or `ignored` (200): a streaming problem. |

**Copy results JSON** copies a full snapshot for `reports/`: device, GPU, UA,
budget settings, timings, network, fps windows and camera pose. On plain-http
LAN pages the Clipboard API is unavailable, so it falls back to
`execCommand('copy')` and, failing that, opens a text box you can select from.
**Save to reports/** only appears on the dev server. It writes
`reports/raw/<time>_<device>.json` straight from the phone or Quest.

**How "settled" is detected.** Spark 2.3.1 has no "LoD complete" event. The
viewer counts LoD as idle when all of these hold:

- every mesh has initialised;
- `spark.lodInitQueue` is empty and `spark.lodDirty` is false;
- `spark.pager.isPending()` is false: no chunk fetches in flight and nothing waiting to upload.

LoD is "settled" once this has held for `settleMs`.

**Caveats.**

- Plain files are downloaded inside a Spark worker, so their bytes come from `SplatMesh` `onProgress`, not Resource Timing.
- fps is capped at the display refresh rate.
- Background or hidden tabs throttle `requestAnimationFrame`, which makes their numbers meaningless.

## Testing on a phone or Quest over the LAN

1. Put the PC and the device on the same Wi-Fi or LAN. Run `npm run dev` and note the `Network:` URL, e.g. `http://192.168.1.20:5173`.
2. On Windows, allow Node.js through the firewall for private networks. Windows normally prompts the first time. If not, add an inbound rule for TCP 5173.
3. Open the URL on the device and pick a model from the list, or add `?model=...`.
4. On Quest, open the URL in the Meta Quest Browser. `isOculus()` detects it and the 500K profile applies.

**HTTPS / WebXR (Phase 4).** WebXR and the Clipboard API need a secure
context. `localhost` counts as secure, but a LAN IP does not. These options
don't block Phase 1:

- **USB port-forward.** Use `adb reverse tcp:5173 tcp:5173` for Quest and Android, then open `http://localhost:5173` on the device. It counts as secure with no certificates.
- **Self-signed certificate.** Add `@vitejs/plugin-basic-ssl` and `server.https`. The device shows a certificate warning you must accept once.
- **mkcert.** Install a local CA on each device and pass the certs to `server.https`.
- **Tunnel.** Use Cloudflare Tunnel or ngrok to get a public HTTPS URL. This also exercises CDN-like latency.

## Code layout

```text
index.html, src/main.ts   bootstrap, no-model / error states
src/config.ts             URL params + JSON config -> ViewerConfig
src/device.ts             device detection (Spark's isOculus/isAndroid/isIos helpers) -> budget profile
src/viewer.ts             WebGLRenderer(antialias:false) + SparkRenderer + SplatMesh(es), render loop, settle signal
src/controls.ts           orbit (three OrbitControls) / fly (SparkControls) camera rig
src/metrics.ts            frame stats, load timeline, Resource Timing network tracker
src/preflight.ts          per-model reachability + Range check before Spark sees the URL
src/overlay.ts            perf overlay, copy/save results, model picker
src/results.ts            results JSON schema
dev-server/modelFiles.ts  Vite middleware: Range file serving, /__models, /__results
public/configs/           example JSON configs
```

Hooks for later phases:

- `viewer.onFrame` is a list of per-frame callbacks, for tour animations and hotspot picking.
- `viewer.scene` is plain three.js.
- `CameraRig.setPose()` handles viewpoint moves.
- The render loop already uses `renderer.setAnimationLoop`, which `SparkXr` and WebXR need.
- `window.viewer` is exposed for console debugging.
