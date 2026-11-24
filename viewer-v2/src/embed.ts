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
 *   window.splatWalk.pause() / resume()     stop or restart walking (the host pauses while its card is open)
 *   window.splatWalk.escape()               the host's Escape: true when it only paused the walk
 *   window.splatWalk.editStatus(text)       debug mode: the host's save status for an edited collider
 *   window.splatWalk.disconnect()           stop and free everything
 *
 * The host passes the room's artworks on connect (`works`, in this build's
 * frame); the walk draws their markers and in-view card (src/exhibit/) and
 * calls `onOpenWork(id)` when the visitor opens one.
 *
 * A host on another origin can't reach `window.splatWalk`; it drives the same
 * API over postMessage instead (`serveOverMessages`, below).
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
  /** The host owns the artwork card and sets this on its own copy; the walk always reports null. */
  panel: null;
  /** The artwork whose in-view card is showing, if any. */
  preview?: string;
}

export type ChangeAction = "replace" | "push";

export interface ConnectOptions {
  /** A snapshot from the host's history (ignored unless it is a splat-walk snapshot of this space). */
  saved?: unknown;
  /** The landing camera; unused until the room's frame mapping exists (plan step 6). */
  entry?: unknown;
  /** Artwork the host arrived at (the host has already turned it into `saved`). */
  workId?: string | null;
  /** The room's artworks, in this build's frame (see src/exhibit/targeting.ts WalkWork). */
  works?: unknown;
  /** Show the controls guide (a fresh entry rather than a return). */
  guide?: boolean;
  /** The visitor opened an artwork (its marker, the crosshair, or the in-view card). */
  onOpenWork?: (id: string) => void;
  /**
   * Debug mode: an artwork's collider was edited with the gizmo (src/exhibit/colliderEdit.ts
   * WorkEdit, in this build's frame). A returned text (or promise of one) is the save status.
   */
  onEditWork?: (edit: unknown) => unknown;
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

/** The walking interface over the splat (src/exhibit/layer.ts; a fake in tests). */
export interface WalkLayer {
  setWorks(works: unknown): void;
  showGuide(): void;
  setPreview(id: string | null): void;
  pause(focus?: boolean): void;
  resume(): void;
  /** True when Escape only paused walking. */
  escape(): boolean;
  /** Debug mode: show the host's save status for an edited collider. */
  setEditStatus?(text: string): void;
  readonly inView: string | null;
  readonly navigation: "paused" | "explore";
}

export interface SplatWalkApi {
  readonly diagnostics: Record<string, unknown>;
  readonly state: SplatWalkSnapshot;
  connect(options?: ConnectOptions): Promise<void>;
  restore(saved: unknown, options?: { signal?: AbortSignal }): Promise<void>;
  pause(): void;
  resume(): void;
  escape(): boolean;
  /** Reset view: back to where this walk started (the connect snapshot, else spawn). */
  reset(): void;
  /** Offer the current snapshot to the host now (the layer calls it when the in-view card changes). */
  publish(): void;
  /** The visitor opened an artwork: tell the host (the layer calls it). */
  openWork(id: string): void;
  /** Debug mode: a collider was edited; the host saves it (the layer calls it). */
  editWork(edit: unknown): Promise<unknown>;
  /** The host's save status for an edited collider. */
  editStatus(text: string): void;
  disconnect(): void;
}

export interface SplatWalkSetup {
  space: string;
  target: WalkTarget;
  diagnostics: () => Record<string, unknown>;
  /** Frees the viewer (render loop, models, GPU). Called once by disconnect(). */
  dispose: () => void;
  /** The walking interface; without one, Escape leaves the walk straight away. */
  layer?: WalkLayer;
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
export function snapshotOf(space: string, pose: NavPose, mode: NavMode, preview?: string | null): SplatWalkSnapshot {
  const [x, y, z] = pose.position;
  const snap: SplatWalkSnapshot = {
    kind: "splat-walk",
    v: 1,
    space,
    mode,
    pose: { position: [round(x, 3), round(y, 3), round(z, 3)], yaw: round(pose.yaw ?? 0, 2), pitch: round(pose.pitch ?? 0, 2) },
    panel: null,
  };
  if (preview) snap.preview = preview;
  return snap;
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
  const preview = typeof s.preview === "string" && s.preview ? s.preview.slice(0, 200) : null;
  return snapshotOf(space, { position: [p.position[0], p.position[1], p.position[2]], yaw: p.yaw, pitch: p.pitch }, mode, preview);
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
  const { space, target, layer } = setup;
  const keys = setup.keyTarget ?? window;
  const every = setup.setInterval ?? ((fn: () => void, ms: number) => window.setInterval(fn, ms));
  const stop = setup.clearInterval ?? ((id: unknown) => window.clearInterval(id as number));
  let host: ConnectOptions | null = null;
  let timer: unknown = null;
  let last = "";
  let disposed = false;
  let start: SplatWalkSnapshot | null = null;

  const state = () => snapshotOf(space, target.getPose(), target.getMode(), layer?.inView);
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
    layer?.setPreview(snap.preview ?? null);
  };
  const leave = () => {
    if (!host) return;
    // The same contract as the old walk: Back first (the artwork card), else leave the walk.
    if (host.onBack?.()) return;
    host.onExit?.();
  };
  const onKey = (e: Event) => {
    const k = e as KeyboardEvent;
    if (k.key !== "Escape" || !host || target.pointerLocked()) return;
    // Walking: Escape pauses first, as in the old walk. Paused: Escape leaves.
    if (layer?.escape()) return;
    leave();
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
      layer?.setWorks(options.works);
      if (saved) apply(saved);
      else target.respawn();
      start = saved;
      layer?.pause();
      if (options.guide) layer?.showGuide();
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
      // Back / Forward land paused, like the old walk; a click resumes.
      layer?.pause();
      last = JSON.stringify(state());
    },
    pause() {
      layer?.pause(true);
    },
    resume() {
      layer?.resume();
    },
    escape() {
      if (layer?.escape()) return true;
      return false;
    },
    reset() {
      if (start) apply(start);
      else target.respawn();
      publish();
    },
    publish() {
      publish();
    },
    openWork(id) {
      // Save where the visitor stood (with this card in view) before the host opens its card.
      publish();
      host?.onOpenWork?.(id);
    },
    async editWork(edit) {
      return host?.onEditWork ? await host.onEditWork(edit) : undefined;
    },
    editStatus(text) {
      if (typeof text === "string") layer?.setEditStatus?.(text.slice(0, 300));
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

export const CALL_MESSAGE = "splat-walk-call";
export const REPLY_MESSAGE = "splat-walk-reply";
export const EVENT_MESSAGE = "splat-walk-event";

/** Something to post to (the parent window; a fake in tests). */
export interface MessagePeer {
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * The walk API over postMessage, for a host on another origin (the plan's
 * hosting option where the splats live on their own domain). The host sends
 * `{type: "splat-walk-call", id, method, args}`; the walk answers
 * `{type: "splat-walk-reply", id, ok, value | error}` to that host's origin
 * only, and reports callbacks as `{type: "splat-walk-event", name, args}`:
 * change (snapshot, action), back (the host goes Back, else leaves), exit,
 * open-work (id), edit-work (edit; the host answers with an editStatus call). Calls from anything but `parent` are ignored.
 *
 * Returns a function that stops listening.
 */
export function serveOverMessages(
  api: SplatWalkApi,
  parent: MessagePeer,
  events: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  let hostOrigin: string | null = null;
  const emit = (name: string, ...args: unknown[]) => {
    if (hostOrigin) parent.postMessage({ type: EVENT_MESSAGE, name, args }, hostOrigin);
  };
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    async connect(options: unknown) {
      const o = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
      await api.connect({
        saved: o.saved,
        entry: o.entry,
        workId: typeof o.workId === "string" ? o.workId : null,
        works: o.works,
        guide: o.guide === true,
        onChange: (snapshot, action) => emit("change", snapshot, action),
        // Whether Back applies is the host's call; it decides on the "back" event.
        onBack: () => (emit("back"), true),
        onExit: () => emit("exit"),
        onOpenWork: (id) => emit("open-work", id),
        onEditWork: (edit) => void emit("edit-work", edit),
      });
    },
    restore: (saved: unknown) => api.restore(saved),
    state: () => api.state,
    diagnostics: () => api.diagnostics,
    pause: () => api.pause(),
    resume: () => api.resume(),
    escape: () => api.escape(),
    reset: () => api.reset(),
    editStatus: (text: unknown) => api.editStatus(String(text)),
    disconnect: () => api.disconnect(),
  };
  const onMessage = async (e: Event) => {
    const m = e as MessageEvent;
    if (m.source !== (parent as unknown) || !m.data || m.data.type !== CALL_MESSAGE) return;
    const { id, method, args } = m.data as { id: unknown; method: unknown; args: unknown };
    // The first caller's origin is the host; nothing else may drive this walk.
    if (hostOrigin === null) hostOrigin = m.origin;
    if (m.origin !== hostOrigin) return;
    const fn = typeof method === "string" && Object.hasOwn(methods, method) ? methods[method] : null;
    try {
      if (!fn) throw new Error(`Unknown method ${String(method)}`);
      const value = await fn(...(Array.isArray(args) ? args : []));
      parent.postMessage({ type: REPLY_MESSAGE, id, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }, hostOrigin);
    } catch (err) {
      parent.postMessage({ type: REPLY_MESSAGE, id, ok: false, error: err instanceof Error ? err.message : String(err) }, hostOrigin);
    }
  };
  events.addEventListener("message", onMessage);
  return () => events.removeEventListener("message", onMessage);
}
