/**
 * Navigation panel (scene editor): collision GLB from the scene's nav/ folder,
 * spawn and start camera from the current view, fallback floor height,
 * allowFly / allowJump. Every control writes into the scene store; the editor
 * rebuilds the walk controller from the store.
 */
import * as THREE from "three";
import type { SceneDoc } from "../../../shared/scene-schema.mjs";
import { el, kbd } from "../ui/dom";
import type { Viewer } from "../viewer";
import type { NavFile } from "./api";
import { roundCoord, yawPitchFromForward, type Vec3 } from "./sceneMath";
import type { SceneStore } from "./store";

export interface NavPanelHost {
  /** Collision load state of the current walk controller. */
  collisionStatus(): string;
  /** Collider wireframe on/off. */
  collidersVisible(on?: boolean): boolean;
  /** Re-list nav/ (after exports or files added by hand). */
  refreshNavFiles(): Promise<void>;
  /** Mark that nav assets were authored with the current transform (if not recorded yet). */
  touchNav(draft: SceneDoc): void;
  /** Eye height of the walk controller (for "floor from camera"). */
  eyeHeight(): number;
  goToStartCamera(): void;
}

const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "—");
const fmtVec = (v: readonly number[]) => v.map(fmt).join(", ");

export class NavPanel {
  readonly panel: HTMLDivElement;
  private files: NavFile[] = [];
  private readonly collision: HTMLSelectElement;
  private readonly collisionNote: HTMLDivElement;
  private readonly spawnLine: HTMLDivElement;
  private readonly cameraLine: HTMLDivElement;
  private readonly floorInput: HTMLInputElement;
  private readonly allowFly: HTMLInputElement;
  private readonly allowJump: HTMLInputElement;
  private readonly colliders: HTMLInputElement;
  private readonly fileList: HTMLDivElement;
  readonly warning: HTMLDivElement;

  constructor(
    private readonly store: SceneStore,
    private readonly viewer: Viewer,
    private readonly host: NavPanelHost,
  ) {
    const row = (...c: (Node | string)[]) => el("div", { className: "plan-row" }, c);
    const sub = (t: string) => el("div", { className: "plan-sub" }, [t]);
    const btn = (label: string | (Node | string)[], onclick: () => void, title = "") => {
      const b = el("button", { onclick, title });
      if (typeof label === "string") b.textContent = label;
      else b.append(...label);
      return b;
    };

    this.collision = el("select", { title: "Collision GLB in this scene's nav/ folder" });
    this.collision.addEventListener("change", () => {
      const v = this.collision.value;
      store.update((d) => {
        if (v) d.navigation.collision = v;
        else delete d.navigation.collision;
        if (v) host.touchNav(d);
      }, "navigation");
    });
    this.collisionNote = el("div", { className: "panel-note" });
    this.spawnLine = el("div", { className: "panel-note" });
    this.cameraLine = el("div", { className: "panel-note" });
    this.floorInput = el("input", { type: "number", step: "0.01", placeholder: "0 (default)", title: "Fallback floor height (scene coordinates) when no collision GLB is set or it fails to load" });
    this.floorInput.addEventListener("change", () => {
      const raw = this.floorInput.value.trim();
      const v = Number(raw);
      if (raw !== "" && !Number.isFinite(v)) return this.sync();
      store.update((d) => {
        d.floorY = raw === "" ? null : roundCoord(v);
        if (raw !== "") host.touchNav(d);
      }, "floor");
    });
    const check = (title: string, key: "allowFly" | "allowJump") => {
      const c = el("input", { type: "checkbox", title });
      c.addEventListener("change", () =>
        store.update((d) => {
          if (c.checked) d.navigation[key] = true;
          else delete d.navigation[key];
        }, "navigation"),
      );
      return c;
    };
    this.allowFly = check("Let the player toggle flying with F", "allowFly");
    this.allowJump = check("Space jumps", "allowJump");
    this.colliders = el("input", { type: "checkbox", title: "Show the collision mesh as a wireframe (Shift+N)" });
    this.colliders.addEventListener("change", () => host.collidersVisible(this.colliders.checked));
    this.fileList = el("div", { className: "panel-note" });
    this.warning = el("div", { className: "panel-note bad", hidden: true });

    this.panel = el("div", { className: "plan-panel nav-panel", hidden: true }, [
      el("div", { className: "plan-head" }, [el("strong", { textContent: "Navigation" }), btn("Close", () => this.show(false), "Close (N)")]),
      this.warning,
      sub("Collision mesh (scenes/<name>/nav/*.glb)"),
      row(this.collision, btn("↻", () => void host.refreshNavFiles(), "Re-list the nav/ folder")),
      this.collisionNote,
      row(el("label", {}, [this.colliders, " Show colliders"]), kbd("Shift+N")),
      sub("Spawn (where Walk starts and respawns)"),
      this.spawnLine,
      row(btn("Set spawn here", () => this.setSpawn(), "Current camera position and heading; in walk mode the player drops to the floor below"), btn("Clear", () => this.clearSpawn())),
      sub("Start camera (what the scene opens with)"),
      this.cameraLine,
      row(btn("Set start camera", () => this.setCamera(), "Current view becomes the scene's start view"), btn("Go to", () => host.goToStartCamera()), btn("Clear", () => this.clearCamera())),
      sub("Fallback floor Y (m, when there is no collision mesh)"),
      row(this.floorInput, btn("From camera", () => this.floorFromCamera(), "Camera height minus eye height")),
      sub("Movement"),
      row(el("label", {}, [this.allowJump, " Allow jump (Space)"]), el("label", {}, [this.allowFly, " Allow fly (F)"])),
      row(btn(["Walk", kbd("C")], () => this.walk(), "First-person walk from the current view (C cycles orbit / fly / walk)")),
      sub("Files in nav/"),
      this.fileList,
    ]);
    this.panel.querySelector(".plan-head strong")?.addEventListener("click", () => this.panel.classList.toggle("collapsed"));
    store.on(() => this.sync());
    this.sync();
  }

