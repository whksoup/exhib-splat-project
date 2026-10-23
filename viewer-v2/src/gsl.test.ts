import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { screenCoverage, shareBudget, shareBudgetByDemand } from "./gsl";

describe("shareBudget", () => {
  it("splits evenly when nothing has a weight yet", () => {
    expect(shareBudget(4_000_000, [0, 0, 0, 0].map((weight) => ({ weight, visible: true })))).toEqual([1e6, 1e6, 1e6, 1e6]);
  });

  it("gives each visible part at least the floor share and the rest by weight", () => {
    const [a, b, c] = shareBudget(1_000_000, [
      { weight: 1, visible: true },
      { weight: 0, visible: true },
      { weight: 1, visible: true },
    ]);
    expect(b).toBe(50_000); // 5% floor
    expect(a).toBe(c);
    expect(a + b + c).toBe(1_000_000);
  });

  it("gives hidden parts nothing (1 splat: GSL budgets must be positive)", () => {
    expect(shareBudget(1000, [{ weight: 1, visible: false }, { weight: 0, visible: true }])).toEqual([1, 1000]);
    expect(shareBudget(1000, [{ weight: 1, visible: false }])).toEqual([1]);
  });

  it("caps the floor so many parts never get more than the total", () => {
    const parts = Array.from({ length: 40 }, () => ({ weight: 0, visible: true }));
    expect(shareBudget(4000, parts).reduce((s, n) => s + n, 0)).toBe(4000);
  });
});

describe("shareBudgetByDemand", () => {
  const part = (budget: number, used: number, weight = 1) => ({ weight, visible: true, budget, used });

  it("gives what a part leaves unused to the budget-limited parts", () => {
    // HighRezOculus at 5M: one part stops at 160k of its 1.25M, three are capped.
    const b = shareBudgetByDemand(5_000_000, [part(1.25e6, 160_000), part(1.25e6, 1.25e6), part(1.25e6, 1.25e6), part(1.25e6, 1.24e6)]);
    expect(b[0]).toBe(250_000); // max(5% floor, 160k * 1.25)
    expect(b[1]).toBe(b[2]);
    expect(b[1]).toBeGreaterThan(1.5e6);
    expect(b.reduce((s, n) => s + n, 0)).toBeCloseTo(5_000_000, -1);
  });

  it("falls back to the plain split when no part is budget-limited", () => {
    const parts = [part(2.5e6, 100), part(2.5e6, 100)];
    expect(shareBudgetByDemand(5e6, parts)).toEqual(shareBudget(5e6, parts));
  });

  it("falls back when the unlimited parts already want the whole total", () => {
    const parts = [part(1e6, 950_000), part(5e6, 4e6)]; // the second wants 4M * 1.25 = 5M
    expect(shareBudgetByDemand(5e6, parts)).toEqual(shareBudget(5e6, parts));
  });

  it("keeps hidden parts at 1", () => {
    expect(shareBudgetByDemand(1000, [{ ...part(500, 500), visible: false }, part(500, 500)])).toEqual([1, 1000]);
  });
});

describe("screenCoverage", () => {
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();

  it("is 1 inside the box and 0 for an empty box", () => {
    expect(screenCoverage(new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)), camera)).toBe(1);
    expect(screenCoverage(new THREE.Box3(), camera)).toBe(0);
  });

  it("is 0 off-screen and a fraction for a small box ahead", () => {
    expect(screenCoverage(new THREE.Box3(new THREE.Vector3(50, -1, -11), new THREE.Vector3(52, 1, -10)), camera)).toBe(0);
    // 2x2 at depth 10 with a 90° fov (±10 visible): about a tenth of the width and height.
    const c = screenCoverage(new THREE.Box3(new THREE.Vector3(-1, -1, -10.001), new THREE.Vector3(1, 1, -10)), camera);
    expect(c).toBeCloseTo(0.01, 3);
  });

  it("is 1 for a box that straddles the camera plane", () => {
    expect(screenCoverage(new THREE.Box3(new THREE.Vector3(5, -1, -5), new THREE.Vector3(6, 1, 5)), camera)).toBe(1);
  });
});
