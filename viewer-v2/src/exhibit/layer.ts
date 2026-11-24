/**
 * The exhibition's walking interface over the splat (embedded mode only):
 * artwork markers, the in-view card, the crosshair, the controls guide, and
 * pause / resume. It mirrors the exhibition's old walk
 * (dist/oculus-walk-prototype) so visitors find the same things in the
 * high-resolution rooms. Opening an artwork is the host's job: the layer only
 * reports which one (onOpenWork) and pauses.
 *
 * Navigation states, as in the old walk:
 *   paused   input stopped, the toolbar offers Resume / drag-to-look / Reset
 *   explore  walking; Escape (or losing the mouse capture) pauses
 */
import * as THREE from "three";
import {
  createPreviewTracker,
  lookOffset,
  pickWork,
  previewCandidate,
  surfaceDistance,
  widgetScale,
  type Vec3,
  type WalkWork,
} from "./targeting";

export type NavigationState = "paused" | "explore";

export interface ExhibitLayerOptions {
  ui: HTMLElement;
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  /** Stop or restart walking input (CameraRig.setSuspended). */
  setSuspended(suspended: boolean): void;
  /** Whether a click on the canvas may capture the mouse (false = drag to look). */
  allowPointerLock(allowed: boolean): void;
  /** Metres per world unit, for the distances below (1 for builds in metres). */
  metresPerUnit?: number;
  onOpenWork(id: string): void;
  /** Reset view: back to where this walk started. */
  onReset(): void;
  /** Called when the state or the in-view artwork changes (the host saves it). */
  onChange?(): void;
  /** Debug mode: artwork spheres in the scene and a tuning panel (the host's ?walkDebug=1). */
  debug?: boolean;
  /** Where the debug spheres go. */
  scene?: THREE.Scene;
  /** Eye height in metres now, and a way to change it live (debug panel). */
  eyeHeight?: number;
  setEyeHeight?(metres: number): void;
}

/**
 * Tuning, in metres and degrees. One rule picks the focused artwork, and the
 * centre dot, the in-view card, the artwork's centre widget and click / Enter
 * all follow it, so they always agree: the artwork the view ray goes through,
 * else the one nearest the centre of view within `lookAngleDeg`, within
 * `focusRange` of its surface. `dwellMs` / `departureMs` steady it.
 */
export const LAYER_TUNING = Object.freeze({ focusRange: 10, lookAngleDeg: 8, markerRange: 30, dwellMs: 120, departureMs: 300 });

