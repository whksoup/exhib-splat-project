import { describe, expect, it } from "vitest";
import { createScene, IDENTITY, type SceneDoc } from "../../../shared/scene-schema.mjs";
import { previewCapBytes, sceneCamera, sceneModels, sceneNavigation, type PartFileInfo } from "./sceneConfig";

const base = () => createScene({ name: "demo_1", source: "assets/source_ply/My Scan.ply", now: "2026-01-01T00:00:00.000Z" });
const GB = 1e9;

const info = (scene: SceneDoc, bytes: number, built: string[] = []): PartFileInfo[] =>
  scene.parts.map((p) => ({ id: p.id, source: p.source, exists: true, bytes, splats: null, builtOnDisk: built.includes(p.id) }));

function withBuild(scene: SceneDoc, ids: string[], finishedAt = "2026-02-03T04:05:06.000Z"): SceneDoc {
  return {
    ...scene,
    build: {
      status: "ok",
      transformMatrix: [...scene.transform.matrix],
      finishedAt,
      buildLodFlags: [],
      parts: ids.map((id) => ({ id, status: "ok", radFile: `${id}/demo_1-${id}-lod.rad`, transformMatrix: [...scene.transform.matrix], source: scene.parts.find((p) => p.id === id)!.source, buildLodFlags: [], finishedAt })),
    },
  } as SceneDoc;
}

describe("sceneModels", () => {
  it("previews the source unpaged when unbuilt", () => {
    const s = base();
    const r = sceneModels(s, info(s, 1000));
    expect(r.mode).toBe("source");
    expect(r.models).toEqual([{ id: "My_Scan", url: "/__scene-source/demo_1/My_Scan/My%20Scan.ply", paged: false, matrix: [...IDENTITY] }]);
  });

  it("streams each built part paged, cache-busted by the build time", () => {
    const s = withBuild(createScene({ name: "demo_1", sources: ["a/p0.ply", "a/p1.ply"] }), ["p0", "p1"]);
    const r = sceneModels(s, info(s, 1000, ["p0", "p1"]));
    expect(r.mode).toBe("built");
    expect(r.models.map((m) => m.url)).toEqual([
      "/scenes/demo_1/build/p0/demo_1-p0-lod.rad?v=2026-02-03T04%3A05%3A06.000Z",
      "/scenes/demo_1/build/p1/demo_1-p1-lod.rad?v=2026-02-03T04%3A05%3A06.000Z",
    ]);
    expect(r.models.every((m) => m.paged)).toBe(true);
    // A build recorded in scene.json but missing on disk falls back to the source.
    const half = sceneModels(s, info(s, 1000, ["p0"]));
    expect(half.mode).toBe("mixed");
    expect(half.models[1].paged).toBe(false);
  });

  it("does not auto-load unbuilt sources over the cap, and loads opted-in parts that fit", () => {
    const s = createScene({ name: "big", sources: ["a/p0.ply", "a/p1.ply"] });
    const over = sceneModels(s, info(s, 1 * GB));
    expect(over.mode).toBe("none");
    expect(over.models).toEqual([]);
    expect(over.plan.overCap).toBe(true);
    const one = sceneModels(s, info(s, 1 * GB), { previewParts: ["p1"] });
    expect(one.models.map((m) => m.id)).toEqual(["p1"]);
    expect(sceneModels(s, info(s, 1 * GB), { capBytes: 3 * GB }).models).toHaveLength(2);
    // Single-source scenes too (the 4.9 GB merged file).
    const merged = base();
    expect(sceneModels(merged, info(merged, 4.9 * GB)).models).toEqual([]);
  });

  it("disabled parts are not loaded", () => {
    const s = createScene({ name: "d", sources: ["a/p0.ply", "a/p1.ply"] });
    s.parts[1].enabled = false;
    expect(sceneModels(s, info(s, 10)).models.map((m) => m.id)).toEqual(["p0"]);
  });

  it("reads the preview cap from the URL", () => {
    expect(previewCapBytes("?previewCapGB=4")).toBe(4 * GB);
    expect(previewCapBytes("?scene=x")).toBe(1.5 * GB);
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
