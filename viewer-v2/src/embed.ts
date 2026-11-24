/**
 * Embedded walk: viewer-v2 inside the In the Ether exhibition's walk iframe
 * (`?embedded=1`, usually with `?config=models/<name>/viewer.json&space=<id>`).
 *
 * The exhibition host owns routes, history and return state. This page only
 * renders the splat, walks it, and reports where the visitor stands. The API
 * mirrors the exhibition's older `window.oculusPrototype` so the host's
 * return-state code stays the same:
 *
 *   window.splatWalk.diagnostics            renderer, device, budget, models, load errors
 *   window.splatWalk.connect(options)       start (options.saved restores a snapshot)
 *   window.splatWalk.restore(saved)         jump to a snapshot (Back / Forward)
 *   window.splatWalk.state                  the current snapshot
 *   window.splatWalk.disconnect()           stop and free everything
 *
 * Messages to the parent window (same origin only):
 *   {type: "splat-walk-ready"}                          the API above is defined
 *   {type: "splat-walk-failed", reason, message}        reason: no-webgpu | renderer | config | model
 *
 * Everything below `createSplatWalk` is pure and unit tested (embed.test.ts).
 */
import type { NavMode, NavPose } from "./nav/navConfig";

export const READY_MESSAGE = "splat-walk-ready";
export const FAILED_MESSAGE = "splat-walk-failed";

export type FailureReason = "no-webgpu" | "renderer" | "config" | "model";

/** What the host stores in history for a splat walk. Opaque to the host except `panel`. */
export interface SplatWalkSnapshot {
  kind: "splat-walk";
  v: 1;
  /** Exhibition space id (lobby, b2). A snapshot from another space is not restored. */
  space: string;
  mode: NavMode;
  pose: { position: [number, number, number]; yaw: number; pitch: number };
  /** Slice 2 adds artwork cards; until then always null (the host checks `panel === "artwork"`). */
  panel: null;
}

export type ChangeAction = "replace" | "push";

export interface ConnectOptions {
  /** A snapshot from the host's history (ignored unless it is a splat-walk snapshot of this space). */
  saved?: unknown;
  /** The landing camera; unused until the room's frame mapping exists (plan step 6). */
  entry?: unknown;
  /** Artwork to arrive at; slice 2. */
  workId?: string | null;
  onChange?: (snapshot: SplatWalkSnapshot, action: ChangeAction) => void;
  /** Return true when the host handled it (it went back in history). */
  onBack?: () => boolean | void;
  onExit?: () => void;
}

/** The parts of Navigation the walk API drives (a fake in tests). */
export interface WalkTarget {
  getPose(): NavPose;
  teleport(pose: NavPose): void;
  respawn(): void;
  getMode(): NavMode;
  setMode(mode: NavMode): NavMode;
  /** True while the pointer is locked to the canvas (Escape then only releases it). */
  pointerLocked(): boolean;
}

export interface SplatWalkApi {
  readonly diagnostics: Record<string, unknown>;
  readonly state: SplatWalkSnapshot;
  connect(options?: ConnectOptions): Promise<void>;
  restore(saved: unknown, options?: { signal?: AbortSignal }): Promise<void>;
  disconnect(): void;
}

export interface SplatWalkSetup {
  space: string;
  target: WalkTarget;
  diagnostics: () => Record<string, unknown>;
  /** Frees the viewer (render loop, models, GPU). Called once by disconnect(). */
  dispose: () => void;
  /** Where Escape is listened for. */
  keyTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
  /** How often the snapshot is offered to the host (deduplicated). */
  publishMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}

export function isEmbedded(search: string): boolean {
  const v = new URLSearchParams(search).get("embedded");
  return v === "1" || v === "true";
}

/** `?space=` names the exhibition room; defaults to the model name from `?config=models/<name>/viewer.json`. */
export function embeddedSpace(search: string): string {
  const q = new URLSearchParams(search);
  const space = q.get("space");
  if (space) return space;
  return /(?:^|\/)models\/([^/]+)\/viewer\.json$/.exec(q.get("config") ?? "")?.[1] ?? "splat";
}

