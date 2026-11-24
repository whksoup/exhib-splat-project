import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { editOf, gizmoAxes, uprightQuaternion, workFromObject } from "./colliderEdit";
import { pickWork, type WalkWork } from "./targeting";

const box: WalkWork = { id: "box", title: "Box", anchor: [0, 3, 0], center: [0, 1, 0], radius: 2.45, box: { axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [2, 1, 1] }, mount: "object" };
const wall: WalkWork = { ...box, id: "wall", box: { axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [2, 1, 0] }, mount: "wall" };
const object = (p: [number, number, number], yawDeg = 0, s: [number, number, number] = [1, 1, 1]) => ({
  position: new THREE.Vector3(...p),
  quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(yawDeg)),
  scale: new THREE.Vector3(...s),
});

describe("editing a collider with the gizmo", () => {
  it("moves the box and its marker together", () => {
    const w = workFromObject(box, object([5, 1, -2]), new THREE.Vector3(0, 2, 0));
    expect(w.center).toEqual([5, 1, -2]);
    expect(w.anchor).toEqual([5, 3, -2]);
    expect(w.box?.half).toEqual([2, 1, 1]);
  });

  it("turns the box's axes about Y and resizes along them", () => {
    const w = workFromObject(box, object([0, 1, 0], 90, [2, 1, 0.5]), new THREE.Vector3(1, 0, 0));
    expect(w.box!.axes[0][0]).toBeCloseTo(0);
    expect(w.box!.axes[0][2]).toBeCloseTo(-1);
    expect(w.box!.half).toEqual([4, 1, 0.5]);
    expect(w.anchor[2]).toBeCloseTo(-2);
    expect(w.radius).toBeCloseTo(Math.hypot(4, 1, 0.5), 4);
    // Looking and clicking follow the edited box straight away.
    expect(pickWork([0, 1, 10], [0, 0, -1], [w], 20)).toBe("box");
    expect(pickWork([1, 1, 10], [0, 0, -1], [w], 20)).toBeNull();
  });

  it("keeps a wall plane flat", () => {
    const w = workFromObject(wall, object([0, 1, 0], 0, [1.5, 2, 9]), new THREE.Vector3());
    expect(w.box!.half).toEqual([3, 2, 0]);
    expect(w.mount).toBe("wall");
    expect(gizmoAxes("scale", wall)).toEqual({ x: true, y: true, z: false });
    expect(gizmoAxes("scale", box).z).toBe(true);
    expect(gizmoAxes("rotate", box)).toEqual({ x: false, y: true, z: false });
  });

  it("keeps colliders upright when turned", () => {
    const tilted = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.8, -0.2, "YXZ"));
    const e = new THREE.Euler().setFromQuaternion(uprightQuaternion(tilted), "YXZ");
    expect(e.x).toBeCloseTo(0);
    expect(e.z).toBeCloseTo(0);
    expect(e.y).toBeCloseTo(0.8);
  });

  it("describes the edit for the host", () => {
    expect(editOf(box)).toEqual({ id: "box", center: [0, 1, 0], axes: box.box!.axes, half: [2, 1, 1], anchor: [0, 3, 0] });
  });
});
