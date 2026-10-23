/**
 * First-person player controller: a capsule moved through a CollisionWorld.
 * Pure logic (three.js math only, no DOM, no clock): call step(dt, input)
 * each frame. Input sources (keyboard, touch, later gamepad / WebXR
 * thumbsticks) just fill a NavInput, so Phase 4 can drive the same player.
 *
 * Walk model ("floating capsule"):
 *  - floor / solid / ceiling colliders are tested with a capsule whose bottom
 *    sits `stepHeight` above the feet, so anything up to step height passes
 *    under it and is climbed by the ground snap; taller things block it.
 *  - wall / bound colliders are tested with a near full-height capsule and
 *    push horizontally only, so they always block and are never climbed.
 *  - ground = highest walkable hit (normal within maxSlope, floor/solid kinds)
 *    from short downward rays; the feet snap to it (up by <= stepHeight when
 *    walking up stairs, down by <= stepHeight when walking down them).
 *  - movement is split into substeps of at most radius/2, so nothing
 *    tunnels through a wall at high speed or after a frame hitch.
 * Fly model: no gravity; full capsule against every kind including nofly;
 * optional maxHeight plane.
 */
import * as THREE from "three";
import { CollisionWorld, type ColliderKind } from "./colliders";
import type { NavigationConfig, NavMode, NavPose } from "./navConfig";

export interface NavInput {
  /** Strafe right (+) / left (-), -1..1. */
  moveX: number;
  /** Forward (+) / back (-), -1..1. */
  moveY: number;
  /** Fly up (Space/E) and down (Ctrl/Q), -1..1 combined as up - down. */
  moveUp: number;
  run: boolean;
  /** Jump request (edge-triggered by the caller; consumed by step()). */
  jump: boolean;
  /** Look deltas in degrees since last step (positive yaw = turn left, positive pitch = look up). */
  lookYaw: number;
  lookPitch: number;
}

export function emptyInput(): NavInput {
  return { moveX: 0, moveY: 0, moveUp: 0, run: false, jump: false, lookYaw: 0, lookPitch: 0 };
}

const WALK_SOLID: ReadonlySet<ColliderKind> = new Set(["floor", "solid", "ceiling"]);
const WALK_WALLS: ReadonlySet<ColliderKind> = new Set(["wall", "bound"]);
const WALKABLE: ReadonlySet<ColliderKind> = new Set(["floor", "solid"]);
const FLY_ALL: ReadonlySet<ColliderKind> = new Set(["floor", "solid", "ceiling", "wall", "bound", "nofly"]);
const isWall = (k: ColliderKind) => k === "wall" || k === "bound";

/** Feet clearance of the wall capsule, so wall bases touching the floor don't snag. */
const WALL_FOOT_CLEARANCE = 0.05;
const MAX_FALL_SPEED = 50;
const MAX_DT = 0.1;

interface MoveAnim {
  from: THREE.Vector3;
  to: THREE.Vector3;
  fromYaw: number;
  toYaw: number;
  fromPitch: number;
  toPitch: number;
  t: number;
  duration: number;
  resolve: (completed: boolean) => void;
}

const _seg = new THREE.Line3();
const _prev = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _o = new THREE.Vector3();
const _wish = new THREE.Vector3();

export class PlayerController {
  /** Feet position (bottom of the capsule). */
  readonly feet = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Degrees. */
  yaw = 0;
  pitch = 0;
  grounded = false;
  /** Smoothed eye offset so stepping up stairs doesn't jolt the camera. */
  private eyeSmoothY = 0;
  private _mode: NavMode;
  private anim: MoveAnim | null = null;
  private spawn: NavPose;
  /** Set when the player fell below killY and was respawned (for the HUD). */
  respawnCount = 0;
  /** Multiplies walk / run / fly speeds (the camera speed slider); jumps and gravity are not scaled. */
  speedScale = 1;

  constructor(
    public world: CollisionWorld,
    readonly cfg: NavigationConfig,
    spawn: NavPose,
  ) {
    this._mode = cfg.mode === "fly" && cfg.allowFly ? "fly" : "walk";
    this.spawn = spawn;
    this.teleport(spawn);
  }

  // ---------------------------------------------------------------- API

  get mode(): NavMode {
    return this._mode;
  }