const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Rounded so that standing still does not publish a new snapshot every tick. */
export function snapshotOf(space: string, pose: NavPose, mode: NavMode): SplatWalkSnapshot {
  const [x, y, z] = pose.position;
  return {
    kind: "splat-walk",
    v: 1,
    space,
    mode,
    pose: { position: [round(x, 3), round(y, 3), round(z, 3)], yaw: round(pose.yaw ?? 0, 2), pitch: round(pose.pitch ?? 0, 2) },
    panel: null,
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A usable snapshot of `space`, or null (another renderer's state, another room, or malformed). */
export function parseSnapshot(saved: unknown, space: string): SplatWalkSnapshot | null {
  if (!saved || typeof saved !== "object") return null;
  const s = saved as Partial<SplatWalkSnapshot>;
  if (s.kind !== "splat-walk" || s.v !== 1 || s.space !== space) return null;
  const p = s.pose;
  if (!p || !Array.isArray(p.position) || p.position.length !== 3 || !p.position.every(finite)) return null;
  if (!finite(p.yaw) || !finite(p.pitch)) return null;
  const mode: NavMode = s.mode === "fly" ? "fly" : "walk";
  return snapshotOf(space, { position: [p.position[0], p.position[1], p.position[2]], yaw: p.yaw, pitch: p.pitch }, mode);
}

/** Why the renderer could not start, from the thrown error (the host shows the fallback either way). */
export function failureReason(err: unknown): FailureReason {
  const msg = err instanceof Error ? err.message : String(err);
  return /webgpu|adapter|gpu device/i.test(msg) ? "no-webgpu" : "renderer";
}

/** True when the browser can give WebGPU an adapter (the GSL WebGPU path needs one). */
export async function hasWebGpu(nav: { gpu?: { requestAdapter(): Promise<unknown> } } = navigator as never): Promise<boolean> {
  if (!nav.gpu) return false;
  try {
    return (await nav.gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

export function createSplatWalk(setup: SplatWalkSetup): SplatWalkApi {
  const { space, target } = setup;
  const keys = setup.keyTarget ?? window;
  const every = setup.setInterval ?? ((fn: () => void, ms: number) => window.setInterval(fn, ms));
  const stop = setup.clearInterval ?? ((id: unknown) => window.clearInterval(id as number));
  let host: ConnectOptions | null = null;
  let timer: unknown = null;
  let last = "";
  let disposed = false;

  const state = () => snapshotOf(space, target.getPose(), target.getMode());
  const publish = (action: ChangeAction = "replace") => {
    if (!host?.onChange) return;
    const snap = state();
    const sig = JSON.stringify(snap);
    if (sig === last && action !== "push") return;
    last = sig;
    host.onChange(snap, action);
  };
  const apply = (snap: SplatWalkSnapshot) => {
    target.setMode(snap.mode);
    target.teleport({ position: snap.pose.position, yaw: snap.pose.yaw, pitch: snap.pose.pitch });
  };
  const onKey = (e: Event) => {
    const k = e as KeyboardEvent;
    if (k.key !== "Escape" || !host || target.pointerLocked()) return;
    // The same contract as the old walk: Back first (an artwork card in slice 2), else leave the walk.
    if (host.onBack?.()) return;
    host.onExit?.();
  };

  return {
    get diagnostics() {
      return { space, connected: !!host, disposed, ...setup.diagnostics() };
    },
    get state() {
      return state();
    },
    async connect(options = {}) {
      if (disposed) throw new Error("This walk has been closed.");
      host = options;
      const saved = parseSnapshot(options.saved, space);
      if (saved) apply(saved);
      else target.respawn();
      last = "";
      keys.addEventListener("keydown", onKey);
      if (timer === null) timer = every(() => publish(), setup.publishMs ?? 250);
      publish();
    },
    async restore(saved, { signal } = {}) {
      if (signal?.aborted || disposed) return;
      const snap = parseSnapshot(saved, space);
      if (snap) apply(snap);
      else target.respawn();
      last = JSON.stringify(state());
    },
    disconnect() {
      if (disposed) return;
      disposed = true;
      host = null;
      if (timer !== null) stop(timer);
      timer = null;
      keys.removeEventListener("keydown", onKey);
      setup.dispose();
    },
  };
}

/** Post to the parent window when there is one (same origin; the host checks event.origin). */
export function tellParent(message: { type: string; [k: string]: unknown }): void {
  if (window.parent && window.parent !== window) window.parent.postMessage(message, window.location.origin);
}
