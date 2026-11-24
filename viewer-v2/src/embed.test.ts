import { describe, expect, it, vi } from "vitest";
import { effectiveBudget } from "./config";
import {
  createSplatWalk,
  embeddedSpace,
  failureReason,
  hasWebGpu,
  isEmbedded,
  parseSnapshot,
  serveOverMessages,
  snapshotOf,
  type WalkLayer,
  type SplatWalkSnapshot,
  type WalkTarget,
} from "./embed";
import type { NavMode, NavPose } from "./nav/navConfig";

function fakeLayer() {
  const calls: string[] = [];
  let preview: string | null = null;
  let navigation: "paused" | "explore" = "paused";
  let works: unknown = null;
  const layer: WalkLayer = {
    setWorks: (w) => ((works = w), calls.push("works")),
    showGuide: () => calls.push("guide"),
    setPreview: (id) => ((preview = id), calls.push(`preview:${id}`)),
    pause: () => ((navigation = "paused"), calls.push("pause")),
    resume: () => ((navigation = "explore"), calls.push("resume")),
    escape: () => (navigation === "explore" ? ((navigation = "paused"), true) : false),
    get inView() {
      return preview;
    },
    get navigation() {
      return navigation;
    },
  };
  return { layer, calls, works: () => works, explore: () => (navigation = "explore"), look: (id: string | null) => (preview = id) };
}

function fakeWalk(layer?: WalkLayer) {
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
    layer,
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

describe("splatWalk with the exhibition layer", () => {
  it("hands over the works, starts paused, and shows the guide on a fresh entry", async () => {
    const l = fakeLayer();
    const w = fakeWalk(l.layer);
    await w.api.connect({ works: [{ id: "a" }], guide: true });
    expect(l.works()).toEqual([{ id: "a" }]);
    expect(l.calls).toEqual(["works", "pause", "guide"]);
  });

  it("restores the in-view card with the pose and reports it in the snapshot", async () => {
    const l = fakeLayer();
    const w = fakeWalk(l.layer);
    const changes: SplatWalkSnapshot[] = [];
    await w.api.connect({ saved: saved({ preview: "Mimus" } as Partial<SplatWalkSnapshot>), onChange: (s) => changes.push(s) });
    expect(l.layer.inView).toBe("Mimus");
    expect(w.api.state.preview).toBe("Mimus");
    l.look(null);
    w.api.publish();
    expect(changes.at(-1)?.preview).toBeUndefined();
  });

  it("pauses on the first Escape and leaves on the second", async () => {
    const l = fakeLayer();
    const w = fakeWalk(l.layer);
    const exit = vi.fn();
    await w.api.connect({ onExit: exit });
    l.explore();
    w.key("Escape");
    expect(exit).not.toHaveBeenCalled();
    expect(l.layer.navigation).toBe("paused");
    w.key("Escape");
    expect(exit).toHaveBeenCalledOnce();
  });

  it("publishes where the visitor stood, then asks the host to open the artwork", async () => {
    const l = fakeLayer();
    const w = fakeWalk(l.layer);
    const order: string[] = [];
    await w.api.connect({ onChange: (s) => order.push(`change:${s.preview ?? ""}`), onOpenWork: (id) => order.push(`open:${id}`) });
    order.length = 0;
    l.look("Mimus");
    w.api.openWork("Mimus");
    expect(order).toEqual(["change:Mimus", "open:Mimus"]);
  });

  it("resets to where the walk started", async () => {
    const w = fakeWalk(fakeLayer().layer);
    await w.api.connect({ saved: saved() });
    w.move({ position: [9, 1.6, 9] });
    w.api.reset();
    expect(w.api.state.pose.position).toEqual([3, 1.6, -4]);
  });
});

describe("postMessage bridge", () => {
  function bridge() {
    const l = fakeLayer();
    const w = fakeWalk(l.layer);
    const sent: { message: any; origin: string }[] = [];
    const parent = { postMessage: (message: unknown, origin: string) => sent.push({ message, origin }) };
    let listener: ((e: Event) => void) | null = null;
    const events = { addEventListener: (_: string, fn: (e: Event) => void) => (listener = fn), removeEventListener: () => (listener = null) } as never;
    const stop = serveOverMessages(w.api, parent, events);
    const call = async (method: string, args: unknown[] = [], origin = "https://host.example", source: unknown = parent) => {
      await (listener as unknown as (e: unknown) => Promise<void>)({ source, origin, data: { type: "splat-walk-call", id: sent.length + 1, method, args } });
    };
    return { l, w, sent, call, stop, listening: () => listener !== null };
  }

  it("answers calls from the parent and posts events to the host's origin only", async () => {
    const b = bridge();
    await b.call("connect", [{ saved: saved(), works: [] }]);
    expect(b.sent[0].message.name).toBe("change");
    expect(b.sent.at(-1)).toMatchObject({ origin: "https://host.example", message: { type: "splat-walk-reply", ok: true } });
    await b.call("state");
    expect(b.sent.at(-1)?.message.value.pose.position).toEqual([3, 1.6, -4]);
    b.w.api.openWork("Mimus");
    expect(b.sent.at(-1)?.message).toEqual({ type: "splat-walk-event", name: "open-work", args: ["Mimus"] });
  });

  it("turns Escape while paused into a back event for the host to decide", async () => {
    const b = bridge();
    await b.call("connect", [{}]);
    b.w.key("Escape");
    expect(b.sent.filter((s) => s.message.type === "splat-walk-event").map((s) => s.message.name)).toContain("back");
  });

  it("ignores other windows and other origins, and reports unknown methods", async () => {
    const b = bridge();
    await b.call("state", [], "https://host.example");
    const n = b.sent.length;
    await b.call("state", [], "https://evil.example");
    await b.call("state", [], "https://host.example", {});
    expect(b.sent.length).toBe(n);
    await b.call("toString");
    expect(b.sent.at(-1)?.message).toMatchObject({ ok: false });
    b.stop();
    expect(b.listening()).toBe(false);
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
