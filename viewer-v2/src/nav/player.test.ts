import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { classifyObject, CollisionWorld, kindFromName } from "./colliders";
import { NAV_DEFAULTS, resolveNavigationConfig, type NavigationConfig, type NavPose } from "./navConfig";
import { emptyInput, PlayerController, type NavInput } from "./player";
import { buildNavTestRoom } from "./testRoom";

const world = CollisionWorld.fromObject(buildNavTestRoom());

function player(over: Partial<NavigationConfig> = {}, spawn: NavPose = { position: [0, 1.6, 0], yaw: 0 }) {
  return new PlayerController(world, { ...NAV_DEFAULTS, ...over }, spawn);
}

/** Run `seconds` of simulation at 60 fps with a fixed input. */
function run(p: PlayerController, seconds: number, input: Partial<NavInput>, fps = 60): void {
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) p.step(1 / fps, { ...emptyInput(), ...input });
}

/** Yaw (deg) that faces from (x0,z0) towards (x1,z1). 0 = -Z, positive = left. */
function yawTowards(x0: number, z0: number, x1: number, z1: number): number {
  return THREE.MathUtils.radToDeg(Math.atan2(-(x1 - x0), -(z1 - z0)));
}

describe("collider naming", () => {
  it("classifies by case-insensitive prefix, else solid", () => {
    expect(kindFromName("Floor_Main")).toBe("floor");
    expect(kindFromName("WALL.001")).toBe("wall");
    expect(kindFromName("ceilingA")).toBe("ceiling");
    expect(kindFromName("bound_glass")).toBe("bound");
    expect(kindFromName("NoFly_1")).toBe("nofly");
    expect(kindFromName("pillar")).toBeNull();
    const parent = new THREE.Group();
    parent.name = "walls";
    const child = new THREE.Mesh();
    child.name = "Surface 12";
    parent.add(child);
    expect(classifyObject(child)).toBe("wall");
    expect(classifyObject(new THREE.Mesh())).toBe("solid");
  });

  it("ignores lines and points", () => {
    const g = new THREE.Group();
    const geom = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    g.add(new THREE.Line(geom), new THREE.Points(geom), new THREE.LineSegments(geom));
    expect(CollisionWorld.fromObject(g).triangleCount).toBe(0);
  });

  it("builds the test room groups", () => {
    for (const k of ["floor", "wall", "ceiling", "bound", "nofly", "solid"] as const) expect(world.counts[k]).toBeGreaterThan(0);
  });
});

describe("walk", () => {
  it("spawns standing on the floor", () => {
    const p = player();
    expect(p.feet.y).toBeCloseTo(0, 5);
    expect(p.grounded).toBe(true);
    expect(p.getEyePosition().y).toBeCloseTo(1.6, 5);
  });

  it("does not walk through a wall, even running fast with frame hitches", () => {
    const p = player({ runSpeed: 40 }, { position: [0, 1.6, 0], yaw: -90 }); // facing +X (east wall at x=6)
    run(p, 3, { moveY: 1, run: true }, 10);
    expect(p.feet.x).toBeLessThanOrEqual(6 - 0.3 + 1e-3);
    expect(p.feet.x).toBeGreaterThan(5.5);
  });

  it("slides along a wall when walking into it at an angle", () => {
    const p = player({}, { position: [0, 1.6, -4], yaw: 0 });
    p.yaw = yawTowards(0, 0, 1, -1); // 45 deg into the north wall (z=-5), heading +X
    run(p, 2, { moveY: 1 });
    expect(p.feet.z).toBeGreaterThanOrEqual(-5 + 0.3 - 1e-3);
    expect(p.feet.x).toBeGreaterThan(1.5); // kept moving along the wall
  });

  it("climbs a 0.2 m step but not a 0.5 m block", () => {
    const a = player({}, { position: [-2.5, 1.6, 0], yaw: 0 });
    run(a, 1.2, { moveY: 1 }); // ends on top of the 1 m deep step
    expect(a.feet.y).toBeCloseTo(0.2, 3);
    const b = player({}, { position: [2.5, 1.6, 0], yaw: 0 });
    run(b, 2, { moveY: 1 });
    expect(b.feet.y).toBeCloseTo(0, 3);
    expect(b.feet.z).toBeGreaterThan(-1.5); // stopped in front of the block
  });

  it("walks up the stairs onto the landing", () => {
    const p = player({}, { position: [-5.2, 1.6, -1], yaw: 180 });
    run(p, 3, { moveY: 1 });
    expect(p.feet.y).toBeCloseTo(0.51, 3);
    expect(p.feet.z).toBeGreaterThan(1.5);
  });

  it("walks up a 15 deg ramp but not a 55 deg one", () => {
    const a = player({}, { position: [4.6, 1.6, -0.5], yaw: 180 });
    run(a, 3, { moveY: 1 });
    expect(a.feet.y).toBeCloseTo(0.6, 2);
    const b = player({}, { position: [2.9, 1.6, 1.5], yaw: 180 });
    run(b, 3, { moveY: 1 });
    expect(b.feet.y).toBeLessThan(0.36);
  });

  it("is stopped by a bound barrier", () => {
    const p = player({}, { position: [-0.5, 1.6, 1], yaw: 180 });
    run(p, 3, { moveY: 1 });
    expect(p.feet.z).toBeLessThan(2.5 - 0.29);
  });

  it("does not jump unless allowed", () => {
    const p = player();
    p.step(1 / 60, { ...emptyInput(), jump: true });
    run(p, 0.2, {});
    expect(p.feet.y).toBeCloseTo(0, 5);
    const q = player({ allowJump: true });
    q.step(1 / 60, { ...emptyInput(), jump: true });
    run(q, 0.2, {});
    expect(q.feet.y).toBeGreaterThan(0.3);
    run(q, 2, {});
    expect(q.feet.y).toBeCloseTo(0, 3);
  });

  it("respawns after falling below killY", () => {
    const p = new PlayerController(CollisionWorld.flatFloor(0, 5), { ...NAV_DEFAULTS, killY: -5 }, { position: [0, 1.6, 0] });
    p.teleport({ position: [20, 1.6, 20] }); // off the edge of the small floor
    run(p, 3, {});
    expect(p.respawnCount).toBe(1);
    expect(p.feet.y).toBeCloseTo(0, 5);
  });

  it("refuses fly mode unless allowed", () => {
    const p = player();
    expect(p.setMode("fly")).toBe("walk");
    run(p, 1, { moveUp: 1 });
    expect(p.feet.y).toBeCloseTo(0, 5);
  });
});

