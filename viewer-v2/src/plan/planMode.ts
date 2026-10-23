/**
 * Plan mode: orthographic section view of the splats plus PNG / JSON / GLB
 * export for tracing collision geometry in Rhino or Blender.
 *
 * Toggle with the "Plan (M)" button or the M key. While active:
 *  - Viewer.renderCamera is an OrthographicCamera looking along -n of the
 *    selected view (plan = straight down -Y);
 *  - a transparent surface over the canvas takes pointer input (drag = pan,
 *    wheel / pinch = zoom), so the 3D camera rig doesn't move underneath;
 *  - SectionCut hides splats above the cut and (optionally) below the floor.
 *
 * Elevation views (looking -Z or -X) use the same code with a different
 * frame (views.ts); add more views there.
 */
import * as THREE from "three";
import type { SplatMesh } from "@sparkjsdev/spark";
import type { FrameHook, Viewer } from "../viewer";
import { captureView, gpuTileLimit, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS } from "./capture";
import {
  buildPlaneGlb,
  buildSidecar,
  canvasToPng,
  hasSaveEndpoint,
  modelNameFromUrl,
  sanitizeName,
  saveFile,
  type PlanExportInfo,
} from "./exporters";
import { SectionCut } from "./section";
import { isTypingTarget } from "../ui/dom";
import {
  axisOf,
  frameRangeToWorld,
  placeOrthoCamera,
  VIEWS,
  worldRangeToFrame,
  type PlanViewDef,
  type PlanViewId,
  type ViewRegion,
} from "./views";
import "./plan.css";

/**
 * Where exports go in the scene editor: the scene's nav/ folder
 * (POST /__scenes/nav-file). Without one, exports use the v1 /__plan-export
 * endpoint (assets/nav/<model>/) for ?model= debugging.
 */
export interface PlanSaveTarget {
  /** Shown in the panel, e.g. "scenes/oculus/nav/". */
  label: string;
  save(file: string, blob: Blob): Promise<string>;
  /** Called after all files of one export were saved. */
  onExported?(files: string[]): void;
  /** A warning to show while the panel is open (e.g. transform changed since the build), or null. */
  warning?(): string | null;
}

interface SectionState {
  cut: number;
  cutOn: boolean;
  floor: number;
  floorOn: boolean;
}

interface Bounds {
  /** Robust (0.5%..99.5% of splat centres) box, used for framing and defaults. */
  robust: THREE.Box3;
  /** Low percentile (2%) along each axis, used as a floor guess. */
  low: THREE.Vector3;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

const fmt = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : "—");

function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

export class PlanMode {
  active = false;
  private readonly target: PlanSaveTarget | null;
  private view: PlanViewDef = VIEWS.plan;
  private readonly sections = new Map<PlanViewId, SectionState>();
  private readonly regions = new Map<PlanViewId, ViewRegion>();
  private bounds: Bounds | null = null;
  private boundsVersion = -1;
  private readonly section = new SectionCut();
  private readonly cam = new THREE.OrthographicCamera();
  /** Interactive view: centre in frame coords and half height in metres. */
  private center = new THREE.Vector2();
  private halfHeight = 5;
  private capturing = false;
  private picking: "cut" | "floor" | null = null;
  private savedSpark: { coneFoveate: number; behindFoveate: number; sortRadial: boolean; lodRenderScale: number } | null = null;
  private readonly frameHook: FrameHook = () => this.updateCamera();

  // DOM
  private readonly toggleButton: HTMLButtonElement;
  private readonly surface: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly inputs: Record<string, HTMLInputElement> = {};
  private readonly viewSelect: HTMLSelectElement;
  private readonly bgSelect: HTMLSelectElement;
  private readonly labels: Record<string, HTMLElement> = {};
  private readonly sizeLine: HTMLDivElement;
  private readonly exportButton: HTMLButtonElement;
  private readonly warnLine: HTMLDivElement;