const CSS = `
body.embedded .nav-hud, body.embedded .nav-cross { display: none !important; }
.ex-layer { position: fixed; inset: 0; pointer-events: none !important; font: 14px/1.4 Arial, sans-serif; color: #29342d; }
.ex-layer button { font: inherit; cursor: pointer; color: inherit; border: 1px solid #b9bfb0; background: #f4f4e9; padding: 11px 16px; border-radius: 3px; }
.ex-layer button:hover { background: #e4e8d8; }
.ex-layer button:focus-visible { outline: 3px solid #587239; outline-offset: 3px; }
.ex-layer > * { pointer-events: auto; }
.ex-markers { position: absolute; inset: 0; pointer-events: none !important; isolation: isolate; }
.ex-marker { position: absolute; transform: translate(-50%, -50%) scale(var(--s, 1)); z-index: var(--o, 1); pointer-events: auto;
  display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 5px 10px 5px 5px; font-size: 11px !important;
  background: #f5f4e8e6 !important; border: 1px solid #85917a !important; border-radius: 16px !important; box-shadow: 0 3px 14px #203b2024; }
.ex-marker::before { content: ""; width: 18px; height: 18px; border-radius: 50%; background: #455942; box-shadow: inset 0 0 0 5px #f5f4e8; border: 1px solid #455942; }
.ex-marker.selected { border: 2px solid #304a2f !important; background: #fff !important; }
body.ex-captured .ex-marker { pointer-events: none; }
.ex-target { position: absolute; top: 50%; left: 50%; width: 9px; height: 9px; border: 1px solid #fff; background: #324b3a88; border-radius: 50%;
  transform: translate(-50%, -50%); pointer-events: none !important; box-shadow: 0 0 0 1px #30453180; }
.ex-target.selectable { width: 17px; height: 17px; background: #f6f5ec; border: 4px solid #405d3e; }
.ex-preview { position: absolute; right: 32px; top: 28%; width: 288px; background: #f6f5eef5; border: 1px solid #bac2b1; padding: 22px;
  box-shadow: 0 12px 45px #203b2017; border-radius: 4px; }
.ex-eyebrow { margin: 0 0 12px; font-size: 10px; letter-spacing: 1.9px; font-weight: 600; color: #637059; }
.ex-preview h2 { font: normal 27px/1.15 Georgia, serif; margin: 0 0 10px; }
.ex-preview .ex-artist { font-size: 12px; color: #53604e; margin: 0 0 8px; }
.ex-preview .ex-summary { font-size: 13px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; margin: 0 0 12px; }
.ex-preview .ex-open { width: 100%; text-align: left; background: #304b37 !important; color: #fff !important; border-color: #304b37 !important; margin: 4px 0 10px; }
.ex-preview small { display: block; font-size: 10px; line-height: 1.5; color: #56664e; }
.ex-guide { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(380px, calc(100vw - 32px));
  max-height: calc(100dvh - 40px); overflow: auto; padding: 20px 22px; background: #f6f5eef7; border: 1px solid #bac2b1; border-radius: 5px; box-shadow: 0 24px 90px #18321840; }
.ex-guide h2 { margin: 0; font: normal clamp(23px, 4vw, 30px)/1.1 Georgia, serif; letter-spacing: -.02em; }
.ex-guide h2:focus { outline: none; }
.ex-guide dl { margin: 12px 0 14px; }
.ex-guide dl > div { display: grid; grid-template-columns: 64px 1fr; gap: 10px; padding: 7px 0; border-top: 1px solid #b7bbae; }
.ex-guide dt { font-weight: 600; }
.ex-guide dd { margin: 0; }
.ex-guide kbd { display: inline-block; min-width: 18px; padding: 0 2px; border: 1px solid #a5ae9b; border-radius: 2px; text-align: center; font: 12px/1.35 monospace; }
.ex-guide .ex-start { display: flex; width: 100%; min-height: 44px; align-items: center; justify-content: space-between; background: #344c3b !important; border-color: #344c3b !important; color: #fff !important; }
.ex-touch { display: none; }
.ex-tools { position: absolute; left: 24px; bottom: 24px; display: flex; gap: 8px; flex-wrap: wrap; max-width: calc(100vw - 48px); }
.ex-tools .ex-resume { background: #293c30 !important; color: #fff !important; border-color: #293c30 !important; }
.ex-hint { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); padding: 6px 12px; border-radius: 4px; font-size: 11px;
  background: #f0f1e3d9; color: #3d4a3a; pointer-events: none !important; white-space: nowrap; }
.ex-focus { position: absolute; transform: translate(-50%, -50%); padding: 0 !important; border: 0 !important; background: none !important;
  display: grid; justify-items: center; gap: 8px; pointer-events: auto; }
body.ex-captured .ex-focus { pointer-events: none; }
.ex-focus-ring { width: var(--ring, 64px); height: var(--ring, 64px); border-radius: 50%; border: 3px solid #f6f5ec; box-shadow: 0 0 0 2px #304a2f, inset 0 0 0 2px #304a2f;
  background: radial-gradient(circle, #304a2f 0 5px, transparent 6px); }
.ex-focus-label { padding: 5px 10px; border-radius: 3px; background: #f6f5eef2; border: 1px solid #85917a; font-size: 12px; white-space: nowrap; }
@media (prefers-reduced-motion: no-preference) { .ex-focus-ring { animation: ex-pulse 1.6s ease-in-out infinite; } }
@keyframes ex-pulse { 50% { transform: scale(1.08); } }
.ex-debug { position: absolute; left: 16px; top: 16px; width: 300px; padding: 12px 14px; background: #10130fe6; color: #e8eee2; border-radius: 4px; font-size: 11px; }
.ex-debug .ex-eyebrow { color: #a6c28e; margin-bottom: 8px; }
.ex-debug label { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; margin: 6px 0; }
.ex-debug input { grid-column: 1 / -1; width: 100%; }
.ex-debug pre { margin: 8px 0; font: 10px/1.45 monospace; white-space: pre; overflow: hidden; }
.ex-debug-note { margin: 0; color: #b9c4b0; line-height: 1.4; }
@media (pointer: coarse) { .ex-touch { display: block; } .ex-keyboard { display: none; } }
@media (max-width: 700px) {
  .ex-preview { left: 16px; right: 16px; top: auto; bottom: 150px; width: auto; padding: 13px 16px; }
  .ex-preview .ex-eyebrow, .ex-preview small { display: none; }
  .ex-preview h2 { font-size: 21px; margin-bottom: 5px; }
  .ex-preview .ex-summary { -webkit-line-clamp: 2; font-size: 12px; }
  .ex-tools { left: 16px; bottom: 16px; gap: 5px; }
  .ex-tools button { padding: 8px 10px; font-size: 12px; }
  .ex-marker { font-size: 10px !important; }
  .ex-hint { display: none; }
}
@media (prefers-reduced-motion: reduce) { .ex-layer * { transition: none !important; animation: none !important; } }
`;