  get visible(): boolean {
    return !this.panel.hidden;
  }

  show(on = true): void {
    this.panel.hidden = !on;
    if (on) {
      this.panel.classList.remove("collapsed");
      void this.host.refreshNavFiles();
      this.sync();
    }
  }

  setFiles(files: NavFile[]): void {
    this.files = files;
    this.sync();
  }

  /** Refresh the dynamic bits (collision status) without rebuilding the controls. */
  tick(): void {
    if (this.panel.hidden) return;
    const cur = this.store.doc.navigation.collision as string | undefined;
    const st = this.host.collisionStatus();
    this.collisionNote.textContent = cur
      ? `${cur}: ${st === "loaded" ? "loaded" : st === "loading" ? "loading…" : st === "failed" ? "FAILED to load (flat floor fallback)" : st}`
      : "None: walking uses a flat floor at the fallback height.";
    this.collisionNote.classList.toggle("bad", st === "failed");
    this.colliders.checked = this.host.collidersVisible();
  }

  sync(): void {
    const d = this.store.doc;
    const nav = d.navigation as { collision?: string; spawn?: { position: Vec3; yaw?: number; pitch?: number }; allowFly?: boolean; allowJump?: boolean };
    // Collision choices: every .glb in nav/ (plan-*.glb are textured plan planes, listed last).
    const glbs = this.files.filter((f) => f.file.toLowerCase().endsWith(".glb")).map((f) => f.file);
    glbs.sort((a, b) => Number(/\/plan-/.test(a)) - Number(/\/plan-/.test(b)) || a.localeCompare(b));
    if (nav.collision && !glbs.includes(nav.collision)) glbs.unshift(nav.collision);
    const opts = [el("option", { value: "", textContent: "(none: flat floor)" })];
    for (const f of glbs) {
      const missing = !this.files.some((x) => x.file === f);
      const plan = /\/plan-[^/]*$/.test(f);
      opts.push(el("option", { value: f, textContent: `${f}${missing ? "  (missing!)" : plan ? "  (plan image plane)" : ""}` }));
    }
    this.collision.replaceChildren(...opts);
    this.collision.value = nav.collision ?? "";

    const s = nav.spawn;
    this.spawnLine.textContent = s
      ? `(${fmtVec(s.position)})  yaw ${fmt(s.yaw ?? 0)}°  pitch ${fmt(s.pitch ?? 0)}°`
      : "Not set: walking starts from the start camera, else the collision bounds.";
    const c = d.camera;
    this.cameraLine.textContent = c ? `from (${fmtVec(c.position)}) to (${fmtVec(c.target)})` : "Not set: opens with an overview.";
    if (document.activeElement !== this.floorInput) this.floorInput.value = d.floorY === null || d.floorY === undefined ? "" : String(d.floorY);
    this.allowFly.checked = !!nav.allowFly;
    this.allowJump.checked = !!nav.allowJump;
    this.fileList.textContent = this.files.length
      ? this.files.map((f) => `${f.file}  (${(f.bytes / 1024).toFixed(0)} KB)`).join("\n")
      : "Empty. Plan exports (M) are saved here; put the collision GLB drawn in Rhino/Blender here too.";
    this.fileList.style.whiteSpace = "pre-wrap";
    this.tick();
  }

  // --- actions ----------------------------------------------------------------

  private cameraPose(): { position: Vec3; forward: Vec3 } {
    const cam = this.viewer.camera;
    cam.updateMatrixWorld();
    const p = cam.getWorldPosition(new THREE.Vector3());
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    return { position: [roundCoord(p.x), roundCoord(p.y), roundCoord(p.z)], forward: [f.x, f.y, f.z] };
  }

  private setSpawn(): void {
    const { position, forward } = this.cameraPose();
    const { yaw, pitch } = yawPitchFromForward(forward);
    this.store.update((d) => {
      d.navigation.spawn = { position, yaw, pitch: Math.max(-30, Math.min(30, pitch)) };
      this.host.touchNav(d);
    }, "navigation");
  }

  private clearSpawn(): void {
    this.store.update((d) => delete d.navigation.spawn, "navigation");
  }

  private setCamera(): void {
    const { position } = this.cameraPose();
    const t = this.viewer.rig.getTarget();
    this.store.update((d) => {
      d.camera = { position, target: [roundCoord(t.x), roundCoord(t.y), roundCoord(t.z)], fov: Math.round(this.viewer.camera.fov * 100) / 100 };
    }, "camera");
  }

  private clearCamera(): void {
    this.store.update((d) => (d.camera = null), "camera");
  }

  private floorFromCamera(): void {
    const y = roundCoord(this.viewer.camera.position.y - this.host.eyeHeight());
    this.store.update((d) => {
      d.floorY = y;
      this.host.touchNav(d);
    }, "floor");
  }

  private walk(): void {
    this.viewer.rig.setMode("walk");
  }
}
