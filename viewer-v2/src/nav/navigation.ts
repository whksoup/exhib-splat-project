/**
 * Navigation: glues the collision world, the player controller, input, the
 * debug view and a small HUD together, and plugs into CameraRig as the
 * first-person ("walk") camera mode.
 *
 * Programmatic API (framework-free, for Phase 3 hotspot moves and Phase 4 XR):
 *   nav.teleport(pose)              jump to a pose (lands on the floor in walk mode)
 *   nav.moveTo(pose, durationMs)    animate there, then land; Promise<boolean completed>
 *   nav.getMode() / nav.setMode()   "walk" | "fly" (fly refused unless allowFly)
 *   nav.getPose()                   current eye pose {position, yaw, pitch}
 *   nav.respawn()                   back to the spawn pose
 *   nav.ready                       resolves once the collision GLB is loaded (or fell back)
 *   nav.player                      the underlying PlayerController (pure logic)
 * The player only advances while first-person controls are active.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CollisionWorld } from "./colliders";
import { NavDebugView } from "./debug";
import { NavInputDevice } from "./input";
import type { NavigationConfig, NavMode, NavPose } from "./navConfig";
import { PlayerController } from "./player";
import { isTypingTarget } from "../ui/dom";

export type CollisionStatus = "none" | "loading" | "loaded" | "failed";

export interface NavigationOptions {
  config: NavigationConfig;
  scene: THREE.Scene;
  canvas: HTMLCanvasElement;
  uiRoot: HTMLElement;
  /** Viewer start camera, used to derive a spawn when navigation.spawn is unset. */
  cameraStart?: { position: [number, number, number]; target: [number, number, number] };
}

const CSS = `
.nav-hud{position:absolute;left:50%;bottom:calc(12px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);
  display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none!important;max-width:calc(100vw - 32px)}
.nav-hud > div{background:rgba(10,11,14,.72);border:1px solid #33363d;border-radius:6px;padding:4px 10px;font-size:12px;text-align:center}
.nav-hud .nav-warn{background:rgba(120,30,38,.9);border-color:#d0505c;font-size:13px}
.nav-cross{position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;
  background:rgba(255,255,255,.7);box-shadow:0 0 2px #000;pointer-events:none!important}
.nav-joy{position:absolute;width:120px;height:120px;margin:-60px 0 0 -60px;border-radius:50%;
  border:2px solid rgba(255,255,255,.35);background:rgba(255,255,255,.08);pointer-events:none!important}
.nav-joy-knob{position:absolute;left:50%;top:50%;width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.45)}
`;

function injectCss(): void {
  if (document.getElementById("nav-css")) return;
  const s = document.createElement("style");
  s.id = "nav-css";
  s.textContent = CSS;
  document.head.append(s);
}

/** Primary input is a finger (phones, tablets); touch-screen laptops still count as mouse. */
const isTouch = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

export class Navigation {
  readonly player: PlayerController;
  readonly ready: Promise<void>;
  collisionStatus: CollisionStatus;
  /** Human-readable problems (load failure, spawn without floor...). */
  readonly warnings: string[] = [];

  private world: CollisionWorld;
  private readonly input: NavInputDevice;
  private readonly debug: NavDebugView;
  private readonly hud: HTMLDivElement;
  private readonly hudWarn: HTMLDivElement;
  private readonly hudInfo: HTMLDivElement;
  private readonly cross: HTMLDivElement;
  private active = false;
  private lastTime: number | null = null;
  private readonly abort = new AbortController();

  constructor(private readonly opts: NavigationOptions) {
    const cfg = opts.config;
    injectCss();
    this.world = CollisionWorld.flatFloor(cfg.fallbackFloorY);
    this.collisionStatus = cfg.collision ? "loading" : "none";
    this.player = new PlayerController(this.world, cfg, this.chooseSpawn(this.world));

    this.input = new NavInputDevice(opts.canvas, opts.uiRoot, cfg.lookSensitivity);
    this.debug = new NavDebugView(opts.scene);
    this.debug.visible = cfg.debug;
    this.debug.setWorld(this.world);

    this.hudWarn = document.createElement("div");
    this.hudWarn.className = "nav-warn";
    this.hudInfo = document.createElement("div");
    this.hud = document.createElement("div");
    this.hud.className = "nav-hud";
    this.hud.hidden = true;
    this.hud.append(this.hudWarn, this.hudInfo);
    this.cross = document.createElement("div");
    this.cross.className = "nav-cross";
    this.cross.hidden = true;
    opts.uiRoot.append(this.hud, this.cross);

    window.addEventListener("keydown", (e) => this.onKey(e), { signal: this.abort.signal });
    document.addEventListener("pointerlockchange", () => this.renderHud(), { signal: this.abort.signal });

    this.ready = cfg.collision ? this.loadCollision(cfg.collision) : Promise.resolve();
    this.renderHud();
  }