describe("fly", () => {
  it("flies up and stops at the ceiling", () => {
    const p = player({ allowFly: true });
    expect(p.setMode("fly")).toBe("fly");
    run(p, 4, { moveUp: 1 });
    expect(p.feet.y + NAV_DEFAULTS.height).toBeLessThanOrEqual(3 + 1e-3);
    expect(p.feet.y + NAV_DEFAULTS.height).toBeGreaterThan(2.9);
  });

  it("respects maxHeight and does not enter nofly volumes", () => {
    const p = player({ allowFly: true, mode: "fly", maxHeight: 2.5 });
    run(p, 3, { moveUp: 1 });
    expect(p.feet.y + NAV_DEFAULTS.height).toBeLessThanOrEqual(2.5 + 1e-6);
    const q = player({ allowFly: true, mode: "fly" }, { position: [-4.6, 1.6, -1], yaw: 0 });
    run(q, 3, { moveY: 1 });
    expect(q.feet.z).toBeGreaterThan(-3 + 0.29 - 1e-3);
  });

  it("can fly over the 1 m glass but not through the floor", () => {
    const p = player({ allowFly: true, mode: "fly" }, { position: [-0.5, 2.8, 1], yaw: 180 });
    run(p, 3, { moveY: 1 });
    expect(p.feet.z).toBeGreaterThan(3);
    run(p, 2, { moveUp: -1 });
    expect(p.feet.y).toBeGreaterThanOrEqual(-1e-3);
  });
});

describe("api", () => {
  it("moveTo animates and lands on the floor", async () => {
    const p = player();
    const done = p.moveTo({ position: [-5.2, 5, 3], yaw: 90, pitch: -10 }, 1000);
    run(p, 0.5, {});
    expect(p.isAnimating).toBe(true);
    run(p, 0.6, {});
    expect(await done).toBe(true);
    expect(p.feet.y).toBeCloseTo(0.51, 3); // landing of the stairs
    expect(p.yaw).toBeCloseTo(90, 3);
    const interrupted = p.moveTo({ position: [0, 1.6, 0] }, 1000);
    p.teleport({ position: [1, 1.6, 1] });
    expect(await interrupted).toBe(false);
  });

  it("resolves config with URL overrides", () => {
    const c = resolveNavigationConfig(
      { collision: "a.glb", walkSpeed: 2, spawn: { position: [1, 2, 3], yaw: 45 } },
      new URLSearchParams("nav=fly&allowFly=1&collision=b.glb&spawnYaw=90"),
    );
    expect(c.mode).toBe("fly");
    expect(c.allowFly).toBe(true);
    expect(c.collision).toBe("b.glb");
    expect(c.walkSpeed).toBe(2);
    expect(c.spawn).toEqual({ position: [1, 2, 3], yaw: 90 });
    expect(resolveNavigationConfig({ collision: "a.glb" }, new URLSearchParams("collision=none")).collision).toBeUndefined();
  });
});
