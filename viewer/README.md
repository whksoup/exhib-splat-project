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
| `/nav/` | `../assets/nav/` | collision meshes (`.glb`) and plan exports for navigation |

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
| `lod` | `1` / `quality` | Plain files only. Builds an LoD tree in the browser so budgets apply. Rough cost: 1â€“3 s per 1M splats. |
| `type` | `ply`, `spz`, `pcsogszip`, `rad` | Forces the file type when the extension is misleading. |
| `budget` | `1500000`, `1.5M`, `500k` | Base splat budget, sent to `SparkRenderer.lodSplatCount`. Leave it unset to get Spark's platform default. |
| `lodScale` | `0.8` | Budget multiplier, sent to `SparkRenderer.lodSplatScale`. This is the main tuning knob. |
| `device` | `desktop`, `iphone`, `android`, `quest`, `visionpro` | Forces a profile: that profile's budget and pixel-ratio cap. |
| `pixelRatio` | `1` | Renderer pixel ratio. By default it is `devicePixelRatio`, capped at 2 on desktop, 1.5 on phones and 1 on Quest. |
| `maxStdDev` | `sqrt5`, `2.236` | `SparkRenderer.maxStdDev`. The default is âˆš8. The scope suggests âˆš5 for Quest. |
| `lodRenderScale` | `2` | `SparkRenderer.lodRenderScale`, the minimum splat size in pixels. |
| `extSplats` | `1` | `pagedExtSplats` for paged meshes, `extSplats` for plain files. Fixes striping on large coordinates. |
| `meshLodScale` | `1.5` | `SplatMesh.lodScale` for each mesh. |
| `cam`, `target`, `fov` | `cam=0,1.6,4&target=0,1.2,0&fov=60` | Start viewpoint. With no viewpoint, plain files are auto-framed. Paged files start at `0,0,3` and look at the origin. |
| `controls` | `orbit` / `fly` / `walk` | Starting camera mode. Press `C` to cycle. `walk` is first-person collision navigation (see Navigation). |
| `nav`, `collision`, `allowFly`, … | `nav=walk&collision=/nav/x/collision.glb` | Navigation overrides. See Navigation. |
| `overlay` | `0` | Hides the performance overlay at start. Press `P` to toggle it. |
| `settleMs` | `1500` | How long Spark must stay idle before LoD counts as "settled". |
| `config` | `configs/example.json` | JSON file holding any of the above, plus `models: [{url, paged, lod, fileType, lodScale}]`. URL params override it. |

Models are rendered exactly in their file coordinates: no flip, rotation, offset or scale. Orientation and origin are set in LichtFeld before export, so collision meshes and plan exports line up 1:1 with the splats.

Example: `?config=configs/example.json&lodScale=0.7`.

## Controls