  // ------------------------------------------------------------- public API

  getMode(): NavMode {
    return this.player.mode;
  }

  /** Returns the mode in effect: "fly" is refused unless navigation.allowFly. */
  setMode(mode: NavMode): NavMode {
    const m = this.player.setMode(mode);
    this.renderHud();
    return m;
  }

  getPose(): NavPose {
    return this.player.getPose();
  }

  teleport(pose: NavPose): void {
    this.player.teleport(pose);
    this.syncDebug();
  }

  moveTo(pose: NavPose, durationMs: number): Promise<boolean> {
    return this.player.moveTo(pose, durationMs);
  }

  respawn(): void {
    this.player.respawn();
    this.syncDebug();
  }

  get config(): NavigationConfig {
    return this.opts.config;
  }

  get collisionWorld(): CollisionWorld {
    return this.world;
  }

  get debugVisible(): boolean {
    return this.debug.visible;
  }

  set debugVisible(v: boolean) {
    this.debug.visible = v;
    this.syncDebug();
  }

  // ------------------------------------------- CameraRig walk-mode contract

  setActive(active: boolean): void {
    this.active = active;
    this.input.setActive(active);
    this.lastTime = null;
    this.syncDebug();
    this.renderHud();
  }

  setSpeedScale(scale: number): void {
    this.player.speedScale = scale;
  }

