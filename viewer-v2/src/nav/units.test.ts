import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "./colliders";
import { NAV_DEFAULTS, resolveNavigationConfig } from "./navConfig";
import { emptyInput, PlayerController } from "./player";
import { buildNavTestRoom } from "./testRoom";

describe("metres per unit (?mpu=)", () => {
  it("reads body and motion values as metres and converts them to world units", () => {
    const cfg = resolveNavigationConfig({ fallbackFloorY: -1.6 }, new URLSearchParams("mpu=8&eyeHeight=1.6&walkSpeed=2"));
    expect(cfg.metresPerUnit).toBe(8);
    expect(cfg.eyeHeight).toBeCloseTo(0.2, 6);
    expect(cfg.walkSpeed).toBeCloseTo(0.25, 6);
    expect(cfg.radius).toBeCloseTo(NAV_DEFAULTS.radius / 8, 6);
    expect(cfg.gravity).toBeCloseTo(NAV_DEFAULTS.gravity / 8, 6);
    // Positions stay in world units.
    expect(cfg.fallbackFloorY).toBe(-1.6);
  });

  it("keeps the old behaviour without mpu", () => {
    const cfg = resolveNavigationConfig(undefined, new URLSearchParams());
    expect(cfg.metresPerUnit).toBeUndefined();
    expect(cfg.eyeHeight).toBe(NAV_DEFAULTS.eyeHeight);
    expect(cfg.radius).toBe(NAV_DEFAULTS.radius);
  });

  it("walks a room scaled down by mpu exactly like the metre room", () => {
    const mpu = 7.375;
    const small = buildNavTestRoom();
    small.scale.setScalar(1 / mpu);
    small.updateMatrixWorld(true);
    const big = new PlayerController(CollisionWorld.fromObject(buildNavTestRoom()), resolveNavigationConfig(undefined, new URLSearchParams()), { position: [0, 1.6, 0], yaw: 0 });
    const scaled = new PlayerController(
      CollisionWorld.fromObject(small),
      resolveNavigationConfig(undefined, new URLSearchParams(`mpu=${mpu}`)),
      { position: [0, 1.6 / mpu, 0], yaw: 0 },
    );
    for (let i = 0; i < 180; i++) {
      big.step(1 / 60, { ...emptyInput(), moveY: 1 });
      scaled.step(1 / 60, { ...emptyInput(), moveY: 1 });
    }
    const a = big.getEyePosition(), b = scaled.getEyePosition().multiplyScalar(mpu);
    expect(a.z).toBeLessThan(-1); // it really walked (into the test room's wall)
    expect(b.distanceTo(a)).toBeLessThan(0.05);
    expect(new THREE.Vector3().copy(a).y).toBeCloseTo(1.6, 2);
  });
});
