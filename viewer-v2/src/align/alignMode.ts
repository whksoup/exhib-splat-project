/**
 * Align mode: author the scene transform (rotation, uniform scale, origin) of
 * the loaded model with a gizmo and number fields.
 *
 * The transform being edited is always ABSOLUTE, relative to the original
 * source file (scene.transform). Where it goes and how the mesh shows it is
 * decided by an AlignBinding:
 *   - scene editor: the transform lives in the scene store; the mesh shows
 *     T_new * T_built^-1 on a built .rad, or T_new on the source preview
 *     (src/scene/sceneMath.ts);
 *   - ?model= debug: a local transform applied straight to the file.
 * Build (scene editor) bakes it into the .rad; there is no separate JSON.
 *
 * Toggle with the Align button or G. While active:
 *  - a three.js TransformControls gizmo drives a proxy Object3D (`target`);
 *  - 1 / 2 / 3 switch translate / rotate / scale; scale is forced uniform
 *    (non-uniform scale has no exact mapping onto Gaussian covariances and SH);
 *  - camera input is suspended while the gizmo is dragged;
 *  - a grid on Y = 0, axes at the origin and a live bounds readout are shown.
 */
import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { SplatMesh } from "@sparkjsdev/spark";
import { composeTRS } from "../../../shared/scene-schema.mjs";
import { meshMatrixFor, meshTRSFor, type TRS } from "../scene/sceneMath";
import { el, isTypingTarget, kbd } from "../ui/dom";
import type { FrameHook, Viewer } from "../viewer";
import "../plan/plan.css";
import "./align.css";

type GizmoMode = "translate" | "rotate" | "scale";

/** Where the authored transform lives and what the loaded file already contains. */
export interface AlignBinding {
  /** Current absolute transform (relative to the original source). */
  get(): TRS;
  /** Store a new absolute transform; the binding also updates the mesh preview. */
  set(t: TRS): void;
  /** Transform baked into the loaded file (built .rad), or null when it is in raw source coordinates. */
  builtMatrix(): number[] | null;
  /** Optional "back to the built transform" action (shown when the transform differs from the build). */
  revertToBuilt?: () => void;
  /** One-line description of what is shown (e.g. "built .rad + delta preview"). */
  describe?: () => string;
}

/** Local binding for ?model= debugging: the transform is applied straight to the file. */
export function localAlignBinding(viewer: Viewer): AlignBinding {
  let t: TRS = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 };
  return {
    get: () => t,
    set: (n) => {
      t = n;
      // Every model hangs under viewer.root: moving the root moves them all.
      const m = meshTRSFor(composeTRS(t.position, t.quaternion, t.scale), null);
      viewer.root.position.set(...m.position);
      viewer.root.quaternion.set(...m.quaternion);
      viewer.root.scale.setScalar(m.scale);
      viewer.root.updateMatrixWorld(true);
    },
    builtMatrix: () => null,
    describe: () => "Debug (?model=): preview only, not saved. Open a scene to save and build.",
  };
}

interface BoundsInfo {
  min: THREE.Vector3;
  max: THREE.Vector3;
  /** 0.5 % .. 99.5 % of sampled splat centres per axis (ignores floaters). */
  robustMin: THREE.Vector3;
  robustMax: THREE.Vector3;
  /** 2 % of world Y: a floor guess. */
  lowY: number;
  samples: number;
}

/** Something with an `active` flag and setActive(), i.e. PlanMode (kept loose to avoid a cycle). */
interface ExclusiveMode {
  active: boolean;
  setActive(on: boolean): void;
}

const fmt = (v: number, d = 3): string => (Number.isFinite(v) ? v.toFixed(d) : "—");
const vec = (v: THREE.Vector3, d = 3) => `${fmt(v.x, d)}, ${fmt(v.y, d)}, ${fmt(v.z, d)}`;
const MAX_SAMPLES = 300_000;

