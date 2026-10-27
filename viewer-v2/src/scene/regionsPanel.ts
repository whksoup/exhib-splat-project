/**
 * Focus regions panel (scene editor, I): named, tiered boxes marking where the
 * model needs more (hero / high) or less (low) detail. They are saved in
 * scene.json as `focusRegions`, in scene coordinates (shared/focus-regions.mjs);
 * pipeline/focus-regions.mjs counts splats in them and exports them as a
 * Spirula training region.
 *
 * The boxes are plain three.js objects in Viewer.scene (scene coordinates are
 * world coordinates: the root carries the scene transform), drawn over the
 * splats. A TransformControls gizmo moves (1), rotates (2) and sizes (3) the
 * selected box; a click on a box selects it. Every change writes into the store.
 */
import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { FOCUS_TIER_INFO, FOCUS_TIERS, nextRegionId, type FocusRegion } from "../../../shared/focus-regions.mjs";
import { el, kbd } from "../ui/dom";
import type { Viewer } from "../viewer";
import type { SceneStore } from "./store";
import "../plan/plan.css";
import "./regions.css";

type Tier = FocusRegion["tier"];
type GizmoMode = "translate" | "rotate" | "scale";

/** Smallest box side (m): the gizmo can't collapse a box. */
const MIN_SIZE = 0.02;
/** Distance in front of the camera a new box is placed at (m). */
const NEW_BOX_DISTANCE = 2.5;
/** Rounded for scene.json (0.1 mm positions and sizes; quaternions get 7 digits). */
const round = (v: number, digits = 4) => Number(v.toFixed(digits));

const regionsOf = (store: SceneStore): FocusRegion[] => (store.doc.focusRegions ?? []) as FocusRegion[];

export class RegionsPanel {
  readonly panel: HTMLDivElement;
  /** Box meshes by region id (fill mesh; its child is the outline). */
  private readonly boxes = new Map<string, THREE.Mesh>();
  private readonly group = new THREE.Group();
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly edges = new THREE.EdgesGeometry(this.geometry);
  private readonly gizmo: TransformControls;
  private gizmoMode: GizmoMode = "translate";
  private selected: string | null = null;
  /** Show the boxes while the panel is closed too. */
  private showClosed = false;
  /** Set while the gizmo writes into the store, so the store echo doesn't rebuild the mesh being dragged. */
  private fromGizmo = false;
  private down: { x: number; y: number } | null = null;

  private readonly list: HTMLDivElement;
  private readonly summary: HTMLDivElement;
  private readonly editor: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly tierSelect: HTMLSelectElement;
  private readonly sizeInputs: HTMLInputElement[];
  private readonly modeButtons: Record<GizmoMode, HTMLButtonElement>;

