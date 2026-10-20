/**
 * Core viewer: WebGLRenderer + SparkRenderer + SplatMesh(es) + camera rig.
 *
 * Extension points for later phases:
 *  - `onFrame` hooks run every frame before render (tour animations, hotspot
 *    picking in Phase 3; XR controller input in Phase 4).
 *  - `scene` is plain three.js, so hotspot meshes/sprites can be added freely.
 *  - The render loop uses renderer.setAnimationLoop, which is what WebXR
 *    requires, so SparkXr can take over presentation without restructuring.
 */
import * as THREE from "three";
import { SparkRenderer, SplatMesh, type SplatFileType } from "@sparkjsdev/spark";
import { decomposeTRS, isIdentityMatrix } from "../../shared/scene-schema.mjs";
import type { ModelSpec, ViewerConfig } from "./config";
import { isRadUrl } from "./config";
import { CameraRig } from "./controls";
import type { DeviceInfo } from "./device";
import { FrameStats, LoadTimeline, NetworkTracker } from "./metrics";
import { checkModelUrl, type PreflightResult } from "./preflight";

export type FrameHook = (ctx: { dtMs: number; now: number; viewer: Viewer }) => void;

export interface LoadedModel {
  spec: ModelSpec;
  /** Scene part id (scene editor), null for ?model= debug models. */
  id: string | null;
  mesh: SplatMesh;
  paged: boolean;
  preflight: PreflightResult;
  /** Set once the mesh's own initialisation finishes (immediate for paged). */
  ready: boolean;
  /**
   * Non-paged only: bytes reported by SplatMesh onProgress. Spark downloads
   * plain files inside a Web Worker, so main-thread Resource Timing misses them.
   */
  bytesLoaded: number;
  loadEndMs: number | null;
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /**
   * Parent of every SplatMesh. The scene editor puts the scene transform (or the
   * delta on a built .rad) on this one object, so all parts of a multi-part scene
   * move together; a part's own mesh matrix is ModelSpec.matrix (normally identity).
   * Spark collects SplatMeshes by traversing the scene, so nesting is fine, and it
   * sorts all of them together (no seams between parts).
   */
  readonly root = new THREE.Group();
  readonly camera: THREE.PerspectiveCamera;
  readonly spark: SparkRenderer;
  readonly rig: CameraRig;
  readonly frames = new FrameStats();
  readonly network = new NetworkTracker();
  readonly timeline: LoadTimeline;
  readonly models: LoadedModel[] = [];
  readonly errors: string[] = [];
  readonly onFrame: FrameHook[] = [];
  /** When set, the render loop draws with this camera instead of `camera` (plan mode, plan capture). */
  renderCamera: THREE.Camera | null = null;
  /** Effective pixel ratio after caps/overrides. */
  readonly pixelRatio: number;
  /** Bumped whenever the loaded meshes are replaced (cached samples/bounds become stale). */
  modelsVersion = 0;
  /** Called for each mesh right after it is created, before it renders (e.g. to apply a scene transform). */
  onMeshCreated: ((entry: LoadedModel) => void) | null = null;

  private lastFrameTime: number | null = null;
  private lastCameraMatrix = new THREE.Matrix4();
  private startPose?: { position: THREE.Vector3; target: THREE.Vector3 };

  constructor(
    container: HTMLElement,
    readonly config: ViewerConfig,
    readonly device: DeviceInfo,
  ) {
    // Spark docs: antialias must stay off; MSAA adds cost and no quality for splats.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    this.pixelRatio = config.pixelRatio ?? Math.min(window.devicePixelRatio || 1, device.profile.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(0x101114, 1);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      config.camera?.fov ?? 60,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.01,
      1000,
    );

    // Only set lodSplatCount when the user asked for a budget or forced a
    // device profile; otherwise Spark applies its own platform default.
    const lodSplatCount = config.budget ?? (device.forced ? device.profile.defaultBudget : undefined);
    this.spark = new SparkRenderer({
      renderer: this.renderer,
      ...(lodSplatCount !== undefined && { lodSplatCount }),
      ...(config.lodScale !== undefined && { lodSplatScale: config.lodScale }),
      ...(config.maxStdDev !== undefined && { maxStdDev: config.maxStdDev }),
      ...(config.lodRenderScale !== undefined && { lodRenderScale: config.lodRenderScale }),
      ...(config.extSplats !== undefined && { pagedExtSplats: config.extSplats }),
    });
    this.scene.add(this.spark);
    this.root.name = "splat-root";
    this.scene.add(this.root);

