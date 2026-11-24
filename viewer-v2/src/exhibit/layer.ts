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
  pickWork,
  previewCandidate,
  surfaceDistance,
  widgetScale,
  PREVIEW_DEFAULTS,
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
}

/** Distances in metres, as the old walk tuned them (its card range was 4 m; the splat paths are wider). */
export const LAYER_METRES = Object.freeze({ previewRange: 8, pickRange: 14, markerRange: 30 });

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
  private readonly tracker = createPreviewTracker();
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
  private readonly range: { previewRange: number; pickRange: number; markerRange: number };

  constructor(private readonly o: ExhibitLayerOptions) {
    injectCss();
    const mpu = o.metresPerUnit && o.metresPerUnit > 0 ? o.metresPerUnit : 1;
    this.range = { previewRange: LAYER_METRES.previewRange / mpu, pickRange: LAYER_METRES.pickRange / mpu, markerRange: LAYER_METRES.markerRange / mpu };
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

    this.root.append(this.markers, this.target, this.card, this.guide, this.tools, this.hint);
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

    this.targeted = exploring ? pickWork(eye, dir, this.works, this.range.pickRange) : null;
    this.target.classList.toggle("selectable", !!this.targeted);
    if (exploring) {
      const next = this.tracker.update(previewCandidate(eye, dir, this.works, (PREVIEW_DEFAULTS.angleDeg * Math.PI) / 180, this.range.previewRange), now);
      if (next !== this.preview) {
        this.preview = next;
        this.renderCard();
        this.o.onChange?.();
      }
    }

    const w = this.o.canvas.clientWidth;
    const h = this.o.canvas.clientHeight;
    cam.updateMatrixWorld();
    for (const work of this.works) {
      const b = this.markerById.get(work.id);
      if (!b) continue;
      const camSpace = this.v.set(...work.anchor).applyMatrix4(cam.matrixWorldInverse);
      const lookAngle = Math.atan2(Math.hypot(camSpace.x, camSpace.y), -camSpace.z);
      const p = this.v.set(...work.anchor).project(cam);
      const visible = camSpace.z < 0 && p.z < 1 && Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.88 && surfaceDistance(eye, work) <= this.range.markerRange && this.guide.hidden;
      b.hidden = !visible;
      if (!visible) continue;
      const s = widgetScale(lookAngle);
      b.style.left = `${((p.x + 1) / 2) * w}px`;
      b.style.top = `${((1 - p.y) / 2) * h}px`;
      b.style.setProperty("--s", s.toFixed(3));
      b.style.setProperty("--o", String(Math.round(s * 100)));
      b.classList.toggle("selected", work.id === this.targeted || work.id === this.preview);
    }
  }

  dispose(): void {
    this.abort.abort();
    this.root.remove();
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
      id = pickWork([a.x, a.y, a.z], [d.x, d.y, d.z], this.works, this.range.pickRange);
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