  constructor(
    root: HTMLElement,
    private readonly viewer: Viewer,
    opts: { dock?: HTMLElement; target?: PlanSaveTarget } = {},
  ) {
    this.target = opts.target ?? null;
    this.toggleButton = el("button", {
      className: "plan-toggle",
      textContent: "Plan (M)",
      title: "Orthographic section view and plan export (M)",
      onclick: () => this.toggle(),
    });

    this.surface = el("div", { className: "plan-surface", hidden: true });
    this.bindSurface();

    const num = (key: string, step: string, title = ""): HTMLInputElement => {
      const input = el("input", { type: "number", step, title });
      input.addEventListener("change", () => this.onInput(key));
      this.inputs[key] = input;
      return input;
    };
    const check = (key: string): HTMLInputElement => {
      const input = el("input", { type: "checkbox" });
      input.addEventListener("change", () => this.onInput(key));
      this.inputs[key] = input;
      return input;
    };
    const text = (key: string, placeholder: string): HTMLInputElement => {
      const input = el("input", { type: "text", placeholder, spellcheck: false });
      input.addEventListener("change", () => this.onInput(key));
      this.inputs[key] = input;
      return input;
    };
    const range = (key: string): HTMLInputElement => {
      const input = el("input", { type: "range", step: "0.01" });
      input.addEventListener("input", () => this.onInput(key));
      this.inputs[key] = input;
      return input;
    };
    const label = (key: string, textContent = ""): HTMLElement => (this.labels[key] = el("span", { textContent }));

    this.viewSelect = el(
      "select",
      { onchange: () => this.setView(this.viewSelect.value as PlanViewId) },
      Object.values(VIEWS).map((v) => el("option", { value: v.id, textContent: v.title })),
    );
    this.bgSelect = el("select", { onchange: () => this.updateSizeLine() }, [
      el("option", { value: "transparent", textContent: "Transparent" }),
      el("option", { value: "solid", textContent: "Solid" }),
    ]);
    this.sizeLine = el("div", { className: "plan-note" });
    this.status = el("div", { className: "plan-status" });
    this.exportButton = el("button", {
      className: "plan-primary",
      textContent: "Export PNG + JSON + GLB",
      onclick: () => void this.export(),
    });

    const row = (...children: (Node | string)[]) => el("div", { className: "plan-row" }, children);
    this.warnLine = el("div", { className: "panel-note warn", hidden: true });
    this.panel = el("div", { className: "plan-panel", hidden: true }, [
      el("div", { className: "plan-head" }, [
        el("strong", { textContent: "Plan export" }),
        el("button", { textContent: "Close", title: "Back to 3D view (M)", onclick: () => this.setActive(false) }),
      ]),
      this.warnLine,
      row(this.viewSelect),
      el("div", { className: "plan-sub" }, [label("cutTitle")]),
      row(
        check("cutOn"),
        num("cut", "0.05"),
        "m",
        range("cutRange"),
        el("button", { textContent: "Pick", title: "Click a surface in the 3D view", onclick: () => this.startPick("cut") }),
      ),
      el("div", { className: "plan-sub" }, [label("floorTitle")]),
      row(
        check("floorOn"),
        num("floor", "0.05"),
        "m",
        range("floorRange"),
        el("button", { textContent: "Pick", title: "Click a surface in the 3D view", onclick: () => this.startPick("floor") }),
      ),
      el("div", { className: "plan-sub" }, ["Export region (world, m)"]),
      row(label("ax0"), num("a0min", "0.1"), "to", num("a0max", "0.1")),
      row(label("ax1"), num("a1min", "0.1"), "to", num("a1max", "0.1")),
      row(
        el("button", { textContent: "Fit model", title: "Region = splat bounds (0.5–99.5 percentile) + 0.25 m", onclick: () => this.fitRegion() }),
        el("button", { textContent: "Use view", title: "Region = what is on screen now", onclick: () => this.regionFromView() }),
        el("button", { textContent: "Frame region", onclick: () => this.frameRegion() }),
      ),
      el("div", { className: "plan-sub" }, ["Capture"]),
      row(num("ppm", "10", "Pixels per metre"), "px/m", this.bgSelect, (this.inputs.bg = el("input", { type: "color", value: "#ffffff" }))),
      row("Budget", num("budget", "500000", "Splat budget while capturing"), "Settle", num("settle", "0.5", "Seconds LoD must stay idle"), "s"),
      this.sizeLine,
      el("div", { className: "plan-sub" }, [this.target ? `Output: ${this.target.label}plan-<label>.*` : "Output: assets/nav/<model>/plan-<label>.*"]),
      this.target ? row("Label", text("label", "label")) : row("Model", text("model", "model"), "Label", text("label", "label")),
      row(this.exportButton),
      this.status,
    ]);
    this.inputs.bg.addEventListener("input", () => this.updateSizeLine());

    this.hint = el("div", { className: "plan-hint", hidden: true });

    // Surface first so the rest of the UI (perf overlay, cards) stays clickable above it.
    root.prepend(this.surface);
    root.append(this.toggleButton, this.hint);
    (opts.dock ?? root).append(this.panel);
    this.panel.querySelector(".plan-head strong")?.addEventListener("click", () => this.panel.classList.toggle("collapsed"));

    // Defaults.
    this.inputs.ppm.value = "100";
    this.inputs.settle.value = "1.5";
    this.inputs.budget.value = String(Math.max(4_000_000, Math.round(viewer.budget * 2)));
    if (this.inputs.model) this.inputs.model.value = viewer.config.models[0] ? modelNameFromUrl(viewer.config.models[0].url) : "model";
    this.inputs.label.value = "";

    window.addEventListener("keydown", (e) => {
      if (isTypingTarget(e.target)) return;
      if (e.code === "KeyM" && !e.ctrlKey && !e.metaKey && !e.altKey) this.toggle();
      else if (e.code === "Escape" && this.picking) this.endPick(null);
    });
    viewer.renderer.domElement.addEventListener("pointerdown", (e) => this.onPickPointerDown(e));
    viewer.renderer.domElement.addEventListener("pointerup", (e) => this.onPickPointerUp(e));

    if (!this.target) void hasSaveEndpoint().then((ok) => {
      if (!ok) this.setStatus("No dev server: files will be downloaded instead of written to assets/nav/.");
    });
  }

