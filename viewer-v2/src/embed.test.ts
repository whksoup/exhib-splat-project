import { describe, expect, it, vi } from "vitest";
import { effectiveBudget } from "./config";
import {
  createSplatWalk,
  embeddedSpace,
  failureReason,
  hasWebGpu,
  isEmbedded,
  parseSnapshot,
  snapshotOf,
  type SplatWalkSnapshot,
  type WalkTarget,
} from "./embed";
import type { NavMode, NavPose } from "./nav/navConfig";

function fakeWalk() {
  let pose: NavPose = { position: [0, 1.6, 0], yaw: 0, pitch: 0 };
  let mode: NavMode = "walk";
  let locked = false;
  const spawn: NavPose = { position: [1, 1.6, 2], yaw: 90, pitch: 0 };
  const target: WalkTarget = {
    getPose: () => ({ ...pose, position: [...pose.position] as [number, number, number] }),
    teleport: (p) => (pose = { yaw: 0, pitch: 0, ...p }),
    respawn: () => (pose = { ...spawn }),
    getMode: () => mode,
    setMode: (m) => (mode = m),
    pointerLocked: () => locked,
  };
  const listeners = new Map<string, (e: Event) => void>();
  const keyTarget = {
    addEventListener: (type: string, fn: (e: Event) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
  let tick: (() => void) | null = null;
  const dispose = vi.fn();
  const api = createSplatWalk({
    space: "lobby",
    target,
    diagnostics: () => ({ renderer: "gsl" }),
    dispose,
    keyTarget,
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval: () => (tick = null),
  });
  return {
    api,
    dispose,
    move: (p: NavPose) => (pose = { yaw: 0, pitch: 0, ...p }),
    lock: (v: boolean) => (locked = v),
    key: (key: string) => listeners.get("keydown")?.({ key } as KeyboardEvent),
    listening: () => listeners.has("keydown"),
    tick: () => tick?.(),
    ticking: () => tick !== null,
  };
}

const saved = (over: Partial<SplatWalkSnapshot> = {}): SplatWalkSnapshot => ({
  kind: "splat-walk",
  v: 1,
  space: "lobby",
  mode: "walk",
  pose: { position: [3, 1.6, -4], yaw: 45, pitch: -5 },
  panel: null,
  ...over,
});

describe("embedded query", () => {
  it("reads ?embedded= and the space, defaulting to the model name", () => {
    expect(isEmbedded("?embedded=1")).toBe(true);
    expect(isEmbedded("?embedded=0")).toBe(false);
    expect(isEmbedded("")).toBe(false);
    expect(embeddedSpace("?embedded=1&space=b2&config=models/Oculus-20M/viewer.json")).toBe("b2");
    expect(embeddedSpace("?config=models/Lobby-10M/viewer.json")).toBe("Lobby-10M");
  });
});

describe("snapshots", () => {
  it("round to millimetres and hundredths of a degree", () => {
    const s = snapshotOf("lobby", { position: [1.23456, 1.6, -0.0004], yaw: 12.3456, pitch: 0 }, "walk");
    expect(s.pose).toEqual({ position: [1.235, 1.6, -0], yaw: 12.35, pitch: 0 });
    expect(s.panel).toBeNull();
  });

  it("accept only a well-formed snapshot of the same space", () => {
    expect(parseSnapshot(saved(), "lobby")?.pose.position).toEqual([3, 1.6, -4]);
    expect(parseSnapshot(saved(), "b2")).toBeNull();
    // The old primitive walk's state (kept in history before this renderer existed).
    expect(parseSnapshot({ space: "oculus", mode: "walk", pose: { position: [0, 0, 0], yaw: 0 } }, "lobby")).toBeNull();
    expect(parseSnapshot(saved({ pose: { position: [0, Number.NaN, 0], yaw: 0, pitch: 0 } }), "lobby")).toBeNull();
    expect(parseSnapshot(null, "lobby")).toBeNull();
  });
});

describe("failure reasons", () => {
  it("names a missing WebGPU separately from other renderer errors", () => {
    expect(failureReason(new Error("Unable to create WebGPU adapter."))).toBe("no-webgpu");
    expect(failureReason(new Error("WebGL2 context lost"))).toBe("renderer");
  });

  it("checks for a WebGPU adapter", async () => {
    expect(await hasWebGpu({})).toBe(false);
    expect(await hasWebGpu({ gpu: { requestAdapter: async () => null } })).toBe(false);
    expect(await hasWebGpu({ gpu: { requestAdapter: async () => ({}) } })).toBe(true);
    expect(await hasWebGpu({ gpu: { requestAdapter: async () => Promise.reject(new Error("blocked")) } })).toBe(false);
  });
});

describe("splatWalk API", () => {
  it("spawns without a saved state and reports changes once per move", async () => {
    const w = fakeWalk();
    const onChange = vi.fn();
    await w.api.connect({ onChange });
    expect(w.api.state.pose.position).toEqual([1, 1.6, 2]);
    expect(onChange).toHaveBeenCalledTimes(1);
    w.tick();
    expect(onChange).toHaveBeenCalledTimes(1); // standing still: nothing new
    w.move({ position: [2, 1.6, 2], yaw: 90, pitch: 0 });
    w.tick();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1]).toEqual([expect.objectContaining({ space: "lobby", pose: { position: [2, 1.6, 2], yaw: 90, pitch: 0 } }), "replace"]);
  });

  it("restores a saved snapshot on connect and on restore()", async () => {
    const w = fakeWalk();
    await w.api.connect({ saved: saved(), onChange: () => {} });
    expect(w.api.state).toEqual(saved());
    await w.api.restore(saved({ pose: { position: [5, 1.6, 5], yaw: 180, pitch: 0 } }));
    expect(w.api.state.pose.position).toEqual([5, 1.6, 5]);
  });

  it("ignores a restore after its navigation was cancelled", async () => {
    const w = fakeWalk();
    await w.api.connect({ saved: saved() });
    const ac = new AbortController();
    ac.abort();
    await w.api.restore(saved({ pose: { position: [9, 1.6, 9], yaw: 0, pitch: 0 } }), { signal: ac.signal });
    expect(w.api.state.pose.position).toEqual([3, 1.6, -4]);
  });

  it("leaves on Escape unless the pointer is locked or the host handled Back", async () => {
    const w = fakeWalk();
    const onExit = vi.fn();
    let backHandled = true;
    await w.api.connect({ onExit, onBack: () => backHandled });
    w.key("Escape");
    expect(onExit).not.toHaveBeenCalled();
    backHandled = false;
    w.lock(true);
    w.key("Escape");
    expect(onExit).not.toHaveBeenCalled();
    w.lock(false);
    w.key("a");
    w.key("Escape");
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("frees the viewer once on disconnect and refuses to reconnect", async () => {
    const w = fakeWalk();
    await w.api.connect({});
    w.api.disconnect();
    w.api.disconnect();
    expect(w.dispose).toHaveBeenCalledTimes(1);
    expect(w.ticking()).toBe(false);
    expect(w.listening()).toBe(false);
    expect(w.api.diagnostics).toMatchObject({ disposed: true, connected: false, renderer: "gsl" });
    await expect(w.api.connect({})).rejects.toThrow(/closed/);
  });
});

describe("effectiveBudget", () => {
  const desktop = { mobile: false, profile: { id: "desktop" as const } };
  const phone = { mobile: true, profile: { id: "iphone" as const } };
  it("keeps the full budget on desktop and caps phones and tablets", () => {
    expect(effectiveBudget({ budget: 19_400_000, mobileBudget: 3_000_000 }, desktop)).toBe(19_400_000);
    expect(effectiveBudget({ budget: 19_400_000, mobileBudget: 3_000_000 }, phone)).toBe(3_000_000);
    expect(effectiveBudget({ budget: 2_000_000, mobileBudget: 3_000_000 }, phone)).toBe(2_000_000);
    expect(effectiveBudget({ mobileBudget: 3_000_000 }, phone)).toBe(3_000_000);
    expect(effectiveBudget({ budget: 5e6 }, phone)).toBe(5e6);
  });
});
