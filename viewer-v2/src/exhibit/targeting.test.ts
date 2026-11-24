import { describe, expect, it } from "vitest";
import { closestPoint, createPreviewTracker, lookOffset, parseWorks, pickWork, previewCandidate, surfaceDistance, widgetScale, type WalkWork } from "./targeting";

const work = (id: string, center: [number, number, number], radius = 1): WalkWork => ({ id, title: id, anchor: center, center, radius });
const ahead = work("ahead", [0, 0, -10]);
const left = work("left", [-10, 0, -10]);

const s45 = Math.SQRT1_2;
// A 4 x 2 x 1 box at z = -10 turned 45 degrees about Y, and a 4 x 2 wall plane facing +Z at z = -10.
const turned: WalkWork = { id: "turned", title: "turned", anchor: [0, 0, -10], center: [0, 0, -10], radius: 3, box: { axes: [[s45, 0, -s45], [0, 1, 0], [s45, 0, s45]], half: [2, 1, 0.5] } };
const plane: WalkWork = { id: "plane", title: "plane", anchor: [0, 0, -10], center: [0, 0, -10], radius: 3, box: { axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [2, 1, 0] }, mount: "wall" };

describe("artwork boxes and wall planes", () => {
  it("measures the distance to the box surface, not a sphere", () => {
    expect(surfaceDistance([0, 0, 0], plane)).toBeCloseTo(10);
    expect(surfaceDistance([3, 0, -10], plane)).toBeCloseTo(1);
    expect(closestPoint(plane, [0, 0, -5])).toEqual([0, 0, -10]);
    expect(surfaceDistance([0, 0, -10], turned)).toBe(0);
  });

  it("picks a wall plane only within its rectangle", () => {
    expect(pickWork([0, 0, 0], [0, 0, -1], [plane], 20)).toBe("plane");
    const off = (x: number) => { const l = Math.hypot(x, 10); return [x / l, 0, -10 / l] as [number, number, number]; };
    expect(pickWork([0, 0, 0], off(1.9), [plane], 20)).toBe("plane");
    expect(pickWork([0, 0, 0], off(2.2), [plane], 20)).toBeNull();
    expect(lookOffset([0, 0, 0], off(2.2), plane)).toBeGreaterThan(0);
    expect(lookOffset([0, 0, 0], off(2.2), plane)).toBeLessThan(0.05);
  });

  it("follows the box's turn", () => {
    // Along the box's long axis it reaches 2 m; along the world X axis at its centre only about 0.7 m.
    expect(surfaceDistance([s45 * 2.5, 0, -10 - s45 * 2.5], turned)).toBeCloseTo(0.5, 5);
    expect(surfaceDistance([1.5, 0, -10], turned)).toBeGreaterThan(0.5);
  });

  it("reads boxes from the host and keeps the sphere when there is none", () => {
    const [a, b] = parseWorks([plane, { ...turned, box: { axes: [[1, 0, 0]], half: [1, 1, 1] } }]);
    expect(a.box?.half).toEqual([2, 1, 0]);
    expect(a.mount).toBe("wall");
    expect(b.box).toBeUndefined();
  });
});

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