  toggle(): void {
    if (this.capturing) return;
    if (this.picking) this.endPick(null);
    this.setActive(!this.active);
  }

  get meshes(): SplatMesh[] {
    return this.viewer.models.flatMap((m) => (m.ready && m.mesh ? [m.mesh] : []));
  }

  setActive(on: boolean): void {
    if (on === this.active || this.capturing) return;
    if (on && !this.viewer.spark) {
      this.flashHint("Plan needs the Spark renderer: open the page without ?renderer=gsl", 4000);
      return;
    }
    if (on && this.meshes.length === 0) {
      this.flashHint("Load a model first", 2500);
      return;
    }
    this.active = on;
    this.panel.hidden = !on;
    this.panel.classList.remove("collapsed");
    this.surface.hidden = !on;
    const warn = on ? (this.target?.warning?.() ?? null) : null;
    this.warnLine.hidden = !warn;
    this.warnLine.textContent = warn ?? "";
    this.toggleButton.classList.toggle("on", on);
    const spark = this.viewer.requireSpark();
    if (on) {
      if (!this.bounds || this.boundsVersion !== this.viewer.modelsVersion) {
        this.bounds = this.computeBounds();
        this.boundsVersion = this.viewer.modelsVersion;
      }
      this.section.install(this.meshes);
      // Orthographic view: no foveation (large off-axis angles), Z-depth sort.
      this.savedSpark = {
        coneFoveate: spark.coneFoveate,
        behindFoveate: spark.behindFoveate,
        sortRadial: spark.sortRadial,
        lodRenderScale: spark.lodRenderScale,
      };
      spark.coneFoveate = 1;
      spark.behindFoveate = 1;
      spark.sortRadial = false;
      this.viewer.onFrame.push(this.frameHook);
      this.setView(this.view.id, true);
    } else {
      this.section.uninstall();
      if (this.savedSpark) Object.assign(spark, this.savedSpark);
      this.savedSpark = null;
      const i = this.viewer.onFrame.indexOf(this.frameHook);
      if (i >= 0) this.viewer.onFrame.splice(i, 1);
      this.viewer.renderCamera = null;
    }
  }

