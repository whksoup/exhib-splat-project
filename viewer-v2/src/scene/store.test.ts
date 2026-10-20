import { describe, expect, it } from "vitest";
import { createScene, type SceneDoc } from "../../../shared/scene-schema.mjs";
import { editableFingerprint, SceneStore } from "./store";

const doc = (): SceneDoc => createScene({ name: "s1", source: "assets/source_ply/a.ply", now: "2026-01-01T00:00:00.000Z" });

describe("SceneStore", () => {
  it("tracks dirty state against the last saved document", () => {
    const store = new SceneStore(doc());
    const seen: string[] = [];
    store.on((_, c) => seen.push(c));
    expect(store.dirty).toBe(false);
    store.update((d) => (d.floorY = 0.5), "floor");
    expect(store.dirty).toBe(true);
    store.update((d) => (d.floorY = null), "floor");
    expect(store.dirty).toBe(false); // back to the saved value
    expect(seen).toEqual(["floor", "floor"]);
  });

  it("does not count server-owned fields as edits", () => {
    const store = new SceneStore(doc());
    const built = { ...doc(), build: { status: "ok" } as never, updatedAt: "2027-01-01T00:00:00.000Z" };
    store.adoptServerBuild(built);
    expect(store.dirty).toBe(false);
    expect(store.doc.build).toEqual({ status: "ok" });
  });

  it("keeps unsaved edits when a build result arrives", () => {
    const store = new SceneStore(doc());
    store.update((d) => (d.camera = { position: [0, 1, 2], target: [0, 0, 0] }), "camera");
    store.adoptServerBuild({ ...doc(), build: { status: "ok" } as never });
    expect(store.dirty).toBe(true);
    expect(store.doc.camera?.position).toEqual([0, 1, 2]);
  });

  it("markSaved clears dirty, and keeps edits made while saving", () => {
    const store = new SceneStore(doc());
    store.update((d) => (d.floorY = 1), "floor");
    const sent = JSON.parse(JSON.stringify(store.doc)) as SceneDoc;
    store.update((d) => (d.floorY = 2), "floor"); // edited during the request
    store.markSaved({ ...sent, updatedAt: "2027-01-01T00:00:00.000Z" });
    expect(store.dirty).toBe(true);
    expect(store.doc.floorY).toBe(2);
    store.markSaved({ ...store.doc, updatedAt: "2027-01-02T00:00:00.000Z" } as SceneDoc);
    expect(store.dirty).toBe(false);
  });

  it("fingerprint ignores key order", () => {
    const a = doc();
    const b = Object.fromEntries(Object.entries(a).reverse()) as unknown as SceneDoc;
    expect(editableFingerprint(a)).toBe(editableFingerprint(b));
  });

  it("adding, disabling and removing parts are unsaved edits", () => {
    const store = new SceneStore(createScene({ name: "m", sources: ["a/p0.ply", "a/p1.ply"], now: "2026-01-01T00:00:00.000Z" }));
    store.update((d) => (d.parts[1].enabled = false), "parts");
    expect(store.dirty).toBe(true);
    store.update((d) => (d.parts[1].enabled = true), "parts");
    expect(store.dirty).toBe(false);
    store.update((d) => d.parts.push({ id: "p2", source: "a/p2.ply", enabled: true }), "parts");
    expect(store.dirty).toBe(true);
    store.update((d) => (d.parts = d.parts.filter((p) => p.id !== "p2")), "parts");
    expect(store.dirty).toBe(false);
  });

  it("update never mutates the previous document object", () => {
    const store = new SceneStore(doc());
    const before = store.doc;
    store.update((d) => (d.navigation.allowJump = true), "navigation");
    expect(before.navigation.allowJump).toBeUndefined();
  });
});
