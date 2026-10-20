/**
 * Align mode: preview a rotation / uniform scale / origin for the loaded model(s)
 * and save it as assets/transforms/<stem>.json, to be baked into the splat file
 * with `node pipeline/transform.mjs` (see transformJson.ts for the exact format).
 *
 * Toggle with the "Align (G)" button or the G key. While active:
 *  - a three.js TransformControls gizmo drives a proxy Object3D; its TRS is
 *    copied onto every loaded SplatMesh (plain-file and paged alike);
 *  - 1 / 2 / 3 switch translate / rotate / scale; scale is forced uniform
 *    (non-uniform scale has no exact mapping onto Gaussian covariances and SH);
 *  - camera input is suspended while the gizmo is dragged;
 *  - a grid on Y = 0, axes at the origin and a live bounds readout are shown.
 *
 * Normal viewing renders models with an identity transform. Align only changes
 * the meshes' matrices while it is open, or after closing when "Keep preview"
 * is ticked (for this session only). The baked file becomes the new identity.
 */
import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { SplatMesh } from "@sparkjsdev/spark";
import { copyText, showTextDialog } from "../overlay";
import type { FrameHook, Viewer } from "../viewer";
import { bakeCommand, buildTransformJson, sourceFromModelUrl, stemFromSource } from "./transformJson";
import "../plan/plan.css";
import "./align.css";

type GizmoMode = "translate" | "rotate" | "scale";

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

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

const fmt = (v: number, d = 3): string => (Number.isFinite(v) ? v.toFixed(d) : "—");
const vec = (v: THREE.Vector3, d = 3) => `${fmt(v.x, d)}, ${fmt(v.y, d)}, ${fmt(v.z, d)}`;
const MAX_SAMPLES = 300_000;

