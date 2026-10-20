/**
 * Camera controls. Two modes, switchable at runtime (key "C" or overlay):
 *  - orbit: three.js OrbitControls (mouse: L rotate / R pan / wheel zoom;
 *           touch: 1 finger rotate, 2 fingers pinch-zoom + pan)
 *  - fly:   Spark's SparkControls (WASD/QE + mouse drag look; touch drag to
 *           look, two-finger to slide; gamepad). Also what Spark uses for XR,
 *           so Phase 4 can reuse it.
 *
 * Phase 3 animated viewpoint moves should go through setPose()/flyTo() here so
 * both modes stay in sync.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkControls } from "@sparkjsdev/spark";
import type { ControlsMode } from "./config";

/**
 * First-person "walk" mode (collision navigation, src/nav/). Attached after
 * construction with attachWalk(); until then "walk" just freezes the camera.
 */
export interface WalkModeController {
  setActive(active: boolean): void;
  update(camera: THREE.PerspectiveCamera): void;
  /** Back to the spawn point ("Reset view" / V). */
  reset(): void;
}

export class CameraRig {
  private readonly orbit: OrbitControls;
  private readonly fly: SparkControls;
  private _mode: ControlsMode;
  private walk: WalkModeController | null = null;
  /** While true, no camera mode takes input (e.g. Align mode is dragging its gizmo). */
  private suspended = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    mode: ControlsMode,
  ) {
    this.orbit = new OrbitControls(camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.screenSpacePanning = true;
    this.orbit.zoomToCursor = true;
    this.orbit.minDistance = 0.05;

    this.fly = new SparkControls({ canvas });
    this._mode = mode;
    this.applyMode();
  }

  get mode(): ControlsMode {
    return this._mode;
  }

  setMode(mode: ControlsMode): void {
    if (mode === this._mode) return;
    if (mode === "orbit") {
      // Keep looking where the fly camera was looking.
      const dist = Math.max(0.5, this.orbit.target.distanceTo(this.camera.position));
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.orbit.target.copy(this.camera.position).addScaledVector(fwd, dist);
    }
    this._mode = mode;
    this.applyMode();
  }

  /** Cycle orbit -> fly -> walk (when a walk controller is attached) -> orbit. */
  toggleMode(): ControlsMode {
    const next: ControlsMode =
      this._mode === "orbit" ? "fly" : this._mode === "fly" && this.walk ? "walk" : "orbit";
    this.setMode(next);
    return this._mode;
  }

  attachWalk(walk: WalkModeController): void {
    this.walk = walk;
    this.applyMode();
  }

  /** In walk mode, send the player back to spawn. Returns false in other modes. */
  resetWalk(): boolean {
    if (this._mode !== "walk" || !this.walk) return false;
    this.walk.reset();
    return true;
  }

  /** Stop (or resume) all camera input without changing the mode, e.g. while a gizmo is dragged. */
  setSuspended(suspended: boolean): void {
    if (suspended === this.suspended) return;
    this.suspended = suspended;
    this.applyMode();
  }

  private applyMode(): void {
    const on = !this.suspended;
    const orbit = this._mode === "orbit";
    const fly = this._mode === "fly";
    this.orbit.enabled = orbit && on;
    this.fly.fpsMovement.enable = fly && on;
    this.fly.pointerControls.enable = fly && on;
    this.walk?.setActive(this._mode === "walk" && on);
    if (orbit && on) this.orbit.update();
  }

  /** Place the camera and point it at `target`. */
  setPose(position: THREE.Vector3, target: THREE.Vector3): void {
    this.camera.position.copy(position);
    this.camera.lookAt(target);
    this.orbit.target.copy(target);
    // Scale movement speeds to the scene size implied by the pose.
    const dist = Math.max(0.1, position.distanceTo(target));
    this.fly.fpsMovement.moveSpeed = Math.max(0.5, dist * 0.75);
    this.orbit.update();
  }

  /** Translate the camera and orbit target together (view direction unchanged). */
  shift(offset: THREE.Vector3): void {
    this.camera.position.add(offset);
    this.orbit.target.add(offset);
    this.orbit.update();
  }

  update(): void {
    if (this._mode === "orbit") this.orbit.update();
    else if (this._mode === "walk") this.walk?.update(this.camera);
    else this.fly.update(this.camera);
  }
}
