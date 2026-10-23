/**
 * Scene editor (?scene=<name>): top bar, banners, side dock and the glue
 * between the scene store and the viewer's modes.
 *
 *   store (scene.json in memory) ──> load plan per part (sceneConfig.ts / loadPlan)
 *                                ──> Viewer.root matrix (sceneMath.ts) = the transform of ALL parts
 *                                ──> walk controller (navigation, floorY, spawn)
 *                                ──> banners / top bar
 *   Align, Parts, Navigation panel, Plan export  ──write──> store
 *   Save (Ctrl+S) -> POST /__scenes/save; Build -> POST /__build (+ SSE panel)
 *
 * Every part is its own SplatMesh under Viewer.root (paged .rad when built,
 * the source loaded whole when not, under a size cap). The scene transform is
 * put on the root only, so Align moves every part together.
 */
import * as THREE from "three";
import {
  buildSummary,
  matricesEqual,
  navMayBeMisaligned,
  transformChangedSinceBuild,
  transformFromMatrix,
  validateScene,
  type PartLoad,
  type SceneDoc,
  type SceneTransform,
} from "../../../shared/scene-schema.mjs";
import { AlignMode, type AlignBinding } from "../align/alignMode";
import { resolveNavigationConfig } from "../nav/navConfig";
import { attachNavigation, type Navigation } from "../nav";
import { PlanMode } from "../plan/planMode";
import { confirmDialog, dialog, el, fmtBytes, fmtCount, fmtTime, guardTyping, isTypingTarget, kbd, toast } from "../ui/dom";
import type { Viewer } from "../viewer";
import { api, fetchSceneJson, type NavFile } from "./api";
import { BuildPanel } from "./buildPanel";
import { NavPanel } from "./navPanel";
import { PartsPanel } from "./partsPanel";
import { previewCapBytes, sceneCamera, sceneModels, sceneNavigation, type PartFileInfo, type SceneModels } from "./sceneConfig";
import { meshTRSFor, sceneTransformFromTRS } from "./sceneMath";
import { SceneStore } from "./store";
import { viewSliders } from "./viewSliders";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class SceneEditor {
  readonly store: SceneStore;
  readonly align: AlignMode;
  readonly plan: PlanMode;
  private nav: Navigation;
  private readonly navPanel: NavPanel;
  private readonly partsPanel: PartsPanel;
  private readonly build: BuildPanel;
  /** What each part loads (built .rad / source / nothing) and the root + part matrices. */
  private load: SceneModels;
  private info: PartFileInfo[] | null;
  private readonly capBytes = previewCapBytes(window.location.search);
  /** Parts hidden in the view (view state only, not saved). */
  private readonly hidden = new Set<string>();
  /** Unbuilt parts the user chose to preview although the scene is over the cap. */
  private readonly previewParts = new Set<string>();
  /** The transform block that matches the current build (for "Revert to built"). */
  private builtTransform: SceneTransform | null;
  private navFiles: NavFile[] = [];
  private fromAlign = false;
  private navTimer = 0;
  private partsTimer = 0;
  private saving: Promise<boolean> | null = null;
  private syncing: Promise<void> = Promise.resolve();

  // DOM
  private readonly dock: HTMLDivElement;
  private readonly banners: HTMLDivElement;
  private readonly dirtyDot: HTMLSpanElement;
  private readonly modeTag: HTMLSpanElement;
  private readonly buildPill: HTMLSpanElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly buildButton: HTMLButtonElement;
  private readonly tb: Record<string, HTMLButtonElement> = {};

  constructor(
    private readonly viewer: Viewer,
    private readonly ui: HTMLElement,
    doc: SceneDoc,
    load: SceneModels,
    info: PartFileInfo[] | null,
  ) {
    this.store = new SceneStore(doc);
    this.load = load;
    this.info = info;
    this.builtTransform = doc.build
      ? transformChangedSinceBuild(doc)
        ? transformFromMatrix(doc.build.transformMatrix)
        : clone(doc.transform)
      : null;
    document.body.classList.add("has-topbar");
    document.title = `${doc.name} · Splat Tour Editor`;
    guardTyping(ui);

    // The scene transform lives on the root, from the first frame; hidden parts stay hidden when reloaded.
    this.applyPreview();
    viewer.onMeshCreated = (m) => {
      if (m.id && this.hidden.has(m.id)) m.object.visible = false;
    };

    // --- top bar
    this.dirtyDot = el("span", { className: "dirty-dot", title: "Unsaved changes (Ctrl+S saves)", hidden: true });
    this.modeTag = el("span", { className: "mode-tag hide-narrow" });
    this.buildPill = el("span", { className: "build-pill", onclick: () => this.build.show(!this.build.visible) });
    const tbBtn = (key: string, label: string, shortcut: string, title: string, onclick: () => void) => {
      const b = el("button", { title, onclick }, [label, kbd(shortcut)]);
      this.tb[key] = b;
      return b;
    };
    this.saveButton = el("button", { title: "Save scene.json (Ctrl+S)", onclick: () => void this.save() }, ["Save", kbd("Ctrl+S")]);
    this.buildButton = el("button", { className: "primary", title: "Build the streamed .rad of every changed part, one part at a time (B shows the build panel)", onclick: () => void this.startBuild() }, ["Build"]);
    const topbar = el("div", { className: "topbar" }, [
      el("a", { className: "home", href: "./", textContent: "← Scenes", title: "Back to the scene list" }),
      el("span", { className: "scene-name", textContent: doc.name, title: `scenes/${doc.name}/` }),
      this.dirtyDot,
      this.modeTag,
      el("span", { className: "sep" }),
      tbBtn("align", "Align", "G", "Rotate / scale / place the model (all parts together)", () => this.align.toggle()),
      tbBtn("parts", "Parts", "L", "Source parts: build state, show / hide, enable, add, remove", () => this.partsPanel.show(!this.partsPanel.visible)),
      tbBtn("plan", "Plan", "M", "Plan section view and export for drawing colliders", () => this.plan.toggle()),
      tbBtn("nav", "Navigation", "N", "Collision mesh, spawn, start camera, floor", () => this.navPanel.show(!this.navPanel.visible)),
      tbBtn("controls", "Orbit", "C", "Camera: orbit / fly / walk (C cycles)", () => {
        if (this.align.active && viewer.rig.mode === "fly") this.align.setActive(false);
        viewer.rig.toggleMode();
      }),
      viewSliders(viewer),
      el("span", { className: "spacer" }),
      this.buildPill,
      this.saveButton,
      this.buildButton,
      el("span", { className: "sep hide-narrow" }),
      tbBtn("help", "?", "?", "Keyboard shortcuts", () => void this.showHelp()),
    ]);
    this.tb.help.replaceChildren("?");

    this.banners = el("div", { className: "banners" });
    this.dock = el("div", { className: "dock" });
    ui.append(topbar, this.banners, this.dock);

    // --- modes and panels
    this.plan = new PlanMode(ui, viewer, {
      dock: this.dock,
      target: {
        label: `scenes/${doc.name}/nav/`,
        save: async (file, blob) => (await api.uploadNavFile(this.store.name, file, blob)).file,
        onExported: (files) => {
          this.store.update((d) => this.touchNav(d), "navigation");
          void this.refreshNavFiles();
          toast(`Plan exported to scenes/${this.store.name}/nav/ (${files.length} files)`, "ok");
        },
        warning: () => {
          const d = this.store.doc;
          if (!d.build) return "Scene not built yet: exports use the current transform; build before drawing colliders so the streamed model matches.";
          if (transformChangedSinceBuild(d)) return "Transform changed since the last build: exports follow the NEW transform. Build first so the streamed model matches what you draw.";
          if (this.load.plan.parts.some((p) => p.mode === "blocked" || p.mode === "missing")) return "Some parts are not loaded (not built / over the preview cap): they are missing from the export.";
          return null;
        },
      },
    });
    this.align = new AlignMode(ui, viewer, this.alignBinding(), [this.plan], this.dock);
    this.navPanel = new NavPanel(this.store, viewer, {
      collisionStatus: () => this.nav.collisionStatus,
      collidersVisible: (on?: boolean) => {
        if (on !== undefined) this.nav.debugVisible = on;
        return this.nav.debugVisible;
      },
      refreshNavFiles: () => this.refreshNavFiles(),
      touchNav: (d) => this.touchNav(d),
      eyeHeight: () => this.nav.config.eyeHeight,
      goToStartCamera: () => this.goToStartCamera(),
    });
    this.partsPanel = new PartsPanel(this.store, {
      parts: () => this.load.plan.parts as PartLoad[],
      info: () => this.info,
      capBytes: () => this.capBytes,
      isVisible: (id) => !this.hidden.has(id),
      setVisible: (id, on) => {
        if (on) this.hidden.delete(id);
        else this.hidden.add(id);
        viewer.setModelVisible(id, on);
      },
      isPreviewed: (id) => this.previewParts.has(id),
      setPreviewed: (id, on) => {
        if (on) this.previewParts.add(id);
        else this.previewParts.delete(id);
        void this.syncParts();
      },
      refresh: () => this.refreshInfo(),
      buildParts: (ids) => void this.startBuild({ parts: ids }),
    });
    this.build = new BuildPanel(doc.name, {
      onFinished: (name, ok, error) => void this.onBuildFinished(name, ok, error),
      onState: () => {
        this.renderBar();
        this.renderBanners();
      },
    });
    this.dock.append(this.partsPanel.panel, this.navPanel.panel, this.build.panel);
    this.nav = attachNavigation(viewer, ui);

    // --- store -> everything
    this.store.on((d, change) => {
      if (change === "transform" || change === "build") {
        this.applyPreview();
        if (!this.fromAlign) this.align.refresh();
      }
      if (change === "parts") this.scheduleParts();
      if (change === "navigation" || change === "floor" || change === "camera") this.scheduleNavRebuild();
      this.renderBar();
      this.renderBanners();
      this.partsPanel.render();
      void d;
    });

    // --- keys: Ctrl+S anywhere (even in a field), the rest only when not typing
    window.addEventListener(
      "keydown",
      (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === "KeyS") {
          e.preventDefault();
          e.stopPropagation();
          (document.activeElement as HTMLElement | null)?.blur?.(); // commit a field being edited
          void this.save();
        }
      },
      { capture: true },
    );
    window.addEventListener("keydown", (e) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector(".modal-backdrop")) return;
      if (e.code === "KeyN" && !e.shiftKey) this.navPanel.show(!this.navPanel.visible);
      else if (e.code === "KeyL") this.partsPanel.show(!this.partsPanel.visible);
      else if (e.code === "KeyB") this.build.show(!this.build.visible);
      else if (e.key === "?" || (e.code === "Slash" && e.shiftKey)) void this.showHelp();
    });
    window.addEventListener("beforeunload", (e) => {
      if (!this.store.dirty) return;
      e.preventDefault();
      e.returnValue = "";
    });

    void this.refreshNavFiles();
    void this.build.connect();
    window.setInterval(() => this.tick(), 250);
    if (doc.parts.length > 1 || load.plan.overCap) this.partsPanel.show(true);
    this.renderBar();
    this.renderBanners();
  }

  // --- preview -------------------------------------------------------------------

  /** Transform baked into what is loaded (the build's), or null when only raw sources are shown. */
  private get refMatrix(): number[] | null {
    return this.load.plan.refMatrix;
  }

  private alignBinding(): AlignBinding {
    return {
      get: () => {
        const t = this.store.doc.transform;
        return { position: [...t.position], quaternion: [...t.quaternion], scale: t.scale };
      },
      set: (t) => {
        this.fromAlign = true;
        try {
          this.store.update((d) => (d.transform = sceneTransformFromTRS(t)), "transform");
        } finally {
          this.fromAlign = false;
        }
      },
      builtMatrix: () => this.refMatrix,
      revertToBuilt: () => this.revertToBuilt(),
      describe: () => {
        const n = this.store.doc.parts.length;
        const all = n > 1 ? ` All ${n} parts move together.` : "";
        if (this.load.mode === "built") return `Built .rad: changes preview as T_new · T_built⁻¹ and need a Build to bake in.${all}`;
        if (this.load.mode === "mixed") return `Some parts built, some previewing their source: every part shows this transform.${all} Save, then Build.`;
        return `Not built: previewing the source with this transform.${all} Save, then Build.`;
      },
    };
  }

  /** Put the scene transform (delta on a built .rad) on Viewer.root: every part follows. */
  private applyPreview(): void {
    const trs = meshTRSFor(this.store.doc.transform.matrix, this.refMatrix);
    const root = this.viewer.root;
    root.position.set(...trs.position);
    root.quaternion.set(...trs.quaternion);
    root.scale.setScalar(trs.scale);
    root.updateMatrixWorld(true);
  }

  private revertToBuilt(): void {
    const d = this.store.doc;
    if (!d.build) return;
    const block = this.builtTransform && matricesEqual(this.builtTransform.matrix, d.build.transformMatrix) ? this.builtTransform : transformFromMatrix(d.build.transformMatrix);
    this.store.update((x) => (x.transform = clone(block)), "transform");
  }

  // --- parts ----------------------------------------------------------------------

  private scheduleParts(): void {
    window.clearTimeout(this.partsTimer);
    // New parts need their file sizes before the cap check.
    this.partsTimer = window.setTimeout(() => {
      const known = new Set((this.info ?? []).map((p) => p.id));
      if (this.store.doc.parts.some((p) => !known.has(p.id))) void this.refreshInfo();
      else void this.syncParts();
    }, 150);
  }

  private async refreshInfo(): Promise<void> {
    try {
      // The server reads scene.json from disk: unsaved new parts are not in its answer, so merge.
      const server = await api.info(this.store.name);
      const byId = new Map(server.map((p) => [p.id, p]));
      const sizes = new Map<string, number>();
      const missing = this.store.doc.parts.filter((p) => !byId.has(p.id) || byId.get(p.id)?.source !== p.source);
      if (missing.length) {
        const files = (await api.sources()).files;
        for (const f of files) sizes.set(f.path, f.bytes);
      }
      this.info = this.store.doc.parts.map((p) => {
        const s = byId.get(p.id);
        if (s && s.source === p.source) return s;
        const bytes = sizes.get(p.source);
        return { id: p.id, source: p.source, exists: bytes !== undefined, bytes: bytes ?? null, splats: null, builtOnDisk: false };
      });
    } catch (err) {
      toast(`Could not read part info: ${(err as Error).message}`, "error");
    }
    await this.syncParts();
  }

  /** Recompute what every part loads and make the viewer match (only changed parts reload). */
  private syncParts(): Promise<void> {
    this.syncing = this.syncing.then(async () => {
      const next = sceneModels(this.store.doc as SceneDoc, this.info, { capBytes: this.capBytes, previewParts: [...this.previewParts] });
      const refChanged = !sameMatrix(next.plan.refMatrix, this.load.plan.refMatrix);
      this.load = next;
      if (refChanged) {
        this.align.refresh();
      }
      this.applyPreview();
      const errors = await this.viewer.syncModels(next.models);
      for (const id of this.hidden) this.viewer.setModelVisible(id, false);
      if (errors.length) toast(`Some parts failed to load: ${errors.join("; ")}`, "error");
      this.renderBar();
      this.renderBanners();
      this.partsPanel.render();
    });
    return this.syncing;
  }

  // --- navigation ----------------------------------------------------------------

  /** First nav asset authored: remember which transform it belongs to. */
  touchNav(d: SceneDoc): void {
    if (!d.navTransformMatrix) d.navTransformMatrix = [...d.transform.matrix];
  }

  private scheduleNavRebuild(): void {
    window.clearTimeout(this.navTimer);
    this.navTimer = window.setTimeout(() => this.rebuildNav(), 250);
  }

  private rebuildNav(): void {
    const d = this.store.doc;
    const cfg = this.viewer.config;
    cfg.navigation = resolveNavigationConfig(sceneNavigation(d), new URLSearchParams(window.location.search));
    cfg.camera = sceneCamera(d) ?? cfg.camera;
    const walking = this.viewer.rig.mode === "walk";
    const pose = walking ? this.nav.getPose() : null;
    this.nav = attachNavigation(this.viewer, this.ui, this.nav);
    if (walking && pose) void this.nav.ready.then(() => this.nav.teleport(pose));
  }

  private async refreshNavFiles(): Promise<void> {
    try {
      this.navFiles = await api.navFiles(this.store.name);
      this.navPanel.setFiles(this.navFiles);
      this.renderBanners();
    } catch (err) {
      toast(`Could not list nav files: ${(err as Error).message}`, "error");
    }
  }

  private goToStartCamera(): void {
    const c = this.store.doc.camera;
    if (!c) return void toast("No start camera set yet.", "warn");
    if (this.viewer.rig.mode === "walk") this.viewer.rig.setMode("orbit");
    this.viewer.setStartPose(new THREE.Vector3(...c.position), new THREE.Vector3(...c.target));
  }

  // --- save / build ----------------------------------------------------------------

  /** Save scene.json. Resolves true when saved (or nothing to save). */
  save(): Promise<boolean> {
    this.saving ??= this.doSave().finally(() => (this.saving = null));
    return this.saving;
  }

  private async doSave(): Promise<boolean> {
    if (!this.store.dirty) {
      toast("No unsaved changes.", "info", 1500);
      return true;
    }
    this.saveButton.disabled = true;
    try {
      const sent = clone(this.store.doc) as SceneDoc;
      const { scene, file } = await api.save(sent);
      this.store.markSaved(scene);
      toast(`Saved ${file}`, "ok");
      return true;
    } catch (err) {
      toast(`Save failed: ${(err as Error).message}`, "error");
      return false;
    } finally {
      this.saveButton.disabled = false;
      this.renderBar();
    }
  }

  private async startBuild(o: { parts?: string[]; force?: boolean } = {}): Promise<void> {
    if (this.build.phase === "running") {
      this.build.show();
      toast(this.build.runningName === this.store.name ? "This scene is already building." : `A build of "${this.build.runningName}" is running: one build at a time.`, "warn");
      return;
    }
    if (this.store.dirty) {
      const choice = await dialog<"save" | "cancel">({
        title: "Unsaved changes",
        body: [el("p", { textContent: "Build reads scenes/" + this.store.name + "/scene.json from disk, so unsaved changes would not be in the build." })],
        buttons: [
          { label: "Cancel", value: "cancel" },
          { label: "Save and build", value: "save", primary: true },
        ],
        cancelValue: "cancel",
      });
      if (choice !== "save" || !(await this.save())) return;
    }
    const d = this.store.doc;
    const sum = buildSummary(d as SceneDoc);
    if (!o.parts && !o.force && d.build && sum.complete && !transformChangedSinceBuild(d)) {
      const again = await dialog<"incremental" | "force" | "cancel">({
        title: "Everything is built",
        body: [el("p", { textContent: "Every part is built with this transform. A normal build only rebuilds parts whose source file changed (it checks size and date) and finishes at once otherwise. Rebuild every part anyway (takes a while)?" })],
        buttons: [
          { label: "Cancel", value: "cancel" },
          { label: "Check sources", value: "incremental" },
          { label: "Rebuild all", value: "force", primary: true },
        ],
        cancelValue: "cancel",
      });
      if (again === "cancel") return;
      if (again === "force") o = { ...o, force: true };
    }
    try {
      await this.build.start(o);
      toast(`Build of ${this.store.name}${o.parts ? ` (part ${o.parts.join(", ")})` : ""} started`, "info");
    } catch (err) {
      toast(`Build did not start: ${(err as Error).message}`, "error");
    }
    this.renderBar();
  }

  private async onBuildFinished(name: string, ok: boolean, error: string | null): Promise<void> {
    if (name !== this.store.name) {
      if (ok) toast(`Build of ${name} finished`, "info");
      this.renderBar();
      return;
    }
    // Re-read the file: the pipeline wrote build/buildAttempt into it.
    let server: SceneDoc | null = null;
    try {
      const { scene, errors } = validateScene(await fetchSceneJson(name));
      if (!scene) throw new Error(errors.join("; "));
      server = scene;
    } catch (err) {
      toast(`Could not re-read scene.json after the build: ${(err as Error).message}`, "error");
    }
    const prevFinished = this.store.doc.build?.finishedAt ?? null;
    if (server) this.store.adoptServerBuild(server);
    const d = this.store.doc;
    const newBuild = !!d.build && d.build.finishedAt !== prevFinished;
    if (!ok || (server && d.buildAttempt?.status === "failed" && !newBuild)) {
      toast(`Build failed: ${error ?? d.buildAttempt?.error ?? "see the build log"}`, "error");
      this.renderBanners();
      return;
    }
    if (!newBuild || !d.build) {
      if ((d.buildAttempt as { upToDate?: boolean } | null)?.upToDate) toast("Every part was up to date: nothing rebuilt.", "info");
      this.renderBar();
      return;
    }
    this.builtTransform = server ? clone(server.transform) : null;
    const built = d.buildAttempt?.parts?.filter((p) => p.status === "built").length ?? 0;
    toast(`Build finished in ${Math.round(d.build.wallClockSeconds ?? 0)} s (${built} part${built === 1 ? "" : "s"} rebuilt): loading the new .rad files`, "ok");
    await this.reloadModel();
  }

  /** After a build: load each part's current build (or its source) in place of what is shown. */
  private async reloadModel(): Promise<void> {
    const wasAligning = this.align.active;
    if (wasAligning) this.align.setActive(false);
    if (this.plan.active) this.plan.setActive(false);
    this.previewParts.clear();
    await this.refreshInfo();
    this.align.refresh();
    if (wasAligning) this.align.setActive(true);
  }

  // --- view ---------------------------------------------------------------------------

  private tick(): void {
    this.tb.align.classList.toggle("on", this.align.active);
    this.tb.plan.classList.toggle("on", this.plan.active);
    this.tb.nav.classList.toggle("on", this.navPanel.visible);
    this.tb.parts.classList.toggle("on", this.partsPanel.visible);
    const mode = this.viewer.rig.mode;
    const label = mode === "orbit" ? "Orbit" : mode === "fly" ? "Fly" : "Walk";
    const first = this.tb.controls.firstChild;
    if (first && first.textContent !== label) first.textContent = label;
    this.tb.controls.classList.toggle("on", mode === "walk");
    this.navPanel.tick();
  }

  private renderBar(): void {
    const d = this.store.doc;
    this.dirtyDot.hidden = !this.store.dirty;
    this.saveButton.classList.toggle("primary", this.store.dirty);
    const n = d.parts.length;
    const partsText = n > 1 ? ` · ${n} parts` : "";
    const modeText = { built: "streamed .rad", source: "source preview", mixed: "built + source preview", none: "nothing loaded" }[this.load.mode];
    this.modeTag.textContent = `${modeText}${partsText}`;
    this.modeTag.title = this.load.plan.parts.map((p) => `${p.id}: ${p.mode}`).join("\n");
    const b = this.build;
    const pill = this.buildPill;
    pill.className = "build-pill";
    const sum = buildSummary(d as SceneDoc);
    if (b.phase === "running") {
      pill.classList.add("running");
      pill.textContent = b.runningName === d.name ? (b.external ? "Building (command line)…" : `Building ${Math.round(b.pct)}%`) : `Busy: building ${b.runningName}`;
      pill.title = "Show the build panel (B)";
    } else if (d.buildAttempt?.status === "failed" && (!d.build || d.buildAttempt.finishedAt > d.build.finishedAt)) {
      pill.classList.add("failed");
      pill.textContent = "Last build failed";
      pill.title = d.buildAttempt.error ?? "";
    } else if (!d.build) {
      pill.classList.add("stale");
      pill.textContent = "Not built";
      pill.title = "Build to create the streamed .rad files";
    } else if (transformChangedSinceBuild(d)) {
      pill.classList.add("stale");
      pill.textContent = "Build outdated";
      pill.title = "The transform changed since the last build";
    } else if (!sum.complete) {
      pill.classList.add("stale");
      pill.textContent = `Built ${sum.built}/${sum.enabled} parts`;
      pill.title = `${sum.notBuilt} part(s) not built, ${sum.outdated} outdated: Build to finish`;
    } else {
      pill.classList.add("ok");
      pill.textContent = `Built ${fmtTime(d.build.finishedAt)}`;
      pill.title = `${fmtCount(d.build.splatCount?.final)} splats, ${d.build.chunkCount ?? "?"} chunks${n > 1 ? `, ${n} parts` : ""}`;
    }
    this.buildButton.disabled = b.phase === "running";
  }

  private renderBanners(): void {
    const d = this.store.doc;
    const out: HTMLElement[] = [];
    const banner = (cls: string, msg: string, ...actions: HTMLElement[]) => out.push(el("div", { className: `banner ${cls}` }, [el("span", { className: "msg", textContent: msg }), ...actions]));
    const button = (label: string, onclick: () => void, primary = false) => el("button", { textContent: label, onclick, className: primary ? "primary" : "" });
    const building = this.build.phase === "running" && this.build.runningName === d.name;
    const parts = this.load.plan.parts;
    const blocked = parts.filter((p) => p.mode === "blocked");
    const sum = buildSummary(d as SceneDoc);

    if (d.build && transformChangedSinceBuild(d)) {
      banner("", "Transform changed since last build: Build to apply.", button("Build", () => void this.startBuild(), true), button("Revert", () => this.revertToBuilt()));
    } else if (!building && blocked.length) {
      const bytes = blocked.reduce((s, p) => s + (p.sourceBytes ?? 0), 0);
      banner(
        "info",
        `${blocked.length === parts.filter((p) => p.mode !== "disabled").length ? "Not built" : `${blocked.length} part(s) not built`}: the unbuilt sources (${fmtBytes(this.load.plan.unbuiltBytes)}) are over the ${fmtBytes(this.capBytes)} preview cap, so ${fmtBytes(bytes)} is not loaded into the browser. Build to preview, or preview single parts in Parts (L).`,
        button("Build", () => void this.startBuild(), true),
        button("Parts", () => this.partsPanel.show(true)),
      );
    } else if (!d.build && !building) {
      banner("info", "Not built yet: previewing the source (loaded whole, no LoD streaming). Align it, save, then Build.", button("Build", () => void this.startBuild(), true));
    } else if (d.build && !sum.complete && !building) {
      banner("info", `${sum.built} of ${sum.enabled} parts built${sum.outdated ? `, ${sum.outdated} outdated` : ""}${sum.notBuilt ? `, ${sum.notBuilt} not built` : ""}: Build finishes the rest (built parts are reused).`, button("Build", () => void this.startBuild(), true));
    }
    const missing = parts.filter((p) => p.mode === "missing");
    if (missing.length) banner("bad", `Source missing for ${missing.map((p) => p.id).join(", ")}: ${missing.map((p) => p.source).join(", ")}`);
    if (navMayBeMisaligned(d, this.navFiles.length)) {
      banner(
        "bad",
        "Navigation assets (floor Y, spawn, start camera, plan exports, collision GLB) were made for a different transform: colliders may no longer line up with the splats.",
        button("Revert transform", () => this.revertNavTransform()),
        button("They line up", () => void this.acceptNavTransform()),
      );
    }
    const a = d.buildAttempt;
    if (this.build.phase !== "running" && a?.status === "failed" && (!d.build || a.finishedAt > d.build.finishedAt)) {
      banner("bad", `Last build failed: ${a.error ?? "unknown error"}`, button("Show log", () => this.build.show()));
    }
    this.banners.replaceChildren(...out);
  }

  /** Back to the transform the nav assets were made with. */
  private revertNavTransform(): void {
    const d = this.store.doc;
    const ref = d.navTransformMatrix ?? d.build?.transformMatrix;
    if (!ref) return;
    if (d.build && matricesEqual(ref, d.build.transformMatrix)) return this.revertToBuilt();
    this.store.update((x) => (x.transform = transformFromMatrix(ref)), "transform");
  }

  private async acceptNavTransform(): Promise<void> {
    const ok = await confirmDialog(
      "Mark navigation as aligned?",
      "Only do this after checking (or redrawing) the collision mesh, spawn and floor in the new coordinates. The warning goes away until the transform changes again.",
      "They line up",
    );
    if (ok) this.store.update((x) => (x.navTransformMatrix = [...x.transform.matrix]), "navigation");
  }

  private showHelp(): Promise<void> {
    const rows: [string, string][] = [
      ["Ctrl+S", "Save scene.json"],
      ["G", "Align: gizmo, ±90°, scale, origin (all parts)"],
      ["1 / 2 / 3", "Align: move / rotate / scale gizmo"],
      ["O", "Align: set origin at the camera"],
      ["L", "Parts: show / hide, enable, add, remove"],
      ["M", "Plan view and export (to nav/)"],
      ["N", "Navigation panel"],
      ["B", "Build panel"],
      ["C", "Camera: orbit → fly → walk"],
      ["V", "Reset view (walk: back to spawn)"],
      ["Shift+N", "Show / hide colliders"],
      ["F", "Walk: toggle fly (if allowed)"],
      ["P", "Performance overlay"],
      ["R", "Reset fps measurement and hitch log"],
      ["K", "Orbit benchmark (10 s)"],
      ["Esc", "Leave a text field / release the mouse"],
    ];
    return dialog({
      title: "Keyboard shortcuts",
      body: [el("div", { className: "help-grid" }, rows.flatMap(([k, t]) => [el("span", {}, [kbd(k)]), el("span", { textContent: t })]))],
      buttons: [{ label: "Close", value: undefined, primary: true }],
      cancelValue: undefined,
    });
  }
}

function sameMatrix(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b) return a === b;
  return matricesEqual(a, b);
}