- **Orbit** (default). Mouse: left-drag rotates, right-drag pans, wheel zooms. Touch: one finger rotates, two fingers pinch and pan.
- **Fly** (Spark's `SparkControls`). Move with WASD/arrows, Q/E or PageUp/PageDown for down/up. Drag to look. On touch, drag to look and use two fingers to slide. Gamepads also work.
- Keys: `P` toggles the overlay, `C` cycles orbit / fly / walk, `R` resets the fps measurement window, `V` returns to the start view.

## Plan export

Plan mode gives you a top-down orthographic section of the splats and exports
it so you can trace collision geometry in Rhino or Blender. The export drops
into those tools already lined up with the splats. Code: `src/plan/`.

**Workflow**

1. Open the model and press `M`, or click **Plan (M)** at the bottom right. The view switches to an orthographic camera looking straight down −Y, framed on the model. Drag to pan; use the wheel or pinch to zoom.
2. Set the section:
   - **Cut height** hides splats above it. The default is the floor guess + 1.2 m.
   - **Floor height** hides splats below it, but only when its box is ticked. The GLB plane is always placed at this height.
   - **Pick** switches back to the 3D view. Click a surface there to read its height. Esc cancels.
   - Heights are world Y in metres.
   - For a ceiling section later (for flying), tick the floor box and set it just below the ceiling. Then only the ceiling remains, seen from above.
3. Check the **export region**. **Fit model** uses the splat bounds (0.5–99.5 percentile of centres, + 0.25 m), which ignores stray floaters. **Use view** uses what is on screen. You can also type the values.
4. Pick **px/m** (default 100, so 1 px = 1 cm), a transparent or solid background, and a label. Then click **Export PNG + JSON + GLB**. The files are written to `assets/nav/<model>/plan-<label>.png|json|glb`. `<model>` is the model file stem without `-lod`.
5. In **Blender** (File → Import → glTF 2.0) or **Rhino 8** (Import, `.glb`), import `plan-<label>.glb`. It is a single textured plane that already sits at the right world position. Don't move or scale it.
6. Trace floors, walls and ceilings over it, then export the collision GLB using the object-name conventions under [Navigation](#navigation-first-person-walking).

The **view** menu also has elevations looking −Z and −X. They use the same
section code: "cut" hides what is nearer the camera and "back" hides what is
behind. To add another view, add a frame to `src/plan/views.ts`.

**Capture quality.** Before rendering, the export:

- raises the splat budget to the **Budget** field (default 4M, capped at `maxPagedSplats` for paged models);
- turns foveation off;
- tiles the image at up to 4096 px, or the GPU's max texture, renderbuffer or viewport size if smaller;
- gives each tile its own camera, so paged LoD refines around that tile;
- waits for each tile until LoD has been idle for **Settle** seconds, using the same signal as the overlay plus "no sort in flight". A tile that hasn't settled after 120 s is captured anyway and counted in `capture.unsettledTiles`.

Normal settings are restored afterwards.

Spark's LoD traversal judges splat size by distance from the camera, even
with an orthographic camera. The plan camera therefore sits 0.25 m above the
cut, and `lodRenderScale` is divided by the farthest distance in the tile.
Outside the dev server, the files are downloaded instead of written to disk.

**Axis mapping (plan).** These are raw splat-file coordinates in three.js:
right-handed, Y-up, metres, with no model transform.

| Image | World (three.js / glTF) | Blender / Rhino after import |
| --- | --- | --- |
| +X, columns left → right | +X | +X |
| rows top → bottom | +Z | −Y |
| up | −Z | +Y |
| plane height | Y = floor height | Z = floor height |

Pixel (col, row) centre = (minX + (col + 0.5)·m, floor, minZ + (row + 0.5)·m),
where m = metresPerPixel. glTF is Y-up. Both importers convert to Z-up as
(x, y, z) → (x, −z, y), so the plan reads upright in Blender's top view (+X
right, +Y up). The PNG also carries a `pHYs` chunk (pixels per metre).

**Sidecar** (`plan-<label>.json`, schema `splat-plan-export/1`):

| Field | Meaning |
| --- | --- |
| `modelUrl`, `modelUrls`, `modelName`, `label`, `view`, `created` | Source and timestamp (ISO). |
| `image` | `file`, `width`, `height`, `metresPerPixel`, `pixelsPerMetre`, `background`. |
| `world` | `minX`, `maxX`, `minZ`, `maxZ`: the world range covered by the image edges (for elevations, the two in-plane axes). |
| `section` | `axis`, `cut`, `cutEnabled`, `floor`, `floorEnabled`, `axisVector`. Splats with dot(centre, axisVector) outside [floor, cut] are hidden. |
| `plane` | GLB file, plane height (`y`), the four world `corners` (`topLeft` = image top-left), `bounds`. |
| `axes` | Exact convention text, plus `imageRight`, `imageUp`, `imageDown` and `viewDirection` as world vectors. |
| `capture` | Tiles, tile size, unsettled tiles, splat budget, max splats drawn, settle ms, duration. |

**GLB.** One quad. Its vertices sit at the world corners, the node transform is
identity, and UV (0,0) is the image top-left. The material is unlit
(`KHR_materials_unlit`, double-sided) with the PNG embedded; it uses
`alphaMode` BLEND when the background is transparent. The sidecar's key fields
are copied into the node's `extras.planExport`.

**Checking alignment**

- In Blender, after import, the plane's corners should equal `plane.corners` with (x, y, z) → (x, −z, y). Check in the N panel, or with a vertex snap.
- A wall at world X = 22 should sit at image column (22 − minX) / m.
- In the viewer: `const {GLTFLoader} = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js'); viewer.scene.add((await new GLTFLoader().loadAsync('/nav/<model>/plan-<label>.glb')).scene)`. The plane should lie under the splat walls. `/nav/` serves `assets/nav/`.

**Dev endpoint.** `POST /__plan-export?model=<name>&file=plan-<label>.(png|json|glb)` takes the raw file as the body (512 MB max). `GET /__plan-export` is a probe. Names allow only `[A-Za-z0-9._-]`, may not start with `.` or contain `..`, and the resolved path must stay inside `assets/nav/`.

**Limits**

- The cut tests splat centres, so a large splat centred just below the cut still draws its full footprint.
- Hidden splats still count against the LoD budget.
- For paged `.rad` models, the bounds come from the splats loaded at the moment you enter plan mode. Use **Fit model** again after streaming, or type the region.
- Captures blend in linear space (sRGB render target), so colours can differ slightly from the canvas.
- The browser canvas limits the image to about 268M px (for example 16k × 16k).

## Navigation (first-person walking)

First-person walking uses a separate low-poly **collision mesh** (GLB),
because splats have no surfaces. You trace it by hand in Rhino or Blender over
the plan export. Code: `src/nav/`. Library: `three-mesh-bvh` 0.9.15 (BVH for
capsule and ray queries).

Try it with no splat model: `?config=configs/nav-test.json`. That config loads
`public/examples/nav-test-room.glb`, a test room with:

- walls and a pillar
- a 0.2 m step, and a 0.5 m block that is too tall to climb
- stairs
- a 15° ramp, and a 55° ramp that is too steep
- a 1 m `bound` glass barrier and a `nofly` volume

Rebuild the room with `npm run make:nav-test`. `npm test` runs the collision
and movement unit tests (vitest).

**Controls** (`walk` mode: press `C` until the overlay says `walk`, or use `?nav=walk`)

- **Desktop.** Click the view to capture the mouse (pointer lock); `Esc` releases it. If pointer lock isn't available, drag to look. Move with WASD or the arrow keys. Hold Shift to run.
- **Touch.** Drag on the left half for a virtual joystick (push it to the edge to run). Drag on the right half to look.
- **Space** jumps, only when `allowJump` is set.
- **F** switches between walk and fly, only when `allowFly` is set. When flying, Space/E/PageUp go up and Ctrl/Q/PageDown go down. Ctrl+W still closes the browser tab, so use Q to descend while moving forward.
- **N** toggles the debug view: a wireframe of every collider, coloured by kind, plus the player capsule (visible from orbit/fly mode).
- **V** sends the player back to the spawn point.

Collision rules:

- Walls and other colliders stop the player, and the player slides along them.
- Ledges up to `stepHeight` are climbed. Anything taller blocks.
- Surfaces steeper than `maxSlopeDeg` can't be walked up.
- Movement is substepped, so fast movement or frame hitches don't tunnel through thin walls.
- Falling below `killY` respawns the player.
- If no collision GLB is configured, or it fails to load, the player walks on a flat floor at `fallbackFloorY`. A red on-screen warning says so.

**Config.** Add a `navigation` block to the JSON config. Every field is optional. URL overrides are listed in brackets.

| Field | Default | Meaning |
| --- | --- | --- |
| `collision` | none | Collision GLB URL, e.g. `/nav/office/collision.glb` [`collision=`; `collision=none` disables it] |
| `mode` | `walk` | `walk` or `fly` [`nav=walk` / `nav=fly`, which also starts in first-person controls] |
| `allowFly` | `false` | Flying is fully built but blocked until this is set [`allowFly=1`] |
| `allowJump` | `false` | Space jumps [`allowJump=1`]. `jumpSpeed` (4 m/s) sets the jump strength |
| `eyeHeight`, `radius`, `height` | 1.6, 0.3, 1.8 | Capsule size in metres: eye above the feet, radius, feet-to-head height |
| `stepHeight` | 0.35 | Highest ledge climbed without jumping (stairs) [`stepHeight=`] |
| `maxSlopeDeg` | 45 | Steepest walkable surface [`maxSlope=`] |
| `walkSpeed`, `runSpeed`, `flySpeed` | 1.6, 3.6, 3 | m/s. Shift switches to run speed, or multiplies fly speed by `flyRunMultiplier` (2.5) |
| `maxHeight` | none | Flying only: the top of the capsule never goes above this Y [`maxHeight=`] |
| `fallbackFloorY` | 0 | Floor height when there is no collision mesh [`floorY=`] |
| `killY` | 20 m below the lowest collider | Respawn below this Y [`killY=`] |
| `spawn` | from `camera`, else the collider centre | `{ "position": [x,y,z], "yaw": deg, "pitch": deg }`. `position` is the eye. The player drops onto the first walkable surface below it, so a floor-level point works too. Yaw 0 looks down -Z, and positive yaw turns left [`spawn=x,y,z`, `spawnYaw=`, `spawnPitch=`] |
| `gravity`, `lookSensitivity` | 9.81, 0.15 | m/s², degrees per pixel |
| `debug` | `false` | Start with the collider wireframe on [`navDebug=1`] |

A JSON `navigation` block that sets `mode` or `collision` starts in `walk`
controls, unless the JSON sets `controls` itself. With `controls: "walk"`, no
model is needed.

**Object-name conventions for the collision GLB.** Prefixes are
case-insensitive. The viewer checks the mesh's own name first, then the
nearest parent (Blender collection or Rhino layer exported as a node) whose
name has a known prefix.

| Prefix | Behaviour |
| --- | --- |
| `floor*` | Walkable ground, within the slope limit. Model stairs as `floor` boxes or steps. |
| `wall*` | Blocks sideways movement over the full body height. It is never walkable and never climbed as a step. |
| `ceiling*` | Blocks upward movement when jumping or flying. |
| `bound*` | Invisible barriers, e.g. glass, railings or the edge of the scan. They are treated like walls. |
| `nofly*` | Volumes the flying player can't enter. Walking ignores them. Only their surfaces block, so don't spawn inside one. |
| anything else | Solid: it blocks, and is walkable where it is flat enough. |

Lines, curves and points are ignored.

**Rhino / Blender export tips**

- Model in **metres**, in the same world coordinates as the splat. Start from the plan-export GLB plane, which arrives already aligned.
- Export as **glTF binary (.glb)**. The Y-up/Z-up conversion is handled by the exporters; don't add your own. Blender: *File > Export > glTF 2.0*, format *glTF Binary*, with *+Y Up* on (the default). Rhino 8: *Export > .glb*.
- **Apply transforms** before export: in Blender, *Object > Apply > All Transforms*. The viewer honours node transforms, but applied geometry avoids surprises. Don't scale the collider root.
- Keep it **low-poly**: boxes and extruded outlines, a few hundred to a few thousand triangles. It is never rendered except in the debug view.
- **Close the floors**: no gaps between floor pieces, and floors should run under the walls. A gap wider than about 0.15 m is a hole the player falls through, and then respawns.
- Give walls some thickness (at least 0.1 m), so face normals don't matter. Faces are treated as double-sided anyway.
- Don't use Draco or meshopt compression. GLTFLoader isn't configured with those decoders.
- Put collision files in `../assets/nav/<model>/`. The dev server serves them at `/nav/<model>/<file>.glb` with the same safety rules as `/models/`. Deploy them next to the model on the CDN.

**Enabling flying later.** Set `"allowFly": true`, and optionally
`"mode": "fly"` and `"maxHeight": <y>`. Nothing else changes: ceiling, floor,
wall and `nofly` collisions already work in fly mode. Test it with
`&allowFly=1&nav=fly`.

**API for later phases** (`window.nav` in the console; `src/nav/index.ts`).
It is framework-free:

- `nav.teleport(pose)`
- `nav.moveTo(pose, durationMs)`: animates with ease-in-out and ignores collisions along the way, because it is a camera transition between known-good viewpoints. It then lands on the floor and returns `Promise<boolean>`, which is false if it was interrupted.
- `nav.getMode()` and `nav.setMode('walk' | 'fly')`: `setMode` returns the mode actually in effect, so fly is refused unless allowed.
- `nav.getPose()`, `nav.respawn()`, `nav.ready`
- `nav.player`: the pure `PlayerController`. It takes a `NavInput` per step, so gamepad or WebXR thumbstick input can drive it in Phase 4.

The player only advances while `walk` controls are active.

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
src/plan/                 plan mode: ortho section view (dyno world-modifier cut), tiled capture, PNG/JSON/GLB export (see Plan export)
dev-server/planExport.ts  Vite middleware: POST /__plan-export -> assets/nav/<model>/plan-<label>.*
src/nav/                  collision world (three-mesh-bvh), player controller, input, debug view (see Navigation)
scripts/                  make-nav-test-room.ts -> public/examples/nav-test-room.glb
public/configs/           example JSON configs (nav-test.json: walking with no model)
```

Hooks for later phases:

- `viewer.onFrame` is a list of per-frame callbacks, for tour animations and hotspot picking.
- `viewer.scene` is plain three.js.
- `CameraRig.setPose()` handles viewpoint moves.
- The render loop already uses `renderer.setAnimationLoop`, which `SparkXr` and WebXR need.
- `window.viewer` is exposed for console debugging.
