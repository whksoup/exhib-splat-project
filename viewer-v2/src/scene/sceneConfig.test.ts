import { describe, expect, it } from "vitest";
import { createScene } from "../../../shared/scene-schema.mjs";
import { sceneCamera, sceneModel, sceneNavigation } from "./sceneConfig";

const base = () => createScene({ name: "demo_1", source: "assets/source_ply/My Scan.ply", now: "2026-01-01T00:00:00.000Z" });

describe("sceneModel", () => {
  it("previews the source unpaged when unbuilt", () => {
    const s = base();
    expect(sceneModel(s, false)).toEqual({ mode: "source", model: { url: "/__scene-source/demo_1/My%20Scan.ply", paged: false } });
  });

  it("streams the built .rad paged, cache-busted by the build time", () => {
    const s = { ...base(), build: { status: "ok", radFile: "demo_1-lod.rad", finishedAt: "2026-02-03T04:05:06.000Z", transformMatrix: base().transform.matrix } } as never;
    const m = sceneModel(s, true);
    expect(m.mode).toBe("built");
    expect(m.model.paged).toBe(true);
    expect(m.model.url).toBe("/scenes/demo_1/build/demo_1-lod.rad?v=2026-02-03T04%3A05%3A06.000Z");
    // A build recorded in scene.json but missing on disk falls back to the source.
    expect(sceneModel(s, false).mode).toBe("source");
  });
});

describe("sceneNavigation", () => {
  it("maps collision to a scene URL and floorY to the fallback floor", () => {
    const s = { ...base(), floorY: -0.25, navigation: { collision: "nav/collision v2.glb", allowJump: true, spawn: { position: [1, 2, 3] as [number, number, number], yaw: 90 } } };
    expect(sceneNavigation(s)).toEqual({
      collision: "/scenes/demo_1/nav/collision%20v2.glb",
      allowJump: true,
      spawn: { position: [1, 2, 3], yaw: 90 },
      fallbackFloorY: -0.25,
    });
  });

  it("leaves the defaults alone when nothing is set", () => {
    expect(sceneNavigation(base())).toEqual({});
  });
});

describe("sceneCamera", () => {
  it("copies the start camera", () => {
    expect(sceneCamera(base())).toBeUndefined();
    expect(sceneCamera({ ...base(), camera: { position: [0, 1.6, 4], target: [0, 1, 0], fov: 50 } })).toEqual({ position: [0, 1.6, 4], target: [0, 1, 0], fov: 50 });
  });
});