  constructor(
    private readonly store: SceneStore,
    private readonly viewer: Viewer,
  ) {
    this.group.name = "focus-regions";
    this.group.visible = false;
    // Over the splats, after them.
    this.group.renderOrder = 1000;
    viewer.scene.add(this.group);

    this.gizmo = new TransformControls(viewer.camera, viewer.renderer.domElement);
    this.gizmo.setSpace("world");
    this.gizmo.setRotationSnap(THREE.MathUtils.degToRad(5));
    this.gizmo.addEventListener("dragging-changed", (e) => viewer.rig.setSuspended(Boolean(e.value)));
    this.gizmo.addEventListener("objectChange", () => this.onGizmoChange());
    this.gizmo.getHelper().visible = false;
    viewer.scene.add(this.gizmo.getHelper());

    // --- panel
    const row = (...c: (Node | string)[]) => el("div", { className: "plan-row" }, c);
    const sub = (t: string) => el("div", { className: "plan-sub" }, [t]);
    const btn = (label: string | (Node | string)[], onclick: () => void, title = "") => {
      const b = el("button", { onclick, title });
      if (typeof label === "string") b.textContent = label;
      else b.append(...label);
      return b;
    };
    this.modeButtons = {
      translate: btn(["Move", kbd("1")], () => this.setGizmoMode("translate"), "Move the selected box (world axes)"),
      rotate: btn(["Rotate", kbd("2")], () => this.setGizmoMode("rotate"), "Rotate the selected box (its own axes, 5° snap)"),
      scale: btn(["Size", kbd("3")], () => this.setGizmoMode("scale"), "Resize the selected box along its own axes"),
    };
    this.nameInput = el("input", { type: "text", placeholder: "Name (e.g. Shop shelves)", title: "What the region holds" });
    this.nameInput.style.width = "100%";
    this.nameInput.addEventListener("change", () => this.edit((r) => (r.name = this.nameInput.value.trim().slice(0, 120))));
    this.tierSelect = el(
      "select",
      { title: "Detail tier" },
      FOCUS_TIERS.map((t) => el("option", { value: t, textContent: `${FOCUS_TIER_INFO[t].label}: ${FOCUS_TIER_INFO[t].note}` })),
    );
    this.tierSelect.addEventListener("change", () => this.edit((r) => (r.tier = this.tierSelect.value as Tier)));
    this.sizeInputs = ["Width", "Height", "Depth"].map((label, i) => {
      const input = el("input", { type: "number", step: "0.05", min: String(MIN_SIZE), title: `${label} (m, along the box's own axis)` });
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (!(v > 0)) return this.render();
        this.edit((r) => (r.size[i] = round(Math.max(MIN_SIZE, v))));
      });
      return input;
    });
    this.editor = el("div", {}, [
      sub("Selected region"),
      row(this.nameInput),
      row(this.tierSelect),
      row("Size (m) ", ...this.sizeInputs),
      row(this.modeButtons.translate, this.modeButtons.rotate, this.modeButtons.scale),
      row(
        btn("Look at", () => this.lookAt(), "Point the camera at the box from where you stand"),
        btn("Duplicate", () => this.duplicate(), "Copy beside it"),
        btn("Delete", () => this.remove(), "Delete the selected region (Del)"),
      ),
    ]);
    this.list = el("div", { className: "region-list" });
    this.summary = el("div", { className: "panel-note" });
    const showClosed = el("input", { type: "checkbox", title: "Keep the boxes visible after closing this panel" });
    showClosed.addEventListener("change", () => {
      this.showClosed = showClosed.checked;
      this.syncVisibility();
    });
    this.panel = el("div", { className: "plan-panel regions-panel", hidden: true }, [
      el("div", { className: "plan-head" }, [el("strong", { textContent: "Focus regions" }), btn("Close", () => this.show(false), "Close (I)")]),
      el("div", { className: "panel-note", textContent: "Boxes marking where the model needs more (hero, high) or less (low) detail. Saved in scene.json with Ctrl+S." }),
      row(btn("+ Box in view", () => this.add(), "A 1 m box 2.5 m in front of the camera, facing it"), el("label", {}, [showClosed, " Show when closed"])),
      this.summary,
      this.list,
      this.editor,
      sub("Next"),
      el("div", { className: "panel-note", textContent: `Splat counts per region: node pipeline/focus-regions.mjs quantify ${store.name} --compare <scene>...` }),
    ]);
    this.panel.querySelector(".plan-head strong")?.addEventListener("click", () => this.panel.classList.toggle("collapsed"));

    // --- picking: a click (not a drag) on a box selects it
    const canvas = viewer.renderer.domElement;
    canvas.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener("pointerup", (e) => {
      const d = this.down;
      this.down = null;
      if (!this.visible || !d || this.gizmo.dragging || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      this.pick(e);
    });
    window.addEventListener("keydown", (e) => {
      if (!this.visible || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (e.code === "Digit1") this.setGizmoMode("translate");
      else if (e.code === "Digit2") this.setGizmoMode("rotate");
      else if (e.code === "Digit3") this.setGizmoMode("scale");
      else if (e.code === "Delete" && this.selected) this.remove();
      else if (e.code === "Escape") this.select(null);
    });

    store.on((_d, change) => {
      if (change === "regions" && this.fromGizmo) return this.render();
      this.rebuild();
    });
    this.rebuild();
  }

  // --- the exclusive-mode contract (Align turns this off when it starts)

  get active(): boolean {
    return this.visible;
  }

  setActive(on: boolean): void {
    this.show(on);
  }

  get visible(): boolean {
    return !this.panel.hidden;
  }

  show(on = true): void {
    this.panel.hidden = !on;
    if (on) this.panel.classList.remove("collapsed");
    if (!on) this.select(null);
    this.syncVisibility();
    this.render();
  }

  toggle(): void {
    this.show(!this.visible);
  }

  // --- edits

  private add(): void {
    const cam = this.viewer.camera;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const center = cam.position.clone().addScaledVector(dir, NEW_BOX_DISTANCE);
    // Face the camera: rotate about the vertical only.
    const yaw = Math.atan2(dir.x, dir.z);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const id = nextRegionId(regionsOf(this.store).map((r) => r.id));
    this.store.update((d) => {
      d.focusRegions = [
        ...((d.focusRegions ?? []) as FocusRegion[]),
        { id, name: `Region ${id.slice(1)}`, tier: "hero", center: center.toArray().map((v) => round(v)) as FocusRegion["center"], size: [1, 1, 1], quaternion: q.toArray().map((v) => round(v, 7)) as FocusRegion["quaternion"] },
      ];
    }, "regions");
    this.select(id);
    this.setGizmoMode("scale");
  }

  private duplicate(): void {
    const src = regionsOf(this.store).find((r) => r.id === this.selected);
    if (!src) return;
    const id = nextRegionId(regionsOf(this.store).map((r) => r.id));
    // Beside the original along its own x axis.
    const R = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...src.quaternion));
    const shift = new THREE.Vector3(src.size[0] * 1.1, 0, 0).applyMatrix4(R);
    this.store.update((d) => {
      d.focusRegions = [
        ...((d.focusRegions ?? []) as FocusRegion[]),
        { ...src, id, name: `${src.name} copy`.slice(0, 120), center: src.center.map((v, i) => round(v + shift.getComponent(i))) as FocusRegion["center"], size: [...src.size] as FocusRegion["size"], quaternion: [...src.quaternion] as FocusRegion["quaternion"] },
      ];
    }, "regions");
    this.select(id);
  }

  private remove(): void {
    const id = this.selected;
    if (!id) return;
    this.select(null);
    this.store.update((d) => {
      const left = ((d.focusRegions ?? []) as FocusRegion[]).filter((r) => r.id !== id);
      if (left.length) d.focusRegions = left;
      else delete d.focusRegions;
    }, "regions");
  }

  /** Change the selected region in the store. */
  private edit(fn: (r: FocusRegion) => void): void {
    const id = this.selected;
    if (!id) return;
    this.store.update((d) => {
      const r = ((d.focusRegions ?? []) as FocusRegion[]).find((x) => x.id === id);
      if (r) fn(r);
    }, "regions");
  }

  /** The gizmo moved the selected mesh: its position / rotation / scale become the region. */
  private onGizmoChange(): void {
    const mesh = this.selected ? this.boxes.get(this.selected) : null;
    if (!mesh) return;
    mesh.scale.set(Math.max(MIN_SIZE, Math.abs(mesh.scale.x)), Math.max(MIN_SIZE, Math.abs(mesh.scale.y)), Math.max(MIN_SIZE, Math.abs(mesh.scale.z)));
    this.fromGizmo = true;
    try {
      this.edit((r) => {
        r.center = mesh.position.toArray().map((v) => round(v)) as FocusRegion["center"];
        r.quaternion = mesh.quaternion.clone().normalize().toArray().map((v) => round(v, 7)) as FocusRegion["quaternion"];
        r.size = mesh.scale.toArray().map((v) => round(v)) as FocusRegion["size"];
      });
    } finally {
      this.fromGizmo = false;
    }
  }

  private setGizmoMode(mode: GizmoMode): void {
    this.gizmoMode = mode;
    this.gizmo.setMode(mode);
    // Move along the world axes; rotate and size along the box's own.
    this.gizmo.setSpace(mode === "translate" ? "world" : "local");
    for (const [m, b] of Object.entries(this.modeButtons)) b.classList.toggle("on", m === mode);
  }

  private select(id: string | null): void {
    this.selected = id && this.boxes.has(id) ? id : null;
    const mesh = this.selected ? this.boxes.get(this.selected) : undefined;
    if (mesh && this.visible) {
      // First-person mode captures the mouse; the gizmo needs it.
      if (this.viewer.rig.mode === "walk") this.viewer.rig.setMode("orbit");
      this.gizmo.attach(mesh);
      this.gizmo.getHelper().visible = true;
    } else {
      this.gizmo.detach();
      this.gizmo.getHelper().visible = false;
      this.viewer.rig.setSuspended(false);
    }
    this.styleBoxes();
    this.render();
  }

  private pick(e: PointerEvent): void {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.viewer.camera);
    const hits = ray.intersectObjects([...this.boxes.values()], false);
    if (hits.length) this.select(hits[0].object.userData.regionId as string);
  }

  private lookAt(): void {
    const r = regionsOf(this.store).find((x) => x.id === this.selected);
    if (!r) return;
    const target = new THREE.Vector3(...r.center);
    const cam = this.viewer.camera.position.clone();
    // Keep the current position unless the box is behind or very close: then back off along the view line.
    const dist = Math.max(Math.hypot(...r.size) * 1.2, 1);
    if (cam.distanceTo(target) < dist * 0.5) cam.copy(target).addScaledVector(this.viewer.camera.getWorldDirection(new THREE.Vector3()), -dist);
    if (this.viewer.rig.mode === "walk") this.viewer.rig.setMode("orbit");
    this.viewer.rig.setPose(cam, target);
  }

  // --- drawing

  /** Make the meshes match the store (add, update, remove). */
  private rebuild(): void {
    const regions = regionsOf(this.store);
    const ids = new Set(regions.map((r) => r.id));
    for (const [id, mesh] of this.boxes) {
      if (ids.has(id)) continue;
      mesh.removeFromParent();
      (mesh.material as THREE.Material).dispose();
      ((mesh.children[0] as THREE.LineSegments).material as THREE.Material).dispose();
      this.boxes.delete(id);
    }
    for (const r of regions) {
      let mesh = this.boxes.get(r.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
        const outline = new THREE.LineSegments(this.edges, new THREE.LineBasicMaterial({ transparent: true, depthTest: false }));
        mesh.add(outline);
        mesh.renderOrder = outline.renderOrder = 1000;
        mesh.userData.regionId = r.id;
        this.group.add(mesh);
        this.boxes.set(r.id, mesh);
      }
      mesh.position.set(...r.center);
      mesh.quaternion.set(...r.quaternion);
      mesh.scale.set(...r.size);
      mesh.userData.tier = r.tier;
    }
    if (this.selected && !ids.has(this.selected)) this.select(null);
    this.styleBoxes();
    this.render();
  }

  private styleBoxes(): void {
    for (const [id, mesh] of this.boxes) {
      const color = FOCUS_TIER_INFO[mesh.userData.tier as Tier].color;
      const on = id === this.selected;
      const fill = mesh.material as THREE.MeshBasicMaterial;
      fill.color.setHex(color);
      fill.opacity = on ? 0.16 : 0.06;
      const line = (mesh.children[0] as THREE.LineSegments).material as THREE.LineBasicMaterial;
      line.color.setHex(on ? 0xffffff : color);
      line.opacity = on ? 1 : 0.75;
    }
  }

  private syncVisibility(): void {
    this.group.visible = this.visible || this.showClosed;
  }

  /** The list, the summary and the selected region's fields. */
  render(): void {
    const regions = regionsOf(this.store);
    const byTier = FOCUS_TIERS.map((t) => {
      const rs = regions.filter((r) => r.tier === t);
      return `${FOCUS_TIER_INFO[t].label} ${rs.length} (${rs.reduce((s, r) => s + r.size[0] * r.size[1] * r.size[2], 0).toFixed(1)} m³)`;
    });
    this.summary.textContent = regions.length ? byTier.join(" · ") : "No regions yet: frame an artwork and add a box.";
    this.list.replaceChildren(
      ...regions.map((r) => {
        const chip = el("span", { className: "region-chip" });
        chip.style.background = `#${FOCUS_TIER_INFO[r.tier].color.toString(16).padStart(6, "0")}`;
        return el("div", { className: `region-row${r.id === this.selected ? " on" : ""}`, title: `${r.id}: ${FOCUS_TIER_INFO[r.tier].label}`, onclick: () => this.select(r.id) }, [
          chip,
          el("span", { className: "region-name", textContent: r.name || r.id }),
          el("span", { className: "region-size", textContent: r.size.map((v) => v.toFixed(2)).join(" × ") }),
        ]);
      }),
    );
    const sel = regions.find((r) => r.id === this.selected);
    this.editor.hidden = !sel;
    if (sel) {
      if (document.activeElement !== this.nameInput) this.nameInput.value = sel.name;
      this.tierSelect.value = sel.tier;
      sel.size.forEach((v, i) => {
        if (document.activeElement !== this.sizeInputs[i]) this.sizeInputs[i].value = v.toFixed(2);
      });
      for (const [m, b] of Object.entries(this.modeButtons)) b.classList.toggle("on", m === this.gizmoMode);
    }
  }
}