  // --- bounds, defaults --------------------------------------------------

  /** Robust bounds from splat centres (CPU copies; for paged meshes, what is loaded now). */
  private computeBounds(): Bounds {
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    for (const mesh of this.meshes) {
      try {
        mesh.updateMatrixWorld(true);
        const m = mesh.matrixWorld;
        const identity = m.equals(new THREE.Matrix4());
        const p = new THREE.Vector3();
        // Plain meshes: their splats. Paged: the LoD splats loaded right now.
        // In-browser LoD (lod=1) moves the splats into packedSplats/extSplats.lodSplats.
        const sources = [mesh, mesh.packedSplats?.lodSplats, mesh.extSplats?.lodSplats];
        for (const src of sources) {
          if (!src) continue;
          const count = src === mesh ? mesh.numSplats : src.numSplats;
          const stride = Math.max(1, Math.ceil((count || 1) / 400_000)); // ~400k samples max
          const before = xs.length;
          src.forEachSplat((i, center) => {
            if (i % stride !== 0) return;
            p.copy(center);
            if (!identity) p.applyMatrix4(m);
            xs.push(p.x);
            ys.push(p.y);
            zs.push(p.z);
          });
          if (xs.length > before) break;
        }
      } catch (err) {
        console.warn("plan: bounds failed for a mesh", err);
      }
    }
    if (xs.length === 0) {
      const t = this.viewer.camera.position;
      return {
        robust: new THREE.Box3(t.clone().subScalar(10), t.clone().addScalar(10)),
        low: t.clone().subScalar(1.5),
      };
    }
    const sx = Float32Array.from(xs).sort();
    const sy = Float32Array.from(ys).sort();
    const sz = Float32Array.from(zs).sort();
    return {
      robust: new THREE.Box3(
        new THREE.Vector3(percentile(sx, 0.005), percentile(sy, 0.005), percentile(sz, 0.005)),
        new THREE.Vector3(percentile(sx, 0.995), percentile(sy, 0.995), percentile(sz, 0.995)),
      ),
      low: new THREE.Vector3(percentile(sx, 0.02), percentile(sy, 0.02), percentile(sz, 0.02)),
    };
  }

  /** [lo, hi] of dot(p, v) over the robust box. */
  private boundsAlong(v: THREE.Vector3): [number, number] {
    const b = this.bounds!.robust;
    const { axis } = axisOf(v);
    return worldRangeToFrame(v, b.min[axis], b.max[axis]);
  }

  private defaultSection(view: PlanViewDef): SectionState {
    const [lo, hi] = this.boundsAlong(view.n);
    if (view.id === "plan") {
      const floor = this.bounds!.low.y;
      return { cut: Math.min(hi, floor + 1.2), cutOn: true, floor, floorOn: false };
    }
    return { cut: (lo + hi) / 2, cutOn: true, floor: lo, floorOn: false };
  }

  private boundsRegion(view: PlanViewDef): ViewRegion {
    const [r0, r1] = this.boundsAlong(view.right);
    const [u0, u1] = this.boundsAlong(view.up);
    const m = 0.25;
    const snap = (v: number, up: boolean) => (up ? Math.ceil(v * 10) / 10 : Math.floor(v * 10) / 10);
    return { r0: snap(r0 - m, false), r1: snap(r1 + m, true), u0: snap(u0 - m, false), u1: snap(u1 + m, true) };
  }

  private get state(): SectionState {
    let s = this.sections.get(this.view.id);
    if (!s) {
      s = this.defaultSection(this.view);
      this.sections.set(this.view.id, s);
    }
    return s;
  }

  private get region(): ViewRegion {
    let r = this.regions.get(this.view.id);
    if (!r) {
      r = this.boundsRegion(this.view);
      this.regions.set(this.view.id, r);
    }
    return r;
  }