    this.rig = new CameraRig(this.camera, this.renderer.domElement, config.controls);
    const cam = config.camera;
    this.setStartPose(
      new THREE.Vector3(...(cam?.position ?? [0, 0, 3])),
      new THREE.Vector3(...(cam?.target ?? [0, 0, 0])),
    );

    this.timeline = new LoadTimeline(config.settleWindowMs);

    window.addEventListener("resize", () => this.resize(container));
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  /** Effective per-frame splat budget: (lodSplatCount ?? platform default) * lodSplatScale. */
  get budget(): number {
    return (this.spark.lodSplatCount ?? this.spark.defaultSplatTarget()) * this.spark.lodSplatScale;
  }

  get budgetSource(): "spark-default" | "url/config" | "forced-profile" {
    if (this.config.budget !== undefined) return "url/config";
    return this.device.forced ? "forced-profile" : "spark-default";
  }

  setStartPose(position: THREE.Vector3, target: THREE.Vector3): void {
    this.startPose = { position: position.clone(), target: target.clone() };
    this.rig.setPose(position, target);
    this.camera.updateMatrixWorld();
    this.lastCameraMatrix.copy(this.camera.matrixWorld);
  }

  resetView(): void {
    if (this.rig.resetWalk()) return; // first-person: back to the nav spawn point
    if (this.startPose) this.rig.setPose(this.startPose.position, this.startPose.target);
  }

  /**
   * Swap the loaded models for `specs` (e.g. the freshly built .rad after a
   * scene build). The camera stays where it is unless `frame` is set.
   */
  async replaceModels(specs: ModelSpec[], frame = false): Promise<void> {
    for (const m of this.models.splice(0)) {
      this.root.remove(m.mesh);
      m.mesh.dispose();
    }
    this.errors.length = 0;
    this.config.models = specs;
    this.modelsVersion++;
    await this.loadModels(frame);
  }