  /** Returns the mode actually in effect (fly is refused unless allowFly). */
  setMode(mode: NavMode): NavMode {
    if (mode === "fly" && !this.cfg.allowFly) return this._mode;
    if (mode !== this._mode) {
      this._mode = mode;
      this.velocity.set(0, 0, 0);
      this.grounded = false;
    }
    return this._mode;
  }

  get canFly(): boolean {
    return this.cfg.allowFly;
  }

  get killY(): number {
    if (this.cfg.killY !== undefined) return this.cfg.killY;
    const minY = this.world.isEmpty ? this.cfg.fallbackFloorY : Math.min(this.world.bounds.min.y, this.cfg.fallbackFloorY);
    return minY - 20;
  }

  /** Eye position (camera), including step smoothing. */
  getEyePosition(target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(this.feet).setY(this.feet.y + this.cfg.eyeHeight + this.eyeSmoothY);
  }

  getPose(): NavPose {
    const e = this.getEyePosition();
    return { position: [e.x, e.y, e.z], yaw: this.yaw, pitch: this.pitch };
  }

  /** Camera orientation (YXZ Euler from yaw/pitch). */
  getQuaternion(target = new THREE.Quaternion()): THREE.Quaternion {
    return target.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(this.pitch), THREE.MathUtils.degToRad(this.yaw), 0, "YXZ"));
  }

  setSpawn(pose: NavPose): void {
    this.spawn = pose;
  }

  respawn(): void {
    this.teleport(this.spawn);
  }

  /** Swap the collision world (e.g. GLB finished loading) and re-place the player. */
  setWorld(world: CollisionWorld, replace = true): void {
    this.world = world;
    if (replace) this.respawn();
  }

  /**
   * Jump to a pose. In walk mode the player lands on the first walkable
   * surface below the pose (see NavPose). Cancels a running moveTo.
   */
  teleport(pose: NavPose): void {
    this.cancelAnim();
    const target = this.resolvePose(pose);
    this.feet.copy(target.feet);
    this.yaw = target.yaw;
    this.pitch = target.pitch;
    this.velocity.set(0, 0, 0);
    this.grounded = target.grounded;
    this.eyeSmoothY = 0;
  }

  /**
   * Animate smoothly to a pose over durationMs (ease in-out), then land on
   * the floor in walk mode. Collisions are not tested along the way (it is
   * a camera transition between known-good viewpoints). Resolves true when
   * it completes, false if interrupted by teleport/moveTo/respawn.
   */
  moveTo(pose: NavPose, durationMs: number): Promise<boolean> {
    this.cancelAnim();
    const target = this.resolvePose(pose);
    if (durationMs <= 0) {
      this.teleport(pose);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let toYaw = target.yaw;
      // Shortest way round.
      while (toYaw - this.yaw > 180) toYaw -= 360;
      while (toYaw - this.yaw < -180) toYaw += 360;
      this.anim = {
        from: this.feet.clone().setY(this.feet.y + this.eyeSmoothY),
        to: target.feet.clone(),
        fromYaw: this.yaw,
        toYaw,
        fromPitch: this.pitch,
        toPitch: target.pitch,
        t: 0,
        duration: durationMs / 1000,
        resolve,
      };
      this.eyeSmoothY = 0;
    });
  }

  get isAnimating(): boolean {
    return this.anim !== null;
  }

  // --------------------------------------------------------------- step

  step(dtIn: number, input: NavInput): void {
    const dt = Math.min(Math.max(dtIn, 0), MAX_DT);
    if (this.anim) {
      this.stepAnim(dt);
      return;
    }
    this.yaw = (this.yaw + input.lookYaw) % 360;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.lookPitch, -89, 89);
    if (dt === 0) return;

    // Desired horizontal velocity (yaw-relative, input clamped to unit length).
    const yawR = THREE.MathUtils.degToRad(this.yaw);
    let mx = input.moveX;
    let my = input.moveY;
    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    // forward = (-sin yaw, 0, -cos yaw); right = (cos yaw, 0, -sin yaw)
    _wish.set(-Math.sin(yawR) * my + Math.cos(yawR) * mx, 0, -Math.cos(yawR) * my - Math.sin(yawR) * mx);

    if (this._mode === "fly") {
      const speed = this.cfg.flySpeed * (input.run ? this.cfg.flyRunMultiplier : 1) * this.speedScale;
      _wish.multiplyScalar(speed);
      _wish.y = THREE.MathUtils.clamp(input.moveUp, -1, 1) * speed;
      this.velocity.lerp(_wish, 1 - Math.exp(-dt * 10));
    } else {
      const speed = (input.run ? this.cfg.runSpeed : this.cfg.walkSpeed) * this.speedScale;
      _wish.multiplyScalar(speed);
      const k = 1 - Math.exp(-dt * (this.grounded ? 14 : 2));
      this.velocity.x += (_wish.x - this.velocity.x) * k;
      this.velocity.z += (_wish.z - this.velocity.z) * k;
      if (this.grounded && input.jump && this.cfg.allowJump) {
        this.velocity.y = this.cfg.jumpSpeed;
        this.grounded = false;
      }
    }
    input.jump = false;

    // Substeps: never move more than radius/2 per collision pass.
    const maxStep = this.cfg.radius * 0.5;
    const travel = this.velocity.length() * dt + (this._mode === "walk" && !this.grounded ? this.cfg.gravity * dt * dt : 0);
    const n = Math.min(64, Math.max(1, Math.ceil(travel / maxStep)));
    const sub = dt / n;
    for (let i = 0; i < n; i++) {
      if (this._mode === "fly") this.substepFly(sub);
      else this.substepWalk(sub);
    }

    // Ease the step-up camera offset back to zero.
    this.eyeSmoothY *= Math.exp(-dt * 12);
    if (Math.abs(this.eyeSmoothY) < 1e-4) this.eyeSmoothY = 0;

    if (this.feet.y < this.killY || !Number.isFinite(this.feet.y + this.feet.x + this.feet.z)) {
      this.respawnCount++;
      this.respawn();
    }
  }

  private substepWalk(dt: number): void {
    const c = this.cfg;
    if (!this.grounded) {
      this.velocity.y = Math.max(this.velocity.y - c.gravity * dt, -MAX_FALL_SPEED);
    } else if (this.velocity.y < 0) {
      this.velocity.y = 0;
    }
    const startY = this.feet.y;
    _prev.copy(this.feet);
    this.feet.addScaledVector(this.velocity, dt);

    // 1) walls / bounds: near full-height capsule, horizontal pushes only.
    this.capsule(_seg, WALL_FOOT_CLEARANCE);
    _o.copy(_prev).setY(_prev.y + c.height / 2);
    let r = this.world.pushOut(_seg, c.radius, WALK_WALLS, { horizontalOnly: isWall, prevCenter: _o });
    this.feet.add(r.offset);

    // 2) floors / solids / ceilings: floating capsule above step height.
    this.capsule(_seg, c.stepHeight);
    // Grounded: pushes are horizontal, so a block taller than a step stops us
    // instead of lifting us, and a low beam stops us instead of pushing us
    // into the floor. Airborne (jumping/falling): full 3D pushes.
    const grounded = this.grounded;
    r = this.world.pushOut(_seg, c.radius, WALK_SOLID, { horizontalOnly: () => grounded, prevCenter: _o });
    this.feet.add(r.offset);
    if (r.minPushY < -0.3 && this.velocity.y > 0) this.velocity.y = 0; // head hit a ceiling

    // 3) ground.
    const falling = this.velocity.y <= 0;
    const snapDown = this.grounded ? c.stepHeight : Math.max(0, startY - this.feet.y) + 0.02;
    const ground = falling ? this.findGround(this.feet, snapDown) : null;
    if (ground !== null && ground >= this.feet.y - snapDown) {
      const dy = ground - this.feet.y;
      if (dy > 0.01) this.eyeSmoothY -= dy; // stepped up: lag the camera a little
      this.feet.y = ground;
      this.velocity.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    // Walking into a slope too steep to stand on: don't let walking climb it.
    if (!this.grounded && this.velocity.y <= 0 && this.feet.y > startY + 1e-4 && r.maxPushY > 0) {
      this.feet.y = startY;
    }
  }

  private substepFly(dt: number): void {
    const c = this.cfg;
    _prev.copy(this.feet);
    this.feet.addScaledVector(this.velocity, dt);
    if (c.maxHeight !== undefined && this.feet.y + c.height > c.maxHeight) {
      this.feet.y = c.maxHeight - c.height;
      if (this.velocity.y > 0) this.velocity.y = 0;
    }
    this.capsule(_seg, 0);
    _o.copy(_prev).setY(_prev.y + c.height / 2);
    const r = this.world.pushOut(_seg, c.radius, FLY_ALL, { prevCenter: _o });
    this.feet.add(r.offset);
    if (r.minPushY < -0.3 && this.velocity.y > 0) this.velocity.y = 0;
    if (r.maxPushY > 0.3 && this.velocity.y < 0) this.velocity.y = 0;
    this.grounded = false;
  }

  /** Capsule segment for the current feet, with its bottom `bottomLift` above the feet. */
  private capsule(target: THREE.Line3, bottomLift: number): THREE.Line3 {
    const r = this.cfg.radius;
    target.start.copy(this.feet).setY(this.feet.y + bottomLift + r);
    target.end.copy(this.feet).setY(this.feet.y + this.cfg.height - r);
    if (target.end.y < target.start.y) target.end.y = target.start.y;
    return target;
  }

  /**
   * Height of the highest walkable surface under `feet`, from feet + step
   * height down to feet - snapDown. Centre ray first; if it finds nothing
   * walkable, four rays at half radius (standing on an edge).
   */
  findGround(feet: THREE.Vector3, snapDown: number): number | null {
    const top = this.cfg.stepHeight + 0.02;
    const far = top + snapDown;
    const centre = this.groundRay(feet.x, feet.y + top, feet.z, far);
    if (centre !== null) return centre;
    const d = this.cfg.radius * 0.5;
    let best: number | null = null;
    for (const [ox, oz] of [[d, 0], [-d, 0], [0, d], [0, -d]] as const) {
      const h = this.groundRay(feet.x + ox, feet.y + top, feet.z + oz, far);
      if (h !== null && (best === null || h > best)) best = h;
    }
    return best;
  }

  private groundRay(x: number, y: number, z: number, far: number): number | null {
    const minNy = Math.cos(THREE.MathUtils.degToRad(this.cfg.maxSlopeDeg)) - 1e-4;
    const hits = this.world.raycastAll(new THREE.Vector3(x, y, z), _down, far, WALKABLE);
    for (const h of hits) if (h.normal.y >= minNy) return h.point.y;
    return null;
  }

  /** Where a pose puts the player (floor-snapped in walk mode). */
  private resolvePose(pose: NavPose): { feet: THREE.Vector3; yaw: number; pitch: number; grounded: boolean } {
    const [x, y, z] = pose.position;
    const yaw = pose.yaw ?? this.yaw;
    const pitch = THREE.MathUtils.clamp(pose.pitch ?? 0, -89, 89);
    const eyeFeet = new THREE.Vector3(x, y - this.cfg.eyeHeight, z);
    if (this._mode === "fly") return { feet: eyeFeet, yaw, pitch, grounded: false };
    const minNy = Math.cos(THREE.MathUtils.degToRad(this.cfg.maxSlopeDeg)) - 1e-4;
    const hits = this.world.raycastAll(new THREE.Vector3(x, y + 0.1, z), _down, 1000, WALKABLE);
    const hit = hits.find((h) => h.normal.y >= minNy);
    if (hit) return { feet: hit.point.clone(), yaw, pitch, grounded: true };
    // Nothing below: start at eye height and let gravity / killY handle it.
    return { feet: eyeFeet, yaw, pitch, grounded: false };
  }

  private stepAnim(dt: number): void {
    const a = this.anim!;
    a.t = Math.min(1, a.t + dt / a.duration);
    const e = a.t * a.t * (3 - 2 * a.t); // smoothstep
    this.feet.lerpVectors(a.from, a.to, e);
    this.yaw = a.fromYaw + (a.toYaw - a.fromYaw) * e;
    this.pitch = a.fromPitch + (a.toPitch - a.fromPitch) * e;
    if (a.t >= 1) {
      this.anim = null;
      this.velocity.set(0, 0, 0);
      this.grounded = this._mode === "walk" && this.findGround(this.feet, 0.05) !== null;
      a.resolve(true);
    }
  }

  private cancelAnim(): void {
    if (!this.anim) return;
    const a = this.anim;
    this.anim = null;
    a.resolve(false);
  }
}
