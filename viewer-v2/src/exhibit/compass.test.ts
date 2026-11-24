import { describe, expect, it } from "vitest";
import { bearingTo, compassItems, compassScale, compassTicks, COMPASS_TUNING } from "./compass";
import type { WalkWork } from "./targeting";

const work = (id: string, center: [number, number, number]): WalkWork => ({ id, title: id, anchor: center, center, radius: 0.5, box: { axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [0.5, 0.5, 0.5] } });
const north: [number, number, number] = [0, 0, -1];

describe("compass", () => {
  it("measures bearings to the right as positive", () => {
    expect(bearingTo([0, 0, 0], north, [0, 0, -5])).toBeCloseTo(0);
    expect(bearingTo([0, 0, 0], north, [5, 0, -5])).toBeCloseTo(45);
    expect(bearingTo([0, 0, 0], north, [-5, 0, 0])).toBeCloseTo(-90);
    expect(Math.abs(bearingTo([0, 0, 0], north, [0, 0, 5]))).toBeCloseTo(180);
    // Turning the view turns the bearing.
    expect(bearingTo([0, 0, 0], [1, 0, 0], [0, 0, -5])).toBeCloseTo(-90);
  });

  it("grows icons as the visitor gets closer", () => {
    expect(compassScale(1)).toBe(COMPASS_TUNING.maxScale);
    expect(compassScale(100)).toBe(COMPASS_TUNING.minScale);
    expect(compassScale(10)).toBeGreaterThan(compassScale(20));
  });

  it("pins artworks behind the visitor to the nearer edge and names the one ahead", () => {
    const items = compassItems([0, 0, 0], north, [work("ahead", [0, 0, -10.5]), work("behind-left", [-1, 0, 20]), work("far", [0, 0, -500])], 1);
    expect(items.map((i) => i.id).sort()).toEqual(["ahead", "behind-left"]);
    const ahead = items.find((i) => i.id === "ahead")!, behind = items.find((i) => i.id === "behind-left")!;
    expect(ahead).toMatchObject({ x: 0, pinned: false, centred: true });
    expect(ahead.distance).toBeCloseTo(10);
    expect(behind).toMatchObject({ x: -1, pinned: true, centred: false });
    // Metres per unit scales the distance.
    expect(compassItems([0, 0, 0], north, [work("ahead", [0, 0, -10.5])], 7.375)[0].distance).toBeCloseTo(73.75);
  });

  it("draws ticks every 15 degrees, major every 45", () => {
    const ticks = compassTicks(north);
    expect(ticks.length).toBe(11);
    expect(ticks.filter((t) => t.major).map((t) => Math.round(t.x * 75))).toEqual([-45, 0, 45]);
  });
});
