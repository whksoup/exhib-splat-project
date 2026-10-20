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

export class CameraRig {
  private readonly orbit: OrbitControls;
  private readonly fly: SparkControls;
  private _mode: ControlsMode;

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

  toggleMode(): ControlsMode {
    this.setMode(this._mode === "orbit" ? "fly" : "orbit");
    return this._mode;
  }

  private applyMode(): void {
    const orbit = this._mode === "orbit";
    this.orbit.enabled = orbit;
    this.fly.fpsMovement.enable = !orbit;
    this.fly.pointerControls.enable = !orbit;
    if (orbit) this.orbit.update();
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

  update(): void {
    if (this._mode === "orbit") this.orbit.update();
    else this.fly.update(this.camera);
  }
}