  enterFrom(camera: THREE.PerspectiveCamera): void {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const yaw = THREE.MathUtils.radToDeg(Math.atan2(-fwd.x, -fwd.z));
    const pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1)));
    const p = camera.position;
    this.teleport({ position: [p.x, p.y, p.z], yaw, pitch: THREE.MathUtils.clamp(pitch, -30, 30) });
  }

  /** Called every frame by CameraRig while first-person controls are active. */
  update(camera: THREE.PerspectiveCamera): void {
    const now = performance.now();
    const dt = this.lastTime === null ? 0 : (now - this.lastTime) / 1000;
    this.lastTime = now;
    const input = this.input.poll();
    // Hold the player still until the collision GLB has loaded (or failed).
    if (this.collisionStatus !== "loading") this.player.step(dt, input);
    this.player.getEyePosition(camera.position);
    this.player.getQuaternion(camera.quaternion);
    this.syncDebug();
    if (this.player.respawnCount !== this.shownRespawns) {
      this.shownRespawns = this.player.respawnCount;
      this.renderHud();
    }
  }

  /** "Reset view" (V) in first-person: back to spawn. */
  reset(): void {
    this.respawn();
  }

  dispose(): void {
    this.abort.abort();
    this.input.dispose();
    this.debug.dispose();
    this.hud.remove();
    this.cross.remove();
  }

  // --------------------------------------------------------------- internals

  private shownRespawns = 0;

  private async loadCollision(url: string): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(url);
      const world = CollisionWorld.fromObject(gltf.scene);
      if (world.isEmpty) throw new Error("the file contains no triangle meshes");
      this.world = world;
      this.collisionStatus = "loaded";
      this.player.setWorld(world, false);
      this.player.setSpawn(this.chooseSpawn(world));
      this.player.respawn();
      console.info(`[nav] collision "${url}": ${world.triangleCount} triangles`, { ...world.counts });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.collisionStatus = "failed";
      this.warnings.push(`Collision mesh "${url}" failed to load (${msg}). Walking on a flat floor at y = ${this.opts.config.fallbackFloorY}.`);
      console.warn(`[nav] collision "${url}" failed to load, using flat fallback floor`, err);
      this.player.respawn();
    }
    this.debug.setWorld(this.world);
    this.syncDebug();
    this.renderHud();
  }

  /** Spawn candidates in order; the first with a walkable floor below wins. */
  private chooseSpawn(world: CollisionWorld): NavPose {
    const cfg = this.opts.config;
    const candidates: { pose: NavPose; from: string }[] = [];
    if (cfg.spawn) candidates.push({ pose: cfg.spawn, from: "navigation.spawn" });
    const cam = this.opts.cameraStart;
    if (cam) {
      const [px, py, pz] = cam.position;
      const [tx, ty, tz] = cam.target;
      const dx = tx - px;
      const dy = ty - py;
      const dz = tz - pz;
      const yaw = THREE.MathUtils.radToDeg(Math.atan2(-dx, -dz));
      const pitch = THREE.MathUtils.radToDeg(Math.atan2(dy, Math.hypot(dx, dz)));
      candidates.push({ pose: { position: [px, py, pz], yaw, pitch: THREE.MathUtils.clamp(pitch, -30, 30) }, from: "camera" });
    }
    if (!world.isEmpty && world.bounds.min.y > -1e6) {
      const c = world.bounds.getCenter(new THREE.Vector3());
      candidates.push({ pose: { position: [c.x, world.bounds.min.y + cfg.eyeHeight, c.z], yaw: 0, pitch: 0 }, from: "collision bounds" });
    }
    candidates.push({ pose: { position: [0, cfg.fallbackFloorY + cfg.eyeHeight, 0], yaw: 0, pitch: 0 }, from: "origin" });

    const down = new THREE.Vector3(0, -1, 0);
    const minNy = Math.cos(THREE.MathUtils.degToRad(cfg.maxSlopeDeg)) - 1e-4;
    const hasFloor = (p: NavPose) =>
      world
        .raycastAll(new THREE.Vector3(p.position[0], p.position[1] + 0.1, p.position[2]), down, 1000, new Set(["floor", "solid"]))
        .some((h) => h.normal.y >= minNy);
    const pick = candidates.find((c) => hasFloor(c.pose)) ?? candidates[0];
    if (cfg.spawn && pick.from !== "navigation.spawn" && this.collisionStatus !== "loading") {
      this.warnings.push(`navigation.spawn has no walkable floor below it; spawning from ${pick.from} instead.`);
    }
    return pick.pose;
  }

  private onKey(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;
    if (e.code === "KeyN" && e.shiftKey && !e.repeat) {
      this.debugVisible = !this.debugVisible;
    } else if (e.code === "KeyF" && this.active && !e.repeat) {
      const want: NavMode = this.player.mode === "walk" ? "fly" : "walk";
      const got = this.setMode(want);
      if (got !== want) this.flashInfo("Flying is disabled (navigation.allowFly)");
    }
  }

  private flashUntil = 0;
  private flashText = "";

  private flashInfo(text: string): void {
    this.flashText = text;
    this.flashUntil = performance.now() + 2000;
    this.renderHud();
    window.setTimeout(() => this.renderHud(), 2050);
  }

  private syncDebug(): void {
    this.debug.capsuleVisible = !this.active;
    if (this.debug.visible) this.debug.updateCapsule(this.player.feet, this.opts.config.radius, this.opts.config.height);
  }

  private renderHud(): void {
    this.hud.hidden = !this.active;
    this.cross.hidden = !this.active;
    if (!this.active) return;
    const warnings = [...this.warnings];
    if (this.collisionStatus === "none") {
      warnings.unshift(`No collision mesh configured: walking on a flat floor at y = ${this.opts.config.fallbackFloorY}.`);
    }
    if (this.collisionStatus === "loading") warnings.unshift("Loading collision mesh…");
    if (this.player.respawnCount > 0) warnings.push(`Fell out of the world: respawned (${this.player.respawnCount}x).`);
    this.hudWarn.hidden = warnings.length === 0;
    this.hudWarn.textContent = warnings.join(" ");
    const mode = this.player.mode === "fly" ? "Fly" : "Walk";
    let info: string;
    if (performance.now() < this.flashUntil) info = this.flashText;
    else if (isTouch() && !this.input.pointerLocked) info = `${mode} · left side: move · right side: look`;
    else if (!this.input.pointerLocked) info = `${mode} · click to look around · WASD move · Shift run`;
    else {
      const extra = this.player.mode === "fly" ? " · Space/E up · Ctrl/Q down" : this.opts.config.allowJump ? " · Space jump" : "";
      info = `${mode} · WASD move · Shift run${extra}${this.player.canFly ? " · F walk/fly" : ""} · Shift+N colliders · Esc release mouse`;
    }
    this.hudInfo.textContent = info;
  }
}