  // --- view / camera ------------------------------------------------------

  setView(id: PlanViewId, reframe = false): void {
    const changed = id !== this.view.id;
    this.view = VIEWS[id];
    this.viewSelect.value = id;
    this.labels.cutTitle.textContent = this.view.cutLabel;
    this.labels.floorTitle.textContent = this.view.floorLabel;
    this.labels.ax0.textContent = axisOf(this.view.right).axis.toUpperCase();
    this.labels.ax1.textContent = axisOf(this.view.up).axis.toUpperCase();
    if (changed || reframe) this.frameRegion();
    this.applySection();
    this.syncInputs();
  }

  private frameRegion(): void {
    const r = this.region;
    this.center.set((r.r0 + r.r1) / 2, (r.u0 + r.u1) / 2);
    const el = this.viewer.renderer.domElement;
    const aspect = el.clientWidth / Math.max(1, el.clientHeight);
    this.halfHeight = Math.max((r.u1 - r.u0) / 2, (r.r1 - r.r0) / 2 / aspect) * 1.08;
  }

  /** Depths (along n) for the camera and the far end of the frustum. */
  private depths(): { camDepth: number; farDepth: number } {
    const [lo, hi] = this.boundsAlong(this.view.n);
    const s = this.state;
    const top = s.cutOn ? s.cut : Math.max(hi, s.cut) + 2;
    const bottom = s.floorOn ? s.floor : Math.min(lo, s.floor) - 2;
    return { camDepth: top + 0.25, farDepth: bottom - 0.25 };
  }

  private updateCamera(): void {
    if (!this.active || this.capturing) return;
    const canvas = this.viewer.renderer.domElement;
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const hh = this.halfHeight;
    const hw = hh * aspect;
    const { camDepth, farDepth } = this.depths();
    placeOrthoCamera(
      this.cam,
      this.view,
      { r0: this.center.x - hw, r1: this.center.x + hw, u0: this.center.y - hh, u1: this.center.y + hh },
      camDepth,
      farDepth,
    );
    // Spark's LoD traversal sizes splats by distance from the camera even for an
    // orthographic camera, so scale the pixel limit by the farthest visible distance.
    const base = this.savedSpark?.lodRenderScale ?? 1;
    const dMax = Math.hypot(hw, hh, camDepth - farDepth);
    this.viewer.requireSpark().lodRenderScale = this.picking ? base : base / Math.max(1, dMax);
    this.viewer.renderCamera = this.picking ? null : this.cam;
  }