function percentile(sorted: Float32Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

export class AlignMode {
  active = false;
  /** Holds the transform being authored; the gizmo is attached to it. */
  readonly target = new THREE.Object3D();
  private readonly gizmo: TransformControls;
  private readonly helpers = new THREE.Group();
  private gizmoMode: GizmoMode = "rotate";
  private snap = true;
  private keepPreview = false;
  /** Splat centres in file coordinates, sampled with a fixed stride (x, y, z, ...). */
  private samples: Float32Array | null = null;
  private boundsDirty = true;
  private lastBoundsMs = 0;
  private bounds: BoundsInfo | null = null;
  private source = "";
  private sourceEdited = false;
  private readonly frameHook: FrameHook = ({ now }) => this.onFrame(now);

  // DOM
  private readonly toggleButton: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly inputs: Record<string, HTMLInputElement> = {};
  private readonly modeButtons: Record<GizmoMode, HTMLButtonElement>;
  private readonly boundsLine: HTMLPreElement;
  private readonly commandBox: HTMLPreElement;
  private readonly status: HTMLDivElement;

  constructor(
    root: HTMLElement,
    private readonly viewer: Viewer,
    private readonly exclusive: ExclusiveMode[] = [],
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
      title: "Preview rotation / scale / origin and save a transform JSON for baking (G)",
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
    const btn = (textContent: string, onclick: () => void, title = "") => el("button", { textContent, onclick, title });
    const row = (...children: (Node | string)[]) => el("div", { className: "plan-row" }, children);
    const sub = (text: string) => el("div", { className: "plan-sub" }, [text]);
    const rot90 = (axis: "x" | "y" | "z") =>
      row(
        `${axis.toUpperCase()}`,
        btn("−90°", () => this.rotateWorld(axis, -90), `Rotate −90° about world ${axis.toUpperCase()} (about the model's pivot)`),
        btn("+90°", () => this.rotateWorld(axis, 90), `Rotate +90° about world ${axis.toUpperCase()} (about the model's pivot)`),
      );

    this.modeButtons = {
      translate: btn("Move (1)", () => this.setGizmoMode("translate")),
      rotate: btn("Rotate (2)", () => this.setGizmoMode("rotate")),
      scale: btn("Scale (3)", () => this.setGizmoMode("scale"), "Uniform scale only"),
    };
    this.boundsLine = el("pre", { className: "plan-status align-bounds" });
    this.commandBox = el("pre", { className: "plan-status align-command" });
    this.status = el("div", { className: "plan-status" });
    const sourceInput = el("input", { type: "text", spellcheck: false, className: "align-source", title: "Repo-relative path of the file to bake" });
    sourceInput.addEventListener("change", () => {
      this.source = sourceInput.value.trim();
      this.sourceEdited = true;
      this.updateCommand();
    });
    this.inputs.source = sourceInput;

    this.panel = el("div", { className: "plan-panel align-panel", hidden: true }, [
      el("div", { className: "plan-head" }, [
        el("strong", { textContent: "Align model" }),
        btn("Close", () => this.setActive(false), "Close Align mode (G)"),
      ]),
      row(this.modeButtons.translate, this.modeButtons.rotate, this.modeButtons.scale),
      row(el("label", {}, [check("snap", "Snap rotation to 15°", () => this.setSnap(this.inputs.snap.checked)), " 15° snap"])),
      sub("Position (m, relative to 0,0,0)"),
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
        btn("Set origin at camera (O)", () => this.originAtCamera(), "Fly to the spot (camera height = floor level), then press: that point becomes 0,0,0"),
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
      row(btn("Resample", () => this.resample(), "Re-read splat centres (paged models stream in over time)")),
      row(
        btn("Reset", () => this.reset(), "Back to the identity transform"),
        el("label", {}, [check("keep", "Keep this transform on the model after closing (this session only)", () => (this.keepPreview = this.inputs.keep.checked)), " Keep preview after closing"]),
      ),
      sub("Save"),
      row("Source", sourceInput),
      row(el("button", { className: "plan-primary", textContent: "Save transform JSON", onclick: () => void this.save() })),
      sub("Bake command (run from the repo root)"),
      this.commandBox,
      row(btn("Copy command", () => void this.copyCommand())),
      this.status,
    ]);
    root.append(this.toggleButton, this.panel);

    this.inputs.snap.checked = this.snap;
    this.syncModeButtons();
    this.syncInputs();

    window.addEventListener("keydown", (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "KeyG") this.toggle();
      else if (this.active && e.code === "Digit1") this.setGizmoMode("translate");
      else if (this.active && e.code === "Digit2") this.setGizmoMode("rotate");
      else if (this.active && e.code === "Digit3") this.setGizmoMode("scale");
      else if (this.active && e.code === "KeyO") this.originAtCamera();
    });
  }

  get meshes(): SplatMesh[] {
    return this.viewer.models.filter((m) => m.ready).map((m) => m.mesh);
  }

  toggle(): void {
    this.setActive(!this.active);
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    if (on && this.meshes.length === 0) {
      this.setStatus("Load a model first.", true);
      this.flashToggle();
      return;
    }
    this.active = on;
    this.panel.hidden = !on;
    this.toggleButton.classList.toggle("on", on);
    this.helpers.visible = on;
    const helper = this.gizmo.getHelper();
    if (on) {
      for (const m of this.exclusive) if (m.active) m.setActive(false);
      // First-person mode captures the mouse; the gizmo needs it.
      if (this.viewer.rig.mode === "walk") this.viewer.rig.setMode("orbit");
      this.gizmo.attach(this.target);
      helper.visible = true;
      if (!this.samples) this.resample();
      if (!this.sourceEdited) void this.detectSource();
      this.applyToMeshes();
      this.viewer.onFrame.push(this.frameHook);
    } else {
      this.gizmo.detach();
      helper.visible = false;
      this.viewer.rig.setSuspended(false);
      const i = this.viewer.onFrame.indexOf(this.frameHook);
      if (i >= 0) this.viewer.onFrame.splice(i, 1);
      if (!this.keepPreview) this.applyToMeshes(true);
    }
  }

  // --- transform ------------------------------------------------------------

  private applyToMeshes(identity = false): void {
    for (const mesh of this.meshes) {
      if (identity) {
        mesh.position.set(0, 0, 0);
        mesh.quaternion.identity();
        mesh.scale.set(1, 1, 1);
      } else {
        mesh.position.copy(this.target.position);
        mesh.quaternion.copy(this.target.quaternion);
        mesh.scale.copy(this.target.scale);
      }
      mesh.updateMatrixWorld(true);
    }
    this.boundsDirty = true;
  }

  private changed(skipInput?: string): void {
    this.target.updateMatrixWorld(true);
    this.applyToMeshes();
    this.syncInputs(skipInput);
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
    if (!b) return;
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
  }

  private floorToZero(): void {
    const y = Number(this.inputs.floor.value);
    if (!Number.isFinite(y)) return this.setStatus("Enter the current floor height (or press Guess) first.", true);
    this.target.position.y -= y;
    this.inputs.floor.value = "0";
    this.changed();
    this.setStatus(`Floor at Y = ${fmt(y)} moved to Y = 0`);
  }

  // --- bounds ---------------------------------------------------------------

  /** Sample splat centres in file coordinates (for paged meshes: what is loaded now). */
  private resample(): void {
    const xyz: number[] = [];
    for (const mesh of this.meshes) {
      try {
        const sources = [mesh, mesh.packedSplats?.lodSplats, mesh.extSplats?.lodSplats];
        for (const src of sources) {
          if (!src) continue;
          const count = src === mesh ? mesh.numSplats : src.numSplats;
          const stride = Math.max(1, Math.ceil((count || 1) / MAX_SAMPLES));
          const before = xyz.length;
          src.forEachSplat((i, c) => {
            if (i % stride === 0) xyz.push(c.x, c.y, c.z);
          });
          if (xyz.length > before) break;
        }
      } catch (err) {
        console.warn("align: sampling failed for a mesh", err);
      }
    }
    this.samples = xyz.length ? Float32Array.from(xyz) : null;
    this.boundsDirty = true;
  }

  private computeBounds(robust: boolean): BoundsInfo | null {
    const s = this.samples;
    if (!s) return null;
    this.target.updateMatrixWorld(true);
    const e = this.target.matrixWorld.elements;
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

  // --- save / command -------------------------------------------------------

  private async detectSource(): Promise<void> {
    const url = this.viewer.config.models[0]?.url ?? "";
    this.source = sourceFromModelUrl(url);
    // A .rad from build.mjs: bake the original input listed in its build report instead.
    if (/\.rad(?:$|[?#])/i.test(url)) {
      try {
        const reportUrl = url.split(/[?#]/)[0].replace(/[^/]*$/, "build-report.json");
        const res = await fetch(reportUrl, { cache: "no-store" });
        if (res.ok) {
          const rep = (await res.json()) as { input?: { relativePath?: string } };
          if (rep.input?.relativePath && !this.sourceEdited) this.source = rep.input.relativePath;
        }
      } catch {
        /* no report: keep the .rad path, the user can edit it */
      }
    }
    if (!this.sourceEdited) this.inputs.source.value = this.source;
    this.updateCommand();
  }

  private get stem(): string {
    return stemFromSource(this.source || "model");
  }

  private updateCommand(): void {
    const warn = /\.rad$/i.test(this.source) ? "\n(.rad cannot be baked: set Source to the original .ply/.sog)" : "";
    this.commandBox.textContent = bakeCommand(this.source || "<source.ply>", this.stem) + warn;
  }

  private transformJson() {
    return buildTransformJson(
      { position: this.target.position, quaternion: this.target.quaternion, scale: this.target.scale.x },
      this.source,
    );
  }

  private async save(): Promise<void> {
    const json = this.transformJson();
    const text = JSON.stringify(json, null, 2);
    const file = `${this.stem}.json`;
    (window as unknown as { lastAlignTransform?: unknown }).lastAlignTransform = json;
    try {
      const probe = await fetch("/__align-transform", { cache: "no-store" }).catch(() => null);
      if (probe?.ok && (probe.headers.get("content-type") ?? "").includes("json")) {
        const res = await fetch(`/__align-transform?${new URLSearchParams({ file })}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: text,
        });
        const out = (await res.json().catch(() => ({}))) as { ok?: boolean; file?: string; error?: string };
        if (!res.ok || !out.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
        this.setStatus(`Saved ${out.file}`);
      } else {
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const a = el("a", { href: url, download: file });
        document.body.append(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        this.setStatus(`No dev server: downloaded ${file}. Put it in assets/transforms/.`);
      }
    } catch (err) {
      this.setStatus(`Save failed: ${(err as Error).message}`, true);
    }
    this.updateCommand();
  }

  private async copyCommand(): Promise<void> {
    const cmd = bakeCommand(this.source || "<source.ply>", this.stem);
    if (await copyText(cmd)) this.setStatus("Command copied. Save the JSON first, then run it from the repo root.");
    else showTextDialog(document.getElementById("ui") ?? document.body, "Bake command", cmd);
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
