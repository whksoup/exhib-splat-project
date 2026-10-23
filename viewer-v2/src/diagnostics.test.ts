import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { orbitPosition } from "./bench";
import { dist, HitchLog, SampleRing } from "./diagnostics";

describe("SampleRing", () => {
  it("returns values since a time, oldest first, and keeps only the last `capacity`", () => {
    const r = new SampleRing(3);
    expect(r.latest()).toBeNull();
    for (let i = 1; i <= 5; i++) r.push(i * 100, i);
    expect(r.since(0)).toEqual([3, 4, 5]);
    expect(r.since(400)).toEqual([4, 5]);
    expect(r.latest()).toBe(5);
  });
});

describe("dist", () => {
  it("summarises median, p95 and max", () => {
    expect(dist([])).toBeNull();
    const d = dist(Array.from({ length: 100 }, (_, i) => 100 - i));
    expect(d).toEqual({ n: 100, median: 51, p95: 96, max: 100 });
  });
});

describe("HitchLog", () => {
  const warm = (log: HitchLog, dt: number, n = 60) => {
    for (let i = 0; i < n; i++) expect(log.check(dt)).toBeNull();
  };

  it("at 60 Hz flags two dropped frames but not one", () => {
    const log = new HitchLog();
    warm(log, 16.7);
    expect(log.check(33.4)).toBeNull();
    warm(log, 16.7, 200);
    expect(log.check(50)).toBeCloseTo(16.7, 0);
  });

  it("needs 20 ms over typical on fast displays", () => {
    const log = new HitchLog();
    warm(log, 6.9);
    expect(log.check(20)).toBeNull();
    warm(log, 6.9, 200);
    expect(log.check(30)).not.toBeNull();
  });

  it("does not raise the baseline on hitches and ignores tab-switch gaps", () => {
    const log = new HitchLog();
    warm(log, 16.7);
    for (let i = 0; i < 20; i++) expect(log.check(80)).not.toBeNull();
    expect(log.check(5000)).toBeNull();
    expect(log.check(80)).toBeCloseTo(16.7, 0);
  });

  it("keeps the last MAX entries and the running total", () => {
    const log = new HitchLog();
    const h = { atMs: 0, frameMs: 50, typicalMs: 16.7, activeSplats: 0, cameraMoving: false, sorting: false, lodUpdating: false, fetching: false, uploadMs: 0, pagesUploaded: 0, gpuMs: null };
    for (let i = 0; i < HitchLog.MAX + 5; i++) log.add({ ...h, atMs: i });
    expect(log.total).toBe(HitchLog.MAX + 5);
    expect(log.entries.length).toBe(HitchLog.MAX);
    expect(log.entries[0].atMs).toBe(5);
    expect(HitchLog.tags({ ...h, pagesUploaded: 3, uploadMs: 12.4, fetching: true })).toBe("upload 3p 12ms, fetching");
    expect(HitchLog.tags(h)).toBe("idle");
  });
});

describe("orbitPosition", () => {
  it("starts at the start angle, keeps radius and height, and returns after a full turn", () => {
    const target = new THREE.Vector3(1, 2, 3);
    const start = orbitPosition(target, 5, 1.5, Math.PI / 2, 1, 0);
    expect(start.x).toBeCloseTo(1);
    expect(start.y).toBeCloseTo(3.5);
    expect(start.z).toBeCloseTo(8);
    const half = orbitPosition(target, 5, 1.5, Math.PI / 2, 1, 0.5);
    expect(half.z).toBeCloseTo(-2);
    expect(Math.hypot(half.x - 1, half.z - 3)).toBeCloseTo(5);
    const end = orbitPosition(target, 5, 1.5, Math.PI / 2, 1, 1);
    expect(end.distanceTo(start)).toBeCloseTo(0);
  });
});
