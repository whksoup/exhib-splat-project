import { describe, expect, it } from "vitest";
import { createPreviewTracker, lookOffset, parseWorks, pickWork, previewCandidate, surfaceDistance, widgetScale, type WalkWork } from "./targeting";

const work = (id: string, center: [number, number, number], radius = 1): WalkWork => ({ id, title: id, anchor: center, center, radius });
const ahead = work("ahead", [0, 0, -10]);
const left = work("left", [-10, 0, -10]);

describe("artwork targeting", () => {
  it("measures the surface distance and how far the view misses an artwork", () => {
    expect(surfaceDistance([0, 0, 0], ahead)).toBeCloseTo(9);
    expect(lookOffset([0, 0, 0], [0, 0, -1], ahead)).toBe(0);
    expect(lookOffset([0, 0, 0], [0, 0, -1], left)).toBeCloseTo(Math.PI / 4 - Math.asin(1 / Math.hypot(10, 10)), 6);
  });

  it("picks only what the ray goes through, within range, nearest first", () => {
    const near = work("near", [0, 0, -4], 0.5);
    expect(pickWork([0, 0, 0], [0, 0, -1], [ahead, near, left], 20)).toBe("near");
    expect(pickWork([0, 0, 0], [0, 0, -1], [ahead], 5)).toBeNull();
    expect(pickWork([0, 0, 0], [1, 0, 0], [ahead, left], 50)).toBeNull();
  });

  it("previews the artwork nearest the centre of view within the angle and range", () => {
    const slightly = work("slightly", [1.6, 0, -10], 0.2); // about 8.5 degrees off, minus its size
    expect(previewCandidate([0, 0, 0], [0, 0, -1], [left, slightly], (8 * Math.PI) / 180, 20)).toBe("slightly");
    expect(previewCandidate([0, 0, 0], [0, 0, -1], [left], (8 * Math.PI) / 180, 20)).toBeNull();
    expect(previewCandidate([0, 0, 0], [0, 0, -1], [ahead], (8 * Math.PI) / 180, 5)).toBeNull();
  });

  it("holds the in-view card through short glances, like the old walk", () => {
    const t = createPreviewTracker();
    expect(t.update("a", 0)).toBeNull();
    expect(t.update("a", 260)).toBe("a");
    expect(t.update(null, 300)).toBe("a");
    expect(t.update(null, 700)).toBeNull();
    t.reset("b");
    expect(t.update(null, 0)).toBe("b");
  });

  it("shrinks markers away from the centre of view", () => {
    expect(widgetScale(0)).toBeCloseTo(1.12);
    expect(widgetScale(1)).toBeCloseTo(0.74);
  });

  it("drops malformed works from the host", () => {
    const works = parseWorks([ahead, { id: "x" }, { ...ahead, id: "nan", radius: Number.NaN }, null, { ...ahead, id: "no-title", title: 5 }]);
    expect(works.map((w) => w.id)).toEqual(["ahead", "no-title"]);
    expect(works[1].title).toBe("no-title");
    expect(parseWorks("nope")).toEqual([]);
  });
});