  /**
   * Make the loaded models match `specs` without reloading the ones that stay
   * (same id, URL and matrix): e.g. one part enabled or previewed in a
   * multi-part scene. Returns the errors of the models that were added.
   */
  async syncModels(specs: ModelSpec[]): Promise<string[]> {
    const key = (s: ModelSpec) => `${s.id ?? ""}|${s.url}|${s.paged ?? ""}|${(s.matrix ?? []).join(",")}`;
    const want = new Map(specs.map((s) => [key(s), s]));
    for (const m of [...this.models]) {
      if (want.has(key(m.spec))) {
        want.delete(key(m.spec));
        continue;
      }
      this.models.splice(this.models.indexOf(m), 1);
      this.root.remove(m.mesh);
      m.mesh.dispose();
    }
    this.config.models = specs;
    this.modelsVersion++;
    const results = await Promise.allSettled([...want.values()].map((spec) => this.loadModel(spec)));
    const errors = (results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]).map((f) =>
      f.reason instanceof Error ? f.reason.message : String(f.reason),
    );
    this.errors.splice(0, this.errors.length, ...errors);
    // Keep the scene order (part order) for anything that lists models.
    const order = new Map(specs.map((s, i) => [key(s), i]));
    this.models.sort((a, b) => (order.get(key(a.spec)) ?? 0) - (order.get(key(b.spec)) ?? 0));
    this.modelsVersion++;
    return errors;
  }

  /** Show / hide one part (hidden parts are skipped by Spark's sort and LoD budget). */
  setModelVisible(id: string, visible: boolean): void {
    for (const m of this.models) if (m.id === id) m.mesh.visible = visible;
  }

  async loadModels(frame = !this.config.camera): Promise<void> {
    if (this.config.models.length === 0) return;
    this.timeline.modelRequestMs = performance.now();
    this.network.start(this.config.models.map((m) => m.url));
    const results = await Promise.allSettled(this.config.models.map((spec) => this.loadModel(spec)));
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    for (const f of failed) this.errors.push(f.reason instanceof Error ? f.reason.message : String(f.reason));
    if (failed.length === results.length) this.timeline.status = "error";
    // Auto-frame plain (non-paged) models when no start viewpoint was given.
    if (frame) this.frameLoadedModels();
    this.modelsVersion++;
  }

  private async loadModel(spec: ModelSpec): Promise<void> {
    const rad = isRadUrl(spec.url);
    const paged = spec.paged ?? rad;
    if (paged && !rad && spec.fileType !== "rad") {
      throw new Error(`"${spec.url}": paged streaming needs a .rad file (built with build-lod). Load it with paged=0.`);
    }
    // Check reachability + Range support before handing the URL to Spark: a
    // paged mesh with a bad URL otherwise retries forever with console noise.
    const preflight = await checkModelUrl(spec.url);
    if (!preflight.ok) throw new Error(`"${spec.url}": ${preflight.error}`);

    const entry: LoadedModel = { spec, id: spec.id ?? null, mesh: undefined as unknown as SplatMesh, paged, preflight, ready: false, bytesLoaded: 0, loadEndMs: null };
    const mesh = new SplatMesh({
      url: spec.url,
      ...(!paged && {
        onProgress: (e: ProgressEvent) => {
          entry.bytesLoaded = e.loaded;
        },
      }),
      ...(paged && { paged: true }),
      ...(!paged && spec.lod !== undefined && spec.lod !== false && { lod: spec.lod }),
      ...(!paged && this.config.extSplats && { extSplats: true }),
      ...(spec.fileType && { fileType: spec.fileType as SplatFileType }),
      ...(spec.lodScale !== undefined && { lodScale: spec.lodScale }),
    });
    entry.mesh = mesh;
    // The part's place inside the root (identity unless it was built with another transform).
    if (spec.matrix && !isIdentityMatrix(spec.matrix, 1e-12)) {
      const t = decomposeTRS(spec.matrix, 1e-5);
      mesh.position.set(...t.position);
      mesh.quaternion.set(...t.quaternion);
      mesh.scale.setScalar(t.scale);
    }
    this.onMeshCreated?.(entry);
    this.models.push(entry);
    this.root.add(mesh);
    mesh.updateMatrixWorld(true);
    try {
      await mesh.initialized;
      entry.ready = true;
      if (!paged) entry.loadEndMs = performance.now();
    } catch (err) {
      this.root.remove(mesh);
      this.models.splice(this.models.indexOf(entry), 1);
      mesh.dispose();
      throw new Error(`"${spec.url}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private frameLoadedModels(): void {
    const box = new THREE.Box3();
    this.scene.updateMatrixWorld(true);
    for (const m of this.models) {
      if (m.paged || !m.ready) continue; // paged meshes have no CPU-side splats to measure
      m.mesh.updateMatrixWorld(true);
      const b = m.mesh.getBoundingBox(true).applyMatrix4(m.mesh.matrixWorld);
      if (!b.isEmpty()) box.union(b);
    }
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 0.8;
    this.camera.far = Math.max(1000, radius * 20);
    this.camera.updateProjectionMatrix();
    this.setStartPose(center.clone().add(new THREE.Vector3(0, radius * 0.15, dist)), center);
  }

  /**
   * True when Spark reports no outstanding LoD work:
   *  - every mesh finished initialising,
   *  - SparkRenderer.lodInitQueue is empty and lodDirty is false
   *    (no pending LoD-tree init or re-traversal),
   *  - SplatPager.isPending() is false (no chunk fetches in flight and no
   *    fetched chunks waiting to be uploaded).
   * Spark exposes no explicit "settled" event, so the timeline requires this
   * to hold continuously for settleWindowMs.
   */
  isLodIdle(): boolean {
    if (this.models.length === 0 || this.models.some((m) => !m.ready)) return false;
    if (this.spark.lodDirty || this.spark.lodInitQueue.length > 0) return false;
    if (this.spark.pager?.isPending()) return false;
    // A paged mesh registers with the pager lazily; until then it isn't idle.
    if (this.models.some((m) => m.paged) && !this.spark.pager) return false;
    return true;
  }

  private frame(t: number): void {
    const now = performance.now();
    const dtMs = this.lastFrameTime === null ? 0 : t - this.lastFrameTime;
    this.lastFrameTime = t;
    if (dtMs > 0) this.frames.record(dtMs);

    this.rig.update();
    this.camera.updateMatrixWorld();
    if (this.cameraMoved()) this.timeline.markInteraction(now);
    for (const hook of this.onFrame) hook({ dtMs, now, viewer: this });

    this.renderer.render(this.scene, this.renderCamera ?? this.camera);
    this.timeline.update(now, this.spark.activeSplats, this.isLodIdle());
  }

  /** Camera moved noticeably since last check (ignores float jitter from controls). */
  private cameraMoved(): boolean {
    const a = this.camera.matrixWorld.elements;
    const b = this.lastCameraMatrix.elements;
    let moved = false;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(a[i] - b[i]) > 1e-4) {
        moved = true;
        break;
      }
    }
    if (moved) this.lastCameraMatrix.copy(this.camera.matrixWorld);
    return moved;
  }

  private resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = Math.max(1, container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