function injectCss(): void {
  if (document.getElementById("ex-layer-css")) return;
  const s = document.createElement("style");
  s.id = "ex-layer-css";
  s.textContent = CSS;
  document.head.append(s);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

const coarse = () => window.matchMedia?.("(pointer: coarse)").matches === true;

export class ExhibitLayer {
  private works: WalkWork[] = [];
  private state: NavigationState = "paused";
  private preview: string | null = null;
  private targeted: string | null = null;
  private dragOnly = false;
  private wasLocked = false;
  private tracker = createPreviewTracker({ dwellMs: LAYER_TUNING.dwellMs, departureMs: LAYER_TUNING.departureMs });
  private readonly root = el("div", "ex-layer");
  private readonly markers = el("div", "ex-markers");
  private readonly target = el("span", "ex-target");
  private readonly card = el("aside", "ex-preview");
  private readonly cardTitle = el("h2");
  private readonly cardArtist = el("p", "ex-artist");
  private readonly cardSummary = el("p", "ex-summary");
  private readonly cardHint = el("small");
  private readonly guide = el("aside", "ex-guide");
  private readonly guideTitle = el("h2", "", "Explore the 3D tour");
  private readonly tools = el("nav", "ex-tools");
  private readonly resumeButton: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly hint = el("div", "ex-hint");
  private readonly markerById = new Map<string, HTMLButtonElement>();
  private readonly abort = new AbortController();
  private readonly v = new THREE.Vector3();
  private readonly ray = new THREE.Raycaster();
  private down: { x: number; y: number } | null = null;
  private readonly mpu: number;
  readonly tuning: { focusRange: number; lookAngleDeg: number; markerRange: number; dwellMs: number; departureMs: number } = { ...LAYER_TUNING };
  private focused: string | null = null;
  private readonly focusWidget = el("button", "ex-focus");
  private readonly debugGroup = new THREE.Group();
  private readonly debugSpheres = new Map<string, THREE.LineSegments>();
  private readonly debugPanel = el("aside", "ex-debug");
  private readonly debugReadout = el("pre");

  constructor(private readonly o: ExhibitLayerOptions) {
    injectCss();
    this.mpu = o.metresPerUnit && o.metresPerUnit > 0 ? o.metresPerUnit : 1;
    o.canvas.tabIndex = 0;
    o.canvas.setAttribute("aria-label", "Exhibition room. Click to explore, then use W A S D or the arrow keys to move and the mouse to look.");

    this.card.setAttribute("aria-live", "polite");
    this.card.setAttribute("aria-label", "Artwork in view");
    this.card.append(el("p", "ex-eyebrow", "IN VIEW"), this.cardTitle, this.cardArtist, this.cardSummary,
      button("ex-open", "View artwork ↗", () => this.preview && this.open(this.preview)), this.cardHint);
    this.card.hidden = true;

    this.guide.setAttribute("role", "dialog");
    this.guide.setAttribute("aria-label", "Explore the 3D tour");
    this.guideTitle.tabIndex = -1;
    const dl = el("dl");
    dl.innerHTML =
      '<div><dt>Move</dt><dd class="ex-keyboard"><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> or the arrow keys. Hold <kbd>Shift</kbd> to go faster.</dd>' +
      '<dd class="ex-touch">Drag on the left side of the screen.</dd></div>' +
      '<div><dt>Look</dt><dd class="ex-keyboard">Move the mouse. <kbd>Esc</kbd> pauses.</dd><dd class="ex-touch">Drag on the right side of the screen.</dd></div>' +
      '<div><dt>Find art</dt><dd>Look at an artwork, or select its marker, to open it.</dd></div>';
    this.guide.append(this.guideTitle, dl, button("ex-start", "Start exploring ↗", () => this.resume(this.dragOnly)));
    this.guide.hidden = true;

    this.resumeButton = button("ex-resume", "Resume exploring →", () => this.resume(false));
    this.pauseButton = button("ex-pause", "Pause", () => this.pause(true));
    this.tools.setAttribute("aria-label", "Walk controls");
    this.tools.append(
      this.resumeButton,
      button("ex-drag", "Use drag-to-look", () => this.resume(true)),
      button("ex-reset", "Reset view", () => {
        this.tracker.reset();
        this.setPreview(null);
        o.onReset();
      }),
      this.pauseButton,
    );

    this.focusWidget.type = "button";
    this.focusWidget.hidden = true;
    this.focusWidget.innerHTML = '<span class="ex-focus-ring" aria-hidden="true"></span><span class="ex-focus-label"></span>';
    this.focusWidget.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.focused) this.open(this.focused);
    });
    this.root.append(this.markers, this.focusWidget, this.target, this.card, this.guide, this.tools, this.hint);
    if (o.debug) this.buildDebug();
    o.ui.append(this.root);

    const opts = { signal: this.abort.signal };
    document.addEventListener("pointerlockchange", () => this.onLockChange(), opts);
    // Capture phase: decide before the walk input sees the click.
    o.canvas.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY }), { ...opts, capture: true });
    o.canvas.addEventListener("click", (e) => this.onCanvasClick(e), opts);
    window.addEventListener("keydown", (e) => this.onKey(e), opts);
    this.sync();
  }

  get navigation(): NavigationState {
    return this.state;
  }

  get inView(): string | null {
    return this.preview;
  }

  get guideOpen(): boolean {
    return !this.guide.hidden;
  }

  get diagnostics() {
    return { navigation: this.state, preview: this.preview, targeted: this.targeted, guide: this.guideOpen, works: this.works.map((w) => w.id) };
  }

  setWorks(works: WalkWork[]): void {
    this.works = works;
    this.markers.replaceChildren();
    this.markerById.clear();
    for (const w of works) {
      const b = button("ex-marker", "Click to view", () => this.open(w.id));
      b.setAttribute("aria-label", `View ${w.title}`);
      b.dataset.work = w.id;
      b.hidden = true;
      this.markers.append(b);
      this.markerById.set(w.id, b);
    }
    if (this.preview && !works.some((w) => w.id === this.preview)) this.setPreview(null);
    if (this.o.debug) this.syncDebugSpheres();
  }

  /** The first-visit guide; walking starts from its button. */
  showGuide(): void {
    this.pause(false);
    this.guide.hidden = false;
    this.sync();
    this.guideTitle.focus({ preventScroll: true });
  }

  /** Show an artwork's in-view card (arriving at it, or back from its full card). */
  setPreview(id: string | null): void {
    const next = id && this.works.some((w) => w.id === id) ? id : null;
    if (next === this.preview) return;
    this.preview = next;
    this.tracker.reset(next);
    this.renderCard();
    this.o.onChange?.();
  }

  pause(focus = false): void {
    if (document.pointerLockElement === this.o.canvas) document.exitPointerLock();
    this.wasLocked = false;
    this.o.setSuspended(true);
    const changed = this.state !== "paused";
    this.state = "paused";
    this.sync();
    if (focus) this.resumeButton.focus({ preventScroll: true });
    if (changed) this.o.onChange?.();
  }

  resume(dragOnly = false): void {
    this.guide.hidden = true;
    this.dragOnly = dragOnly || coarse();
    this.o.allowPointerLock(!this.dragOnly);
    this.o.setSuspended(false);
    const changed = this.state !== "explore";
    this.state = "explore";
    if (!this.dragOnly && this.o.canvas.requestPointerLock) {
      try {
        const p = this.o.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        p?.catch?.(() => this.sync());
      } catch {
        /* Drag to look still works. */
      }
    }
    this.o.canvas.focus({ preventScroll: true });
    this.sync();
    if (changed) this.o.onChange?.();
  }

  /** Escape from the walk: true when it only paused (the host leaves the walk otherwise). */
  escape(): boolean {
    if (this.state === "explore") {
      this.pause(true);
      return true;
    }
    return false;
  }

  /** Per frame: markers, crosshair and the in-view card follow the camera. */
  update(now: number): void {
    const cam = this.o.camera;
    const eye: Vec3 = [cam.position.x, cam.position.y, cam.position.z];
    cam.getWorldDirection(this.v);
    const dir: Vec3 = [this.v.x, this.v.y, this.v.z];
    const exploring = this.state === "explore";

    const t = this.tuning, range = t.focusRange / this.mpu;
    if (exploring) {
      // One focused artwork drives the dot, the card, the centre widget and click / Enter.
      const raw = pickWork(eye, dir, this.works, range) ?? previewCandidate(eye, dir, this.works, (t.lookAngleDeg * Math.PI) / 180, range);
      this.focused = this.tracker.update(raw, now);
      this.targeted = this.focused;
      if (this.focused !== this.preview) {
        this.preview = this.focused;
        this.renderCard();
        this.o.onChange?.();
      }
    } else {
      this.targeted = null;
      this.focused = null;
    }
    this.target.classList.toggle("selectable", !!this.targeted);

    const w = this.o.canvas.clientWidth;
    const h = this.o.canvas.clientHeight;
    cam.updateMatrixWorld();
    for (const work of this.works) {
      const b = this.markerById.get(work.id);
      if (!b) continue;
      const camSpace = this.v.set(...work.anchor).applyMatrix4(cam.matrixWorldInverse);
      const lookAngle = Math.atan2(Math.hypot(camSpace.x, camSpace.y), -camSpace.z);
      const p = this.v.set(...work.anchor).project(cam);
      // The focused artwork shows its centre widget instead of its marker.
      const visible = work.id !== this.focused && camSpace.z < 0 && p.z < 1 && Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.88 && surfaceDistance(eye, work) <= t.markerRange / this.mpu && this.guide.hidden;
      b.hidden = !visible;
      if (!visible) continue;
      const s = widgetScale(lookAngle);
      b.style.left = `${((p.x + 1) / 2) * w}px`;
      b.style.top = `${((1 - p.y) / 2) * h}px`;
      b.style.setProperty("--s", s.toFixed(3));
      b.style.setProperty("--o", String(Math.round(s * 100)));
      b.classList.toggle("selected", work.id === this.targeted || work.id === this.preview);
    }
    this.placeFocusWidget(eye, w, h);
    if (this.o.debug) this.updateDebug(eye, dir);
  }

  /** The world-anchored widget at the focused artwork's centre: a ring sized by distance, and its title. */
  private placeFocusWidget(eye: Vec3, w: number, h: number): void {
    const work = this.focused ? this.works.find((x) => x.id === this.focused) : undefined;
    const cam = this.o.camera;
    if (!work) {
      this.focusWidget.hidden = true;
      return;
    }
    const camSpace = this.v.set(...work.center).applyMatrix4(cam.matrixWorldInverse);
    const p = this.v.set(...work.center).project(cam);
    if (camSpace.z >= 0 || p.z >= 1) {
      this.focusWidget.hidden = true;
      return;
    }
    const distance = Math.max(1e-6, Math.hypot(work.center[0] - eye[0], work.center[1] - eye[1], work.center[2] - eye[2]));
    // A ring a fifth of the artwork's sphere across, kept between 44 and 120 px.
    const px = ((work.radius * 0.4) / (distance * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2))) * (h / 2);
    this.focusWidget.hidden = false;
    this.focusWidget.style.left = `${Math.min(w - 24, Math.max(24, ((p.x + 1) / 2) * w))}px`;
    this.focusWidget.style.top = `${Math.min(h - 24, Math.max(24, ((1 - p.y) / 2) * h))}px`;
    this.focusWidget.style.setProperty("--ring", `${Math.round(Math.min(120, Math.max(44, px)))}px`);
    this.focusWidget.setAttribute("aria-label", `View ${work.title}`);
    (this.focusWidget.querySelector(".ex-focus-label") as HTMLElement).textContent = `${work.title} · click to view`;
  }

  private buildDebug(): void {
    this.debugGroup.name = "exhibit-debug";
    this.o.scene?.add(this.debugGroup);
    const row = (label: string, min: number, max: number, step: number, value: number, unit: string, set: (v: number) => void) => {
      const wrap = el("label");
      const out = el("output", "", `${value}${unit}`);
      const input = el("input");
      Object.assign(input, { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) });
      input.addEventListener("input", () => {
        const v = Number(input.value);
        out.textContent = `${v}${unit}`;
        set(v);
      });
      wrap.append(el("span", "", label), out, input);
      return wrap;
    };
    const t = this.tuning;
    this.debugPanel.append(el("p", "ex-eyebrow", "WALK DEBUG"));
    if (this.o.setEyeHeight && this.o.eyeHeight !== undefined)
      this.debugPanel.append(row("Eye height", 0.8, 3.5, 0.05, this.o.eyeHeight, " m", (v) => this.o.setEyeHeight?.(v)));
    this.debugPanel.append(
      row("Focus range", 1, 30, 0.5, t.focusRange, " m", (v) => (t.focusRange = v)),
      row("Look angle", 0, 20, 0.5, t.lookAngleDeg, "°", (v) => (t.lookAngleDeg = v)),
      row("Marker range", 5, 80, 1, t.markerRange, " m", (v) => (t.markerRange = v)),
      row("Card delay", 0, 600, 10, t.dwellMs, " ms", (v) => {
        t.dwellMs = v;
        this.tracker = createPreviewTracker({ dwellMs: t.dwellMs, departureMs: t.departureMs });
      }),
      this.debugReadout,
      el("p", "ex-debug-note", "Orange: artwork boxes and wall planes (look and pick). Red: marker anchors. Green: focused. Colours on the floor and walls: collision mesh. Shift+N toggles the collision mesh."),
    );
    this.root.append(this.debugPanel);
    this.syncDebugSpheres();
  }

  private syncDebugSpheres(): void {
    for (const l of this.debugSpheres.values()) {
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    this.debugGroup.clear();
    this.debugSpheres.clear();
    for (const w of this.works) {
      // The artwork's box, or its wall plane (no depth), as used for looking and clicking.
      const lines = new THREE.LineSegments(undefined, new THREE.LineBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.8, depthTest: false }));
      if (w.box) {
        const [hx, hy, hz] = w.box.half;
        const box = new THREE.BoxGeometry(hx * 2, hy * 2, Math.max(hz * 2, 1e-4));
        lines.geometry = new THREE.EdgesGeometry(box);
        box.dispose();
        const [a, b, c] = w.box.axes.map((v) => new THREE.Vector3(...v));
        lines.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(a, b, c));
      } else {
        const sphere = new THREE.SphereGeometry(w.radius, 16, 10);
        lines.geometry = new THREE.WireframeGeometry(sphere);
        sphere.dispose();
      }
      lines.position.set(...w.center);
      lines.renderOrder = 1001;
      const anchor = new THREE.Mesh(new THREE.OctahedronGeometry(w.radius * 0.06), new THREE.MeshBasicMaterial({ color: 0xff3060, depthTest: false }));
      // Children inherit the box's rotation: place the anchor in the box's own axes.
      anchor.position.set(w.anchor[0] - w.center[0], w.anchor[1] - w.center[1], w.anchor[2] - w.center[2]).applyQuaternion(lines.quaternion.clone().invert());
      anchor.renderOrder = 1002;
      lines.add(anchor);
      this.debugGroup.add(lines);
      this.debugSpheres.set(w.id, lines);
    }
  }

  private updateDebug(eye: Vec3, dir: Vec3): void {
    for (const [id, l] of this.debugSpheres) (l.material as THREE.LineBasicMaterial).color.setHex(id === this.focused ? 0x40e080 : 0xffa040);
    const m = this.mpu;
    const lines = this.works
      .map((w) => ({ w, d: surfaceDistance(eye, w) * m, a: THREE.MathUtils.radToDeg(lookOffset(eye, dir, w)) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 6)
      .map(({ w, d, a }) => `${w.id === this.focused ? "▶" : " "} ${w.id.padEnd(22).slice(0, 22)} ${d.toFixed(1).padStart(5)} m ${a.toFixed(1).padStart(5)}°`);
    this.debugReadout.textContent = `${this.state} · eye ${(eye[1] * m).toFixed(2)} (exhibition units ×${m})\nfocused: ${this.focused ?? "none"}\n${lines.join("\n")}`;
  }

  dispose(): void {
    this.abort.abort();
    this.root.remove();
    for (const l of this.debugSpheres.values()) l.geometry.dispose();
    this.debugGroup.removeFromParent();
  }

  // ------------------------------------------------------------- internals

  private open(id: string): void {
    this.pause(false);
    this.setPreview(id);
    this.o.onOpenWork(id);
  }

  private onLockChange(): void {
    const locked = document.pointerLockElement === this.o.canvas;
    // Esc released the mouse while walking: pause, like the old walk.
    if (!locked && this.wasLocked && this.state === "explore") this.pause(true);
    this.wasLocked = locked;
    this.sync();
  }

  private onCanvasClick(e: MouseEvent): void {
    const dragged = this.down ? Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5 : false;
    this.down = null;
    if (dragged || !this.guide.hidden) return;
    // The click that resumes walking only resumes, even over an artwork.
    if (this.state === "paused") {
      this.resume(this.dragOnly);
      return;
    }
    let id = this.targeted;
    if (document.pointerLockElement !== this.o.canvas) {
      const r = this.o.canvas.getBoundingClientRect();
      this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2), this.o.camera);
      const { origin: a, direction: d } = this.ray.ray;
      id = pickWork([a.x, a.y, a.z], [d.x, d.y, d.z], this.works, this.tuning.focusRange / this.mpu);
    }
    if (id) this.open(id);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key !== "Enter" || this.state !== "explore" || !this.targeted) return;
    if (e.target !== this.o.canvas && e.target !== document.body) return;
    e.preventDefault();
    this.open(this.targeted);
  }

  private renderCard(): void {
    const work = this.works.find((w) => w.id === this.preview);
    this.card.hidden = !work;
    if (!work) return;
    this.cardTitle.textContent = work.title;
    this.cardArtist.textContent = work.artist || "Artist information pending";
    this.cardSummary.textContent = work.summary ?? "";
    this.cardHint.textContent =
      document.pointerLockElement === this.o.canvas ? "Click the work to open it. Esc releases the cursor to use this card." : "Open the full view, then return to this spot.";
  }

  private sync(): void {
    const exploring = this.state === "explore";
    const locked = document.pointerLockElement === this.o.canvas;
    document.body.classList.toggle("ex-captured", locked);
    document.body.dataset.navigation = this.state;
    this.target.hidden = !exploring;
    this.tools.hidden = exploring || !this.guide.hidden;
    this.pauseButton.hidden = true;
    // While exploring without the mouse captured, a Pause button replaces Esc for touch and drag users.
    if (exploring && !locked) {
      this.tools.hidden = false;
      for (const b of this.tools.querySelectorAll("button")) b.hidden = b !== this.pauseButton;
    } else for (const b of this.tools.querySelectorAll("button")) b.hidden = b === this.pauseButton;
    this.hint.textContent = !exploring
      ? "Paused · Click the view to resume"
      : locked
        ? "Explore · Click a work to open it · Esc to pause"
        : coarse()
          ? "Explore · Left side moves · Right side looks"
          : "Explore · Drag to look · WASD or arrows to move · Shift to run";
    this.hint.hidden = !this.guide.hidden;
    this.renderCard();
  }
}