function percentile(sorted: Float32Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

export class AlignMode {
  active = false;
  /** Holds the absolute transform being authored; the gizmo is attached to it. */
  readonly target = new THREE.Object3D();
  private readonly gizmo: TransformControls;
  private readonly helpers = new THREE.Group();
  private gizmoMode: GizmoMode = "rotate";
  private snap = true;
  /** Splat centres of every loaded part in Viewer.root's coordinates, sampled with a fixed stride (x, y, z, ...). */
  private samples: Float32Array | null = null;
  private samplesVersion = -1;
  private boundsDirty = true;
  private lastBoundsMs = 0;
  private bounds: BoundsInfo | null = null;
  private readonly frameHook: FrameHook = ({ now }) => this.onFrame(now);

  // DOM
  readonly toggleButton: HTMLButtonElement;
  readonly panel: HTMLDivElement;
  private readonly inputs: Record<string, HTMLInputElement> = {};
  private readonly modeButtons: Record<GizmoMode, HTMLButtonElement>;
  private readonly boundsLine: HTMLPreElement;
  private readonly status: HTMLDivElement;
  private readonly note: HTMLDivElement;
  private readonly revertButton: HTMLButtonElement;

  constructor(
    root: HTMLElement,
    private readonly viewer: Viewer,
    private readonly binding: AlignBinding,
    private readonly exclusive: ExclusiveMode[] = [],
    dock?: HTMLElement,
  ) {
    // Gizmo
    this.gizmo = new TransformControls(viewer.camera, viewer.renderer.domElement);
    this.gizmo.setMode(this.gizmoMode);
    this.gizmo.setSpace("world");
    this.gizmo.setRotationSnap(THREE.MathUtils.degToRad(15));
    this.gizmo.addEventListener("dragging-changed", (e) => viewer.rig.setSuspended(Boolean(e.value)));
    this.gizmo.addEventListener("objectChange", () => this.onGizmoChange());
    this.gizmo.getHelper().visible = false;
    viewer.scene.add(this.target, this.gizmo.getHelper());

    // Reference helpers: 1 m grid on Y = 0, axes at the origin (X red, Y green, Z blue).
    const grid = new THREE.GridHelper(40, 40, 0x8a8f99, 0x3a3d45);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    this.helpers.add(grid, new THREE.AxesHelper(1.5));
    this.helpers.visible = false;
    viewer.scene.add(this.helpers);

    // UI
    this.toggleButton = el("button", {
      className: "align-toggle",
      textContent: "Align (G)",
      title: "Rotate / scale / place the model (G)",
      onclick: () => this.toggle(),
    });
    const num = (key: string, step: string, title = ""): HTMLInputElement => {
      const input = el("input", { type: "number", step, title });
      input.addEventListener("change", () => this.onInput(key));
      this.inputs[key] = input;
      return input;
    };
    const check = (key: string, title: string, onchange: () => void): HTMLInputElement => {
      const input = el("input", { type: "checkbox", title });
      input.addEventListener("change", onchange);
      this.inputs[key] = input;
      return input;
    };
    const btn = (textContent: string | (Node | string)[], onclick: () => void, title = "") => {
      const b = el("button", { onclick, title });
      if (typeof textContent === "string") b.textContent = textContent;
      else b.append(...textContent);
      return b;
    };
    const row = (...children: (Node | string)[]) => el("div", { className: "plan-row" }, children);
    const sub = (text: string) => el("div", { className: "plan-sub" }, [text]);
    const rot90 = (axis: "x" | "y" | "z") =>
      row(
        `${axis.toUpperCase()}`,
        btn("−90°", () => this.rotateWorld(axis, -90), `Rotate −90° about world ${axis.toUpperCase()} (about the model's pivot)`),
        btn("+90°", () => this.rotateWorld(axis, 90), `Rotate +90° about world ${axis.toUpperCase()} (about the model's pivot)`),
      );

    this.modeButtons = {
      translate: btn(["Move", kbd("1")], () => this.setGizmoMode("translate")),
      rotate: btn(["Rotate", kbd("2")], () => this.setGizmoMode("rotate")),
      scale: btn(["Scale", kbd("3")], () => this.setGizmoMode("scale"), "Uniform scale only"),
    };
    this.boundsLine = el("pre", { className: "plan-status align-bounds" });
    this.status = el("div", { className: "plan-status" });
    this.note = el("div", { className: "panel-note" });
    this.revertButton = btn("Revert to built", () => {
      this.binding.revertToBuilt?.();
      this.refresh();
      this.setStatus("Transform reverted to the one in the current build.");
    }, "Back to the transform baked into the current build");

    const close = el("button", { textContent: "Close", title: "Close Align (G)", onclick: () => this.setActive(false) });
    this.panel = el("div", { className: "plan-panel align-panel", hidden: true }, [
      el("div", { className: "plan-head" }, [el("strong", { textContent: "Align" }), close]),
      this.note,
      row(this.modeButtons.translate, this.modeButtons.rotate, this.modeButtons.scale),
      row(el("label", {}, [check("snap", "Snap rotation to 15°", () => this.setSnap(this.inputs.snap.checked)), " 15° snap"])),
      sub("Position (m, where the source origin lands)"),
      row("X", num("px", "0.01"), "Y", num("py", "0.01"), "Z", num("pz", "0.01")),
      sub("Rotation (degrees, Euler order XYZ)"),
      row("X", num("rx", "1"), "Y", num("ry", "1"), "Z", num("rz", "1")),
      sub("Rotate 90° about a world axis"),
      rot90("x"),
      rot90("y"),
      rot90("z"),
      sub("Uniform scale"),
      row(num("s", "0.01", "Uniform scale factor"), "×"),
      sub("Origin"),
      row(
        btn(["Set origin at camera", kbd("O")], () => this.originAtCamera(), "Fly to the spot (camera height = floor level), then press: that point becomes 0,0,0"),
        btn("Centre on origin", () => this.centreXZ(), "Move the XZ centre of the (robust) bounds to 0,0"),
      ),
      row(
        "Floor Y",
        num("floor", "0.01", "Current world height of the floor"),
        "m",
        btn("Guess", () => this.guessFloor(), "2nd percentile of splat heights"),
        btn("Floor → Y=0", () => this.floorToZero(), "Shift the model so this height becomes Y = 0"),
      ),
      sub("Bounds (world, m; sampled splat centres)"),
      this.boundsLine,
      row(
        btn("Resample", () => this.resample(), "Re-read splat centres (paged models stream in over time)"),
        btn("Reset", () => this.reset(), "Identity: the source file's own coordinates"),
        this.revertButton,
      ),
      this.status,
    ]);
    // Clicking the title collapses the panel (keeps the gizmo active).
    this.panel.querySelector(".plan-head strong")?.addEventListener("click", () => this.panel.classList.toggle("collapsed"));
    root.append(this.toggleButton);
    (dock ?? root).append(this.panel);

    this.inputs.snap.checked = this.snap;
    this.syncModeButtons();
    this.refresh();

    window.addEventListener("keydown", (e) => {
      if (isTypingTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "KeyG") this.toggle();
      else if (this.active && e.code === "Digit1") this.setGizmoMode("translate");
      else if (this.active && e.code === "Digit2") this.setGizmoMode("rotate");
      else if (this.active && e.code === "Digit3") this.setGizmoMode("scale");
      else if (this.active && e.code === "KeyO") this.originAtCamera();
    });
  }

  get meshes(): SplatMesh[] {
    return this.viewer.models.flatMap((m) => (m.ready && m.mesh ? [m.mesh] : []));
  }

  toggle(): void {
    this.setActive(!this.active);
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    if (on && !this.viewer.spark) {
      this.setStatus("Align needs the Spark renderer: open the page without ?renderer=gsl.", true);
      this.flashToggle();
      return;
    }
    if (on && this.meshes.length === 0) {
      this.setStatus("Load a model first.", true);
      this.flashToggle();
      return;
    }
    this.active = on;
    this.panel.hidden = !on;
    this.panel.classList.remove("collapsed");
    this.toggleButton.classList.toggle("on", on);
    this.helpers.visible = on;
    const helper = this.gizmo.getHelper();
    if (on) {
      for (const m of this.exclusive) if (m.active) m.setActive(false);
      // First-person mode captures the mouse; the gizmo needs it.
      if (this.viewer.rig.mode === "walk") this.viewer.rig.setMode("orbit");
      this.refresh();
      this.gizmo.attach(this.target);
      helper.visible = true;
      if (!this.samples || this.samplesVersion !== this.viewer.modelsVersion) this.resample();
      this.viewer.onFrame.push(this.frameHook);
    } else {
      this.gizmo.detach();
      helper.visible = false;
      this.viewer.rig.setSuspended(false);
      const i = this.viewer.onFrame.indexOf(this.frameHook);
      if (i >= 0) this.viewer.onFrame.splice(i, 1);
    }
  }

  /** Re-read the transform from the binding (it changed elsewhere: revert, reload, build). */
  refresh(): void {
    const t = this.binding.get();
    this.target.position.set(...t.position);
    this.target.quaternion.set(...t.quaternion).normalize();
    this.target.scale.setScalar(t.scale);
    this.target.updateMatrixWorld(true);
    this.syncInputs();
    this.boundsDirty = true;
    this.note.textContent = this.binding.describe?.() ?? "";
    this.syncRevert();
  }

  // --- transform ------------------------------------------------------------

  private syncRevert(): void {
    const built = this.binding.builtMatrix();
    const m = this.target.matrix.elements;
    const same = !!built && built.every((v, i) => Math.abs(v - m[i]) < 1e-9 * Math.max(1, Math.abs(m[12]), Math.abs(m[13]), Math.abs(m[14])));
    this.revertButton.hidden = !this.binding.revertToBuilt || !built || same;
  }

  private currentTRS(): TRS {
    const t = this.target;
    return { position: t.position.toArray() as TRS["position"], quaternion: t.quaternion.toArray() as TRS["quaternion"], scale: t.scale.x };
  }

  /** Matrix on the mesh for the authored transform (delta on a built .rad). */
  private meshMatrix(): number[] {
    this.target.updateMatrix();
    return meshMatrixFor(this.target.matrix.toArray(), this.binding.builtMatrix());
  }

  private changed(skipInput?: string): void {
    this.target.updateMatrixWorld(true);
    this.binding.set(this.currentTRS());
    this.syncInputs(skipInput);
    this.boundsDirty = true;
    this.syncRevert();
  }

  private onGizmoChange(): void {
    if (this.gizmo.mode === "scale") {
      // Enforce uniform scale: take the component the user dragged.
      const s = this.target.scale;
      const axis = this.gizmo.axis ?? "XYZ";
      const pick = axis.includes("X") ? s.x : axis.includes("Y") ? s.y : s.z;
      s.setScalar(Math.max(1e-3, pick));
    }
    this.changed();
  }

  private rotateWorld(axis: "x" | "y" | "z", deg: number): void {
    const a = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
    this.target.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(a, THREE.MathUtils.degToRad(deg))).normalize();
    this.changed();
  }

  private reset(): void {
    this.target.position.set(0, 0, 0);
    this.target.quaternion.identity();
    this.target.scale.set(1, 1, 1);
    this.changed();
    this.setStatus("Reset to identity (the source file's own coordinates).");
  }

  private setGizmoMode(mode: GizmoMode): void {
    this.gizmoMode = mode;
    this.gizmo.setMode(mode);
    this.syncModeButtons();
  }

  private setSnap(on: boolean): void {
    this.snap = on;
    this.gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
  }

  private onInput(key: string): void {
    const v = Number(this.inputs[key].value);
    if (!Number.isFinite(v)) return this.syncInputs();
    const t = this.target;
    switch (key) {
      case "px": t.position.x = v; break;
      case "py": t.position.y = v; break;
      case "pz": t.position.z = v; break;
      case "rx": case "ry": case "rz": {
        const r = (k: string) => THREE.MathUtils.degToRad(Number(this.inputs[k].value) || 0);
        t.rotation.set(r("rx"), r("ry"), r("rz"), "XYZ");
        break;
      }
      case "s":
        if (v > 0) t.scale.setScalar(v);
        break;
      case "floor":
        return; // applied with "Floor → Y=0"
    }
    this.changed(key);
  }

  private centreXZ(): void {
    const b = this.computeBounds(true);
    if (!b) return this.setStatus("No splat samples yet: press Resample.", true);
    const cx = (b.robustMin.x + b.robustMax.x) / 2;
    const cz = (b.robustMin.z + b.robustMax.z) / 2;
    this.target.position.x -= cx;
    this.target.position.z -= cz;
    this.changed();
    this.setStatus(`Centred: moved by (${fmt(-cx)}, 0, ${fmt(-cz)}) m`);
  }

  /** M' = T(-o) * M: the camera's world position (its height taken as floor level) becomes 0,0,0. */
  private originAtCamera(): void {
    const o = this.viewer.camera.getWorldPosition(new THREE.Vector3());
    this.target.position.sub(o);
    // Keep the camera at the same spot relative to the model.
    this.viewer.rig.shift(o.clone().negate());
    this.inputs.floor.value = "0";
    this.changed();
    this.setStatus(`Origin set at camera (${fmt(o.x)}, ${fmt(o.y)}, ${fmt(o.z)}): that point is now 0,0,0`);
  }

  private guessFloor(): void {
    const b = this.computeBounds(true);
    if (b) this.inputs.floor.value = fmt(b.lowY);
    else this.setStatus("No splat samples yet: press Resample.", true);
  }

  private floorToZero(): void {
    const y = Number(this.inputs.floor.value);
    if (this.inputs.floor.value.trim() === "" || !Number.isFinite(y)) return this.setStatus("Enter the current floor height (or press Guess) first.", true);
    this.target.position.y -= y;
    this.inputs.floor.value = "0";
    this.changed();
    this.setStatus(`Floor at Y = ${fmt(y)} moved to Y = 0`);
  }

  // --- bounds ---------------------------------------------------------------

  /**
   * Sample splat centres of all parts (for paged meshes: what is loaded now) in
   * Viewer.root's coordinates, i.e. through each part's own mesh matrix (identity
   * unless the part was built with another transform). Bounds, centre-on-origin
   * and the floor guess therefore cover the whole scene.
   */
  private resample(): void {
    const xyz: number[] = [];
    const meshes = this.meshes;
    const perMesh = Math.max(1, Math.floor(MAX_SAMPLES / Math.max(1, meshes.length)));
    for (const mesh of meshes) {
      try {
        mesh.updateMatrix();
        const local = mesh.matrix.elements;
        const identity = mesh.matrix.equals(new THREE.Matrix4());
        const sources = [mesh, mesh.packedSplats?.lodSplats, mesh.extSplats?.lodSplats];
        for (const src of sources) {
          if (!src) continue;
          const count = src === mesh ? mesh.numSplats : src.numSplats;
          const stride = Math.max(1, Math.ceil((count || 1) / perMesh));
          const before = xyz.length;
          src.forEachSplat((i, c) => {
            if (i % stride !== 0) return;
            if (identity) xyz.push(c.x, c.y, c.z);
            else {
              const x = c.x, y = c.y, z = c.z;
              xyz.push(
                local[0] * x + local[4] * y + local[8] * z + local[12],
                local[1] * x + local[5] * y + local[9] * z + local[13],
                local[2] * x + local[6] * y + local[10] * z + local[14],
              );
            }
          });
          if (xyz.length > before) break;
        }
      } catch (err) {
        console.warn("align: sampling failed for a mesh", err);
      }
    }
    this.samples = xyz.length ? Float32Array.from(xyz) : null;
    this.samplesVersion = this.viewer.modelsVersion;
    this.boundsDirty = true;
  }

  private computeBounds(robust: boolean): BoundsInfo | null {
    const s = this.samples;
    if (!s) return null;
    const e = this.meshMatrix();
    const n = s.length / 3;
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const xs = robust ? new Float32Array(n) : null;
    const ys = robust ? new Float32Array(n) : null;
    const zs = robust ? new Float32Array(n) : null;
    for (let i = 0; i < n; i++) {
      const x = s[i * 3], y = s[i * 3 + 1], z = s[i * 3 + 2];
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      if (wx < min.x) min.x = wx; if (wx > max.x) max.x = wx;
      if (wy < min.y) min.y = wy; if (wy > max.y) max.y = wy;
      if (wz < min.z) min.z = wz; if (wz > max.z) max.z = wz;
      if (xs && ys && zs) { xs[i] = wx; ys[i] = wy; zs[i] = wz; }
    }
    if (!xs || !ys || !zs) {
      return { min, max, robustMin: this.bounds?.robustMin ?? min, robustMax: this.bounds?.robustMax ?? max, lowY: this.bounds?.lowY ?? min.y, samples: n };
    }
    xs.sort(); ys.sort(); zs.sort();
    return {
      min,
      max,
      robustMin: new THREE.Vector3(percentile(xs, 0.005), percentile(ys, 0.005), percentile(zs, 0.005)),
      robustMax: new THREE.Vector3(percentile(xs, 0.995), percentile(ys, 0.995), percentile(zs, 0.995)),
      lowY: percentile(ys, 0.02),
      samples: n,
    };
  }

  private onFrame(now: number): void {
    if (this.exclusive.some((m) => m.active)) {
      this.setActive(false); // another mode (plan) took over
      return;
    }
    if (this.samplesVersion !== this.viewer.modelsVersion) this.resample(); // model was rebuilt / reloaded
    // Live bounds: min/max while dragging, full percentiles when idle; throttled.
    const dragging = this.gizmo.dragging;
    if (this.boundsDirty && now - this.lastBoundsMs > (dragging ? 120 : 250)) {
      this.lastBoundsMs = now;
      const b = this.computeBounds(!dragging);
      if (b) {
        this.bounds = b;
        this.boundsDirty = dragging; // recompute percentiles once the drag ends
      } else this.boundsDirty = false;
      this.renderBounds();
    }
  }

  private renderBounds(): void {
    const b = this.bounds;
    if (!b) {
      this.boundsLine.textContent = "No splat centres available yet (paged model still streaming? press Resample).";
      return;
    }
    const size = b.max.clone().sub(b.min);
    const rsize = b.robustMax.clone().sub(b.robustMin);
    this.boundsLine.textContent = [
      `min    ${vec(b.min)}`,
      `max    ${vec(b.max)}`,
      `size   ${vec(size)}`,
      `robust ${vec(b.robustMin, 2)} .. ${vec(b.robustMax, 2)}  (size ${vec(rsize, 2)})`,
      `floor guess (2% Y) ${fmt(b.lowY)}   ${b.samples.toLocaleString("en-US")} samples`,
    ].join("\n");
  }

  // --- UI sync ----------------------------------------------------------------

  private syncInputs(skip?: string): void {
    const t = this.target;
    const e = new THREE.Euler().setFromQuaternion(t.quaternion, "XYZ");
    const set = (k: string, v: number, d: number) => {
      if (k !== skip) this.inputs[k].value = String(Number(v.toFixed(d)) || 0);
    };
    set("px", t.position.x, 4);
    set("py", t.position.y, 4);
    set("pz", t.position.z, 4);
    set("rx", THREE.MathUtils.radToDeg(e.x), 3);
    set("ry", THREE.MathUtils.radToDeg(e.y), 3);
    set("rz", THREE.MathUtils.radToDeg(e.z), 3);
    set("s", t.scale.x, 4);
  }

  private syncModeButtons(): void {
    for (const [mode, b] of Object.entries(this.modeButtons)) b.classList.toggle("plan-primary", mode === this.gizmoMode);
  }

  private setStatus(msg: string, bad = false): void {
    this.status.textContent = msg;
    this.status.classList.toggle("bad", bad);
  }

  private flashToggle(): void {
    const old = this.toggleButton.textContent;
    this.toggleButton.textContent = "Load a model first";
    window.setTimeout(() => (this.toggleButton.textContent = old), 2000);
  }
}