  private bindSurface(): void {
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    const metresPerCssPx = () => (2 * this.halfHeight) / Math.max(1, this.surface.clientHeight);
    const zoomAt = (clientX: number, clientY: number, factor: number) => {
      const rect = this.surface.getBoundingClientRect();
      const mpp = metresPerCssPx();
      const dx = (clientX - rect.left - rect.width / 2) * mpp;
      const dy = (clientY - rect.top - rect.height / 2) * mpp;
      // Keep the world point under the cursor fixed.
      const r = this.center.x + dx;
      const u = this.center.y - dy;
      const before = this.halfHeight;
      this.halfHeight = THREE.MathUtils.clamp(before * factor, 0.05, 5000);
      const k = this.halfHeight / before;
      this.center.set(r - dx * k, u + dy * k);
    };
    this.surface.addEventListener("pointerdown", (e) => {
      this.surface.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    this.surface.addEventListener("pointermove", (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const mpp = metresPerCssPx();
      if (pointers.size === 1) {
        this.center.x -= (e.clientX - prev.x) * mpp;
        this.center.y += (e.clientY - prev.y) * mpp;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0 && d > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinchDist / d);
        pinchDist = d;
      }
    });
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      pinchDist = 0;
    };
    this.surface.addEventListener("pointerup", up);
    this.surface.addEventListener("pointercancel", up);
    this.surface.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
      },
      { passive: false },
    );
  }

  // --- section ----------------------------------------------------------

  private applySection(): void {
    const s = this.state;
    if (this.picking) this.section.set(this.view.n, null, null);
    else this.section.set(this.view.n, s.cutOn ? s.cut : null, s.floorOn ? s.floor : null);
  }

  private onInput(key: string): void {
    const s = this.state;
    const v = (k: string) => Number(this.inputs[k].value);
    switch (key) {
      case "cut":
      case "cutRange":
        if (Number.isFinite(v(key))) s.cut = v(key);
        break;
      case "floor":
      case "floorRange":
        if (Number.isFinite(v(key))) s.floor = v(key);
        break;
      case "cutOn":
        s.cutOn = this.inputs.cutOn.checked;
        break;
      case "floorOn":
        s.floorOn = this.inputs.floorOn.checked;
        break;
      case "a0min":
      case "a0max":
      case "a1min":
      case "a1max": {
        const [r0, r1] = worldRangeToFrame(this.view.right, v("a0min"), v("a0max"));
        const [u0, u1] = worldRangeToFrame(this.view.up, v("a1min"), v("a1max"));
        if ([r0, r1, u0, u1].every(Number.isFinite) && r1 > r0 && u1 > u0) this.regions.set(this.view.id, { r0, r1, u0, u1 });
        break;
      }
      case "model":
        this.inputs.model.value = sanitizeName(this.inputs.model.value, 100) || "model";
        break;
      case "label":
        this.inputs.label.value = sanitizeName(this.inputs.label.value);
        break;
    }
    this.applySection();
    this.syncInputs(key);
  }

  /** Push state into the inputs (skipping the one being edited). */
  private syncInputs(skip?: string): void {
    const s = this.state;
    const set = (k: string, v: string) => {
      if (k !== skip) this.inputs[k].value = v;
    };
    const [lo, hi] = this.boundsAlong(this.view.n);
    const span = Math.max(1, hi - lo);
    for (const k of ["cutRange", "floorRange"]) {
      this.inputs[k].min = fmt(Math.min(lo - 0.1 * span, s.floor, s.cut));
      this.inputs[k].max = fmt(Math.max(hi + 0.1 * span, s.floor, s.cut));
    }
    set("cut", fmt(s.cut));
    set("cutRange", String(s.cut));
    set("floor", fmt(s.floor));
    set("floorRange", String(s.floor));
    this.inputs.cutOn.checked = s.cutOn;
    this.inputs.floorOn.checked = s.floorOn;
    const r = this.region;
    const [a0min, a0max] = frameRangeToWorld(this.view.right, r.r0, r.r1);
    const [a1min, a1max] = frameRangeToWorld(this.view.up, r.u0, r.u1);
    set("a0min", fmt(a0min));
    set("a0max", fmt(a0max));
    set("a1min", fmt(a1min));
    set("a1max", fmt(a1max));
    if (!this.inputs.label.dataset.edited && skip !== "label") this.inputs.label.value = this.defaultLabel();
    if (skip === "label") this.inputs.label.dataset.edited = this.inputs.label.value ? "1" : "";
    this.updateSizeLine();
  }

  private defaultLabel(): string {
    const s = this.state;
    const a = this.view.axis.toLowerCase();
    const base = this.view.id === "plan" ? "" : `${this.view.id}-`;
    return sanitizeName(`${base}${a}${fmt(s.cutOn ? s.cut : s.floor)}`);
  }

  private fitRegion(): void {
    this.bounds = this.computeBounds();
    this.regions.set(this.view.id, this.boundsRegion(this.view));
    this.frameRegion();
    this.syncInputs();
  }

  private regionFromView(): void {
    const canvas = this.viewer.renderer.domElement;
    const hw = this.halfHeight * (canvas.clientWidth / Math.max(1, canvas.clientHeight));
    const hh = this.halfHeight;
    const q = (v: number) => Math.round(v * 100) / 100;
    this.regions.set(this.view.id, {
      r0: q(this.center.x - hw),
      r1: q(this.center.x + hw),
      u0: q(this.center.y - hh),
      u1: q(this.center.y + hh),
    });
    this.syncInputs();
  }

  /** Region snapped outward to the pixel grid (min corner on a multiple of mpp). */
  private exportRegion(mpp: number): { region: ViewRegion; width: number; height: number } {
    const r = this.region;
    const eps = 1e-9;
    const r0 = Math.floor(r.r0 / mpp + eps) * mpp;
    const u0 = Math.floor(r.u0 / mpp + eps) * mpp;
    const width = Math.max(1, Math.ceil((r.r1 - r0) / mpp - eps));
    const height = Math.max(1, Math.ceil((r.u1 - u0) / mpp - eps));
    return { region: { r0, r1: r0 + width * mpp, u0, u1: u0 + height * mpp }, width, height };
  }

  private updateSizeLine(): void {
    const ppm = Number(this.inputs.ppm.value);
    this.inputs.bg.hidden = this.bgSelect.value !== "solid";
    if (!(ppm > 0)) {
      this.sizeLine.textContent = "Set px/m > 0";
      return;
    }
    const { width, height } = this.exportRegion(1 / ppm);
    const tile = Math.min(4096, gpuTileLimit(this.viewer.webgl));
    const tiles = Math.ceil(width / tile) * Math.ceil(height / tile);
    const tooBig = width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS;
    this.sizeLine.textContent = `${width} × ${height} px, ${tiles} tile${tiles > 1 ? "s" : ""} of ≤ ${tile} px${tooBig ? " (too large!)" : ""}`;
    this.sizeLine.classList.toggle("bad", tooBig);
  }

  // --- pick height from the 3D view ----------------------------------------

  private pickDown: { x: number; y: number } | null = null;

  private startPick(which: "cut" | "floor"): void {
    if (this.capturing) return;
    this.picking = which;
    this.surface.hidden = true;
    this.panel.classList.add("dim");
    this.applySection();
    this.viewer.renderCamera = null;
    this.flashHint(`Click a surface in the 3D view to set ${which === "cut" ? this.view.cutLabel : this.view.floorLabel}. Esc cancels.`);
  }

  private endPick(value: number | null): void {
    const which = this.picking;
    this.picking = null;
    this.surface.hidden = !this.active;
    this.panel.classList.remove("dim");
    this.hint.hidden = true;
    if (which && value !== null) {
      const s = this.state;
      if (which === "cut") {
        s.cut = value;
        s.cutOn = true;
      } else {
        s.floor = value;
      }
    }
    this.applySection();
    this.syncInputs();
    if (which && value !== null) this.setStatus(`${which === "cut" ? "Cut" : "Floor"} set to ${this.view.axis} = ${fmt(value, 3)} m`);
  }

  private onPickPointerDown(e: PointerEvent): void {
    if (this.picking && e.button === 0) this.pickDown = { x: e.clientX, y: e.clientY };
  }

  private onPickPointerUp(e: PointerEvent): void {
    if (!this.picking || !this.pickDown) return;
    const moved = Math.hypot(e.clientX - this.pickDown.x, e.clientY - this.pickDown.y);
    this.pickDown = null;
    if (moved > 5) return; // a drag (orbit), not a click
    const canvas = this.viewer.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.viewer.camera);
    const hits = raycaster.intersectObjects(this.meshes, false);
    if (hits.length === 0) {
      this.flashHint("No splat under the cursor; try again (Esc cancels).");
      return;
    }
    this.endPick(Math.round(hits[0].point.dot(this.view.n) * 1000) / 1000);
  }

  // --- export -------------------------------------------------------------

  private async export(): Promise<void> {
    if (this.capturing || !this.active) return;
    const ppm = Number(this.inputs.ppm.value);
    if (!(ppm > 0)) return this.setStatus("Set px/m > 0", true);
    const mpp = 1 / ppm;
    const { region, width, height } = this.exportRegion(mpp);
    const s = this.state;
    const transparent = this.bgSelect.value !== "solid";
    const bgColor = new THREE.Color(this.inputs.bg.value);
    const model = this.target ? "" : sanitizeName(this.inputs.model.value, 100) || "model";
    const label = sanitizeName(this.inputs.label.value) || this.defaultLabel() || "plan";
    const files = { png: `plan-${label}.png`, json: `plan-${label}.json`, glb: `plan-${label}.glb` };
    const { camDepth, farDepth } = this.depths();
    const budget = Number(this.inputs.budget.value) > 0 ? Number(this.inputs.budget.value) : 4_000_000;
    const settleMs = Math.max(0.2, Number(this.inputs.settle.value) || 1.5) * 1000;

    this.capturing = true;
    this.exportButton.disabled = true;
    this.panel.classList.add("busy");
    try {
      const cap = await captureView(this.viewer, {
        view: this.view,
        region,
        metresPerPixel: mpp,
        camDepth,
        farDepth,
        background: transparent ? null : bgColor,
        budget,
        settleMs,
        timeoutMs: 120_000,
        detail: 1,
        onProgress: (msg) => this.setStatus(msg),
      });
      this.setStatus("Encoding PNG and GLB…");
      const info: PlanExportInfo = {
        view: this.view,
        region,
        metresPerPixel: mpp,
        width,
        height,
        planeDepth: s.floor,
        cut: s.cut,
        cutEnabled: s.cutOn,
        floor: s.floor,
        floorEnabled: s.floorOn,
        modelUrls: this.viewer.config.models.map((m) => m.url),
        modelName: model || modelNameFromUrl(this.viewer.config.models[0]?.url ?? "model"),
        label,
        background: transparent ? "transparent" : `#${bgColor.getHexString()}`,
        capture: {
          tiles: cap.tiles,
          tileSize: cap.tileSize,
          unsettledTiles: cap.unsettledTiles,
          splatBudget: cap.budget,
          maxActiveSplats: cap.maxActiveSplats,
          settleMs,
          durationS: Number((cap.durationMs / 1000).toFixed(1)),
          cameraDepth: Number(camDepth.toFixed(4)),
          sparkMaxStdDev: Number(this.viewer.requireSpark().maxStdDev.toFixed(4)),
        },
      };
      const sidecar = buildSidecar(info, files);
      const png = await canvasToPng(cap.canvas, ppm);
      const glb = await buildPlaneGlb(cap.canvas, info, { planExport: { schema: sidecar.schema, sidecar: files.json, world: sidecar.world, section: sidecar.section } });
      const saved: string[] = [];
      const put = (file: string, blob: Blob) => (this.target ? this.target.save(file, blob) : saveFile(model, file, blob));
      saved.push(await put(files.png, png));
      saved.push(await put(files.json, new Blob([JSON.stringify(sidecar, null, 2)], { type: "application/json" })));
      saved.push(await put(files.glb, new Blob([glb], { type: "model/gltf-binary" })));
      this.target?.onExported?.(saved);
      const warn = cap.unsettledTiles > 0 ? ` (${cap.unsettledTiles} tile(s) timed out before LoD settled)` : "";
      this.setStatus(`Saved ${width}×${height} px in ${(cap.durationMs / 1000).toFixed(1)} s${warn}:\n${saved.join("\n")}`, cap.unsettledTiles > 0);
      (window as unknown as { lastPlanExport?: unknown }).lastPlanExport = { sidecar, saved };
    } catch (err) {
      console.error(err);
      this.setStatus(`Export failed: ${(err as Error).message}`, true);
    } finally {
      this.capturing = false;
      this.exportButton.disabled = false;
      this.panel.classList.remove("busy");
    }
  }

  // --- misc UI ------------------------------------------------------------

  private setStatus(msg: string, bad = false): void {
    this.status.textContent = msg;
    this.status.classList.toggle("bad", bad);
  }

  private flashHint(msg: string, ms = 0): void {
    this.hint.textContent = msg;
    this.hint.hidden = false;
    window.clearTimeout((this.hint as unknown as { _t?: number })._t);
    if (ms > 0) (this.hint as unknown as { _t?: number })._t = window.setTimeout(() => (this.hint.hidden = true), ms);
  }
}

