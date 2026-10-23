/**
 * Core viewer: WebGLRenderer + SparkRenderer + SplatMesh(es) + camera rig.
 * With ?renderer=gsl the splats go through Gaussian Splat Lite on a
 * WebGPURenderer instead (src/gsl.ts); `spark` / `sparkStats` are then null.
 *
 * Extension points for later phases:
 *  - `onFrame` hooks run every frame before render (tour animations, hotspot
 *    picking in Phase 3; XR controller input in Phase 4).
 *  - `scene` is plain three.js, so hotspot meshes/sprites can be added freely.
 *  - The render loop uses renderer.setAnimationLoop, which is what WebXR
 *    requires, so SparkXr can take over presentation without restructuring.
 */
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { SparkRenderer, SplatMesh, type SplatFileType } from "@sparkjsdev/spark";
import type { RadStreamScheduler } from "gaussian-splat-lite";
import { decomposeTRS, isIdentityMatrix } from "../../shared/scene-schema.mjs";
import type { ModelSpec, ViewerConfig } from "./config";
import { isRadUrl } from "./config";
import { CameraRig } from "./controls";
import { gpuInfo, type DeviceInfo } from "./device";
import type { BenchResult } from "./bench";
import { GpuTimer, HitchLog, SparkStats } from "./diagnostics";
import type { GslSplats, WebGpuFrameTimer } from "./gsl";
import { FrameStats, LoadTimeline, NetworkTracker } from "./metrics";
import { checkModelUrl, type PreflightResult } from "./preflight";
import { PAGE_SPLATS, PREF_CAMERA_SPEED, PREF_DETAIL, poolPagesFor, readPref } from "./viewPrefs";

/** SparkRenderer.lodSplatScale on desktop when ?lodScale= is not given (phones: 1). */
export const DESKTOP_LOD_SCALE = 2;
/**
 * Camera movement multiplier when ?speed= is not given: 0.2x the speeds the
 * controls were tuned with (scans come in at room-sized units of ~3, where
 * those speeds crossed the room in a second).
 */
export const DEFAULT_CAMERA_SPEED = 0.2;

export type FrameHook = (ctx: { dtMs: number; now: number; viewer: Viewer }) => void;

export interface LoadedModel {
  spec: ModelSpec;
  /** Scene part id (scene editor), null for ?model= debug models. */
  id: string | null;
  /** What sits under Viewer.root for this model (show / hide / place it through this). */
  object: THREE.Object3D;
  /** The Spark mesh; null on the GSL path. */
  mesh: SplatMesh | null;
  /** The GSL stream of a paged model on the GSL path, else null. */
  stream: RadStreamScheduler | null;
  /** Removes the model from the scene and frees it. */
  dispose: () => void;
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

/** What Viewer.create hands the constructor on the GSL path. */
interface GslSetup {
  module: typeof import("./gsl");
  renderer: WebGPURenderer;
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer | WebGPURenderer;
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
  /** Null on the GSL path. */
  readonly spark: SparkRenderer | null;
  /** Gaussian Splat Lite renderer and streams; null on the Spark path. */
  readonly gsl: GslSplats | null;
  readonly rig: CameraRig;
  readonly frames = new FrameStats();
  readonly network = new NetworkTracker();
  readonly timeline: LoadTimeline;
  /** Null on the GSL path. */
  readonly sparkStats: SparkStats | null;
  readonly gpu: GpuTimer | WebGpuFrameTimer;
  readonly hitches = new HitchLog();
  /** Last orbit benchmark (bench.ts), echoed into results. */
  lastBenchmark: BenchResult | null = null;
  readonly models: LoadedModel[] = [];
  readonly errors: string[] = [];
  readonly onFrame: FrameHook[] = [];
  /** When set, the render loop draws with this camera instead of `camera` (plan mode, plan capture). */
  renderCamera: THREE.Camera | null = null;
  /** Effective pixel ratio after caps/overrides. */
  readonly pixelRatio: number;
  /** 32-byte ExtSplats (float32 centres) instead of 16-byte PackedSplats: ?extSplats=, else on unless mobile. */
  readonly extSplats: boolean;

  /** Base budget the GSL path multiplies by Detail (Spark keeps its own in lodSplatCount). */
  private readonly gslBaseBudget: number;
  private gslDetail = 1;

