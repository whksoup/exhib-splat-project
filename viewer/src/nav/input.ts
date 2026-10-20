/**
 * Desktop + touch input for first-person navigation. Produces a NavInput
 * each frame; knows nothing about physics. Later input sources (gamepad,
 * WebXR thumbsticks) can be merged into the same NavInput by the caller.
 *
 * Desktop: WASD / arrows move, Shift runs, mouse looks (pointer lock after a
 *          click on the canvas; plain drag-to-look if pointer lock is
 *          unavailable or refused). Space jumps (walk) or rises (fly), E rises,
 *          Ctrl / Q descend.
 * Touch:   left half = virtual joystick (push far to run), right half = drag to look.
 */
import { emptyInput, type NavInput } from "./player";

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/** Keys whose browser default (scrolling, etc.) we block while active. */
const BLOCK_DEFAULT = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export class NavInputDevice {
  active = false;
  /** Degrees per pixel. */
  sensitivity: number;
  private readonly keys = new Set<string>();
  private jumpQueued = false;
  private lookYaw = 0;
  private lookPitch = 0;
  private dragId: number | null = null;
  private dragLast = { x: 0, y: 0 };
  private joyId: number | null = null;
  private joyOrigin = { x: 0, y: 0 };
  private joy = { x: 0, y: 0 };
  private readonly joyBase: HTMLDivElement;
  private readonly joyKnob: HTMLDivElement;
  private readonly abort = new AbortController();
  private pointerLockFailed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
    sensitivity: number,
  ) {
    this.sensitivity = sensitivity;
    this.joyBase = document.createElement("div");
    this.joyBase.className = "nav-joy";
    this.joyBase.hidden = true;
    this.joyKnob = document.createElement("div");
    this.joyKnob.className = "nav-joy-knob";
    this.joyBase.append(this.joyKnob);
    uiRoot.append(this.joyBase);

    const opts = { signal: this.abort.signal };
    window.addEventListener("keydown", (e) => this.onKey(e, true), opts);
    window.addEventListener("keyup", (e) => this.onKey(e, false), opts);
    window.addEventListener("blur", () => this.keys.clear(), opts);
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e), opts);
    window.addEventListener("pointermove", (e) => this.onPointerMove(e), opts);
    window.addEventListener("pointerup", (e) => this.onPointerUp(e), opts);
    window.addEventListener("pointercancel", (e) => this.onPointerUp(e), opts);
    document.addEventListener("pointerlockerror", () => (this.pointerLockFailed = true), opts);
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.keys.clear();
      this.endJoystick();
      this.dragId = null;
      if (this.pointerLocked) document.exitPointerLock();
    }
  }

  /** Collect input since the last call. */
  poll(): NavInput {
    const input = emptyInput();
    if (!this.active) return input;
    let mx = 0;
    let my = 0;
    for (const k of this.keys) {
      const m = MOVE_KEYS[k];
      if (m) {
        mx += m[0];
        my += m[1];
      }
    }
    mx = Math.max(-1, Math.min(1, mx + this.joy.x));
    my = Math.max(-1, Math.min(1, my + this.joy.y));
    input.moveX = mx;
    input.moveY = my;
    const up = this.keys.has("Space") || this.keys.has("KeyE") || this.keys.has("PageUp");
    const down =
      this.keys.has("ControlLeft") || this.keys.has("ControlRight") || this.keys.has("KeyQ") || this.keys.has("PageDown");
    input.moveUp = (up ? 1 : 0) - (down ? 1 : 0);
    input.run = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || Math.hypot(this.joy.x, this.joy.y) > 0.95;
    input.jump = this.jumpQueued;
    this.jumpQueued = false;
    input.lookYaw = this.lookYaw;
    input.lookPitch = this.lookPitch;
    this.lookYaw = 0;
    this.lookPitch = 0;
    return input;
  }

  dispose(): void {
    this.abort.abort();
    this.joyBase.remove();
  }

  // ------------------------------------------------------------ handlers

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.active) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    if (down) {
      if (e.code === "Space" && !e.repeat) this.jumpQueued = true;
      this.keys.add(e.code);
    } else {
      this.keys.delete(e.code);
    }
    if (BLOCK_DEFAULT.has(e.code)) e.preventDefault();
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.active) return;
    if (e.pointerType === "touch") {
      const leftHalf = e.clientX < window.innerWidth / 2;
      if (leftHalf && this.joyId === null) {
        this.joyId = e.pointerId;
        this.joyOrigin = { x: e.clientX, y: e.clientY };
        this.joy = { x: 0, y: 0 };
        this.joyBase.hidden = false;
        this.joyBase.style.left = `${e.clientX}px`;
        this.joyBase.style.top = `${e.clientY}px`;
        this.joyKnob.style.transform = "translate(-50%, -50%)";
      } else if (!leftHalf && this.dragId === null) {
        this.dragId = e.pointerId;
        this.dragLast = { x: e.clientX, y: e.clientY };
      }
      return;
    }
    // Mouse / pen.
    if (e.button !== 0) return;
    if (!this.pointerLocked && !this.pointerLockFailed && this.canvas.requestPointerLock) {
      try {
        const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        p?.catch?.(() => (this.pointerLockFailed = true));
      } catch {
        this.pointerLockFailed = true;
      }
    }
    this.dragId = e.pointerId;
    this.dragLast = { x: e.clientX, y: e.clientY };
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.active) return;
    if (e.pointerType === "mouse" && this.pointerLocked) {
      this.look(e.movementX, e.movementY);
      return;
    }
    if (e.pointerId === this.joyId) {
      const radius = 60;
      let dx = e.clientX - this.joyOrigin.x;
      let dy = e.clientY - this.joyOrigin.y;
      const d = Math.hypot(dx, dy);
      if (d > radius) {
        dx = (dx / d) * radius;
        dy = (dy / d) * radius;
      }
      this.joy = { x: dx / radius, y: -dy / radius };
      this.joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      return;
    }
    if (e.pointerId === this.dragId) {
      const dx = e.clientX - this.dragLast.x;
      const dy = e.clientY - this.dragLast.y;
      this.dragLast = { x: e.clientX, y: e.clientY };
      // Touch drag feels better a bit faster than mouse; drag "grabs" the view.
      this.look(dx * (e.pointerType === "touch" ? 1.6 : 1), dy * (e.pointerType === "touch" ? 1.6 : 1));
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerId === this.joyId) this.endJoystick();
    if (e.pointerId === this.dragId) this.dragId = null;
  }

  private endJoystick(): void {
    this.joyId = null;
    this.joy = { x: 0, y: 0 };
    this.joyBase.hidden = true;
  }

  private look(dx: number, dy: number): void {
    this.lookYaw -= dx * this.sensitivity;
    this.lookPitch -= dy * this.sensitivity;
  }
}