  /** Pages (65,536 splats each) in Spark's streaming pool, fixed for this page load; 0 on the GSL path. */
  get poolPages(): number {
    return this.spark ? Math.round(this.spark.maxPagedSplats / PAGE_SPLATS) : 0;
  }
  /** Bumped whenever the loaded meshes are replaced (cached samples/bounds become stale). */
  modelsVersion = 0;
  /** Called for each mesh right after it is created, before it renders (e.g. to apply a scene transform). */
  onMeshCreated: ((entry: LoadedModel) => void) | null = null;

  private lastFrameTime: number | null = null;
  private lastCameraMatrix = new THREE.Matrix4();
  private startPose?: { position: THREE.Vector3; target: THREE.Vector3 };

  /** Builds the viewer; the GSL path first starts a WebGPURenderer (async: WebGPU adapter + device). */
  static async create(container: HTMLElement, config: ViewerConfig, device: DeviceInfo): Promise<Viewer> {
    if (config.renderer === "spark") return new Viewer(container, config, device, null);
    // Loaded on demand so the Spark path doesn't ship three/webgpu.
    const module = await import("./gsl");
    const renderer = await module.createGslRenderer(config.renderer === "gsl-webgl");
    return new Viewer(container, config, device, { module, renderer });
  }

  private constructor(
    container: HTMLElement,
    readonly config: ViewerConfig,
    readonly device: DeviceInfo,
    gslSetup: GslSetup | null,
  ) {
    // Spark docs: antialias must stay off; MSAA adds cost and no quality for splats.
    this.renderer = gslSetup?.renderer ?? new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
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
    // Spark's compact 16-byte splats store centres as float16 (1/1024 relative
    // steps): for scans whose splats are smaller than that step (Spirula
    // exports: ~0.0002-unit splats at coordinates around 1-2), centres snap to
    // a grid and surfaces show diagonal striping. The 32-byte ExtSplats keep
    // float32 centres and finer scales/rotations at twice the GPU memory, so
    // they are the default on desktop; phones keep the compact format.
    this.extSplats = config.extSplats ?? !device.mobile;
    // Close-ups of dense multi-part scans run out of budget long before splats
    // reach 1 px, so desktop starts at 2x Spark's platform budget (5M splats).
    const lodSplatScale = config.lodScale ?? readPref(PREF_DETAIL) ?? (device.mobile ? 1 : DESKTOP_LOD_SCALE);
    // The page pool is allocated once (when the first streamed part loads): size it for the detail setting.
    // GSL: the same base budget as Spark (device profile = Spark's platform default) times Detail.
    this.gslBaseBudget = config.budget ?? device.profile.defaultBudget;
    if (gslSetup) {
      this.spark = null;
      this.sparkStats = null;
      this.gslDetail = lodSplatScale;
      this.gsl = new gslSetup.module.GslSplats(gslSetup.renderer, this.scene, Math.round(this.gslBaseBudget * lodSplatScale), {
        ...config.gsl,
        ...(config.maxStdDev !== undefined && { maxStdDev: config.maxStdDev }),
      });
      this.gpu = new gslSetup.module.WebGpuFrameTimer(gslSetup.renderer);
    } else {
      const renderer = this.renderer as THREE.WebGLRenderer;
      const pages = config.pages ?? (device.mobile ? undefined : poolPagesFor(lodSplatScale));
      this.spark = new SparkRenderer({
        renderer,
        ...(lodSplatCount !== undefined && { lodSplatCount }),
        lodSplatScale,
        ...(pages !== undefined && { maxPagedSplats: pages * PAGE_SPLATS }),
        ...(config.maxStdDev !== undefined && { maxStdDev: config.maxStdDev }),
        ...(config.lodRenderScale !== undefined && { lodRenderScale: config.lodRenderScale }),
        pagedExtSplats: this.extSplats,
      });
      this.scene.add(this.spark);
      this.sparkStats = new SparkStats(this.spark);
      this.gsl = null;
      this.gpu = new GpuTimer(renderer.getContext() as WebGL2RenderingContext);
    }
    this.root.name = "splat-root";
    this.scene.add(this.root);

    this.rig = new CameraRig(this.camera, this.renderer.domElement, config.controls);
    this.rig.setSpeedScale(config.speed ?? readPref(PREF_CAMERA_SPEED) ?? DEFAULT_CAMERA_SPEED);
    const cam = config.camera;
    this.setStartPose(
      new THREE.Vector3(...(cam?.position ?? [0, 0, 3])),
      new THREE.Vector3(...(cam?.target ?? [0, 0, 0])),
    );

    this.timeline = new LoadTimeline(config.settleWindowMs);

    window.addEventListener("resize", () => this.resize(container));
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  /** Which splat renderer this page uses ("spark", "gsl" or "gsl-webgl"). */
  get rendererKind(): ViewerConfig["renderer"] {
    return this.config.renderer;
  }

  /** The Spark renderer, for Spark-only features (Plan, Align, capture); throws on the GSL path. */
  requireSpark(): SparkRenderer {
    if (!this.spark) throw new Error("This feature needs the Spark renderer (open the page without ?renderer=gsl).");
    return this.spark;
  }

  /** The WebGLRenderer of the Spark path, for WebGL-only code (plan capture); throws on the GSL path. */
  get webgl(): THREE.WebGLRenderer {
    if (this.gsl) throw new Error("This feature needs the WebGL renderer (open the page without ?renderer=gsl).");
    return this.renderer as THREE.WebGLRenderer;
  }

  /** GPU description for results. */
  gpuInfo(): string {
    return this.gsl ? this.gsl.gpuInfo() : gpuInfo((this.renderer as THREE.WebGLRenderer).getContext());
  }

  /** Base budget before the Detail multiplier: Spark's lodSplatCount (or platform default), or the GSL base. */
  get baseBudget(): number {
    return this.spark ? (this.spark.lodSplatCount ?? this.spark.defaultSplatTarget()) : this.gslBaseBudget;
  }

  /** Detail (budget multiplier): Spark's lodSplatScale, or the GSL total budget's multiplier. */
  get detail(): number {
    return this.spark ? this.spark.lodSplatScale : this.gslDetail;
  }

  set detail(v: number) {
    if (this.spark) this.spark.lodSplatScale = v;
    else if (this.gsl) {
      this.gslDetail = v;
      this.gsl.budget = Math.max(1, Math.round(this.gslBaseBudget * v));
    }
  }

  /** Effective per-frame splat budget: base budget * detail. */
  get budget(): number {
    return this.baseBudget * this.detail;
  }

  /** Splats drawn in the last frame (Spark's LoD selection, or GSL's visible splats). */
  get activeSplats(): number {
    return this.spark ? this.spark.activeSplats : (this.gsl?.visibleSplats ?? 0);
  }

  /** Splats one model currently draws (0 when hidden). */
  modelSplats(m: LoadedModel): number {
    if (!m.object.visible) return 0;
    if (m.mesh && this.sparkStats) return this.sparkStats.meshSplats(m.mesh);
    if (m.stream) return m.stream.stats.visibleSplats;
    return (m.object as { numSplats?: number }).numSplats ?? 0;
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
    for (const m of this.models.splice(0)) m.dispose();
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
      m.dispose();
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

  /** Show / hide one part (hidden parts are skipped by the sort and the LoD budget). */
  setModelVisible(id: string, visible: boolean): void {
    for (const m of this.models) if (m.id === id) m.object.visible = visible;
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

    const entry: LoadedModel = {
      spec,
      id: spec.id ?? null,
      object: undefined as unknown as THREE.Object3D,
      mesh: null,
      stream: null,
      dispose: () => {},
      paged,
      preflight,
      ready: false,
      bytesLoaded: 0,
      loadEndMs: null,
    };
    let initialized: Promise<unknown>;
    if (this.gsl) {
      const gsl = this.gsl;
      if (paged) {
        const stream = gsl.addStream(spec.url, this.camera, (msg) => {
          if (!this.errors.includes(msg)) this.errors.push(msg);
        });
        entry.stream = stream;
        entry.object = stream.group;
        entry.dispose = () => gsl.removeStream(stream);
        initialized = stream.initialized;
      } else {
        // Plain files load whole (no in-browser LoD on this path).
        const mesh = gsl.addMesh(spec.url);
        entry.object = mesh;
        entry.dispose = () => {
          mesh.removeFromParent();
          mesh.dispose();
        };
        initialized = mesh.initialized;
      }
    } else {
      const mesh = new SplatMesh({
        url: spec.url,
        ...(!paged && {
          onProgress: (e: ProgressEvent) => {
            entry.bytesLoaded = e.loaded;
          },
        }),
        ...(paged && { paged: true }),
        ...(!paged && spec.lod !== undefined && spec.lod !== false && { lod: spec.lod }),
        ...(!paged && this.extSplats && { extSplats: true }),
        ...(spec.fileType && { fileType: spec.fileType as SplatFileType }),
        ...(spec.lodScale !== undefined && { lodScale: spec.lodScale }),
      });
      entry.mesh = mesh;
      entry.object = mesh;
      entry.dispose = () => {
        this.root.remove(mesh);
        mesh.dispose();
      };
      initialized = mesh.initialized;
    }
    const object = entry.object;
    // The part's place inside the root (identity unless it was built with another transform).
    if (spec.matrix && !isIdentityMatrix(spec.matrix, 1e-12)) {
      const t = decomposeTRS(spec.matrix, 1e-5);
      object.position.set(...t.position);
      object.quaternion.set(...t.quaternion);
      object.scale.setScalar(t.scale);
    }
    this.onMeshCreated?.(entry);
    this.models.push(entry);
    this.root.add(object);
    object.updateMatrixWorld(true);
    try {
      await initialized;
      entry.ready = true;
      if (!paged) entry.loadEndMs = performance.now();
    } catch (err) {
      this.models.splice(this.models.indexOf(entry), 1);
      entry.dispose();
      throw new Error(`"${spec.url}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private frameLoadedModels(): void {
    const box = new THREE.Box3();
    this.scene.updateMatrixWorld(true);
    for (const m of this.models) {
      // Paged meshes have no CPU-side splats to measure.
      const mesh = m.object as THREE.Object3D & { getBoundingBox?: (centersOnly?: boolean) => THREE.Box3 };
      if (m.paged || !m.ready || !mesh.getBoundingBox) continue;
      mesh.updateMatrixWorld(true);
      const b = mesh.getBoundingBox(true).applyMatrix4(mesh.matrixWorld);
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
   * to hold continuously for settleWindowMs. On the GSL path: no stream has
   * pages loading or waiting and every stream's view detail is ready.
   */
  isLodIdle(): boolean {
    if (this.models.length === 0 || this.models.some((m) => !m.ready)) return false;
    if (this.gsl) return this.gsl.isIdle();
    if (!this.spark) return false;
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
    this.sparkStats?.poll();
    this.gpu.poll();
    // Uploads etc. since the previous frame: what ran in the gap this dtMs measures.
    const work = this.sparkStats?.takeFrameWork() ?? { uploadMs: 0, pagesUploaded: 0 };

    this.rig.update();
    this.camera.updateMatrixWorld();
    const moved = this.cameraMoved();
    if (moved) this.timeline.markInteraction(now);
    const typicalMs = this.hitches.check(dtMs);
    if (typicalMs !== null) {
      this.hitches.add({
        atMs: now,
        frameMs: dtMs,
        typicalMs,
        activeSplats: this.activeSplats,
        cameraMoving: moved,
        sorting: this.sparkStats?.sorting ?? false,
        lodUpdating: this.sparkStats?.lodUpdating ?? false,
        fetching: this.gsl ? this.gsl.isFetching() : (this.spark?.pager?.isFetching() ?? false),
        uploadMs: work.uploadMs,
        pagesUploaded: work.pagesUploaded,
        gpuMs: this.gpu.samples.latest(),
      });
    }
    for (const hook of this.onFrame) hook({ dtMs, now, viewer: this });
    // After the hooks: they may move the camera (orbit bench), and GSL selects detail from its pose.
    this.gsl?.update(this.renderCamera ?? this.camera, now);

    this.gpu.begin();
    try {
      this.renderer.render(this.scene, this.renderCamera ?? this.camera);
    } finally {
      this.gpu.end(now);
    }
    this.timeline.update(now, this.activeSplats, this.isLodIdle());
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
    this.gsl?.resize(this.camera);
  }
}
