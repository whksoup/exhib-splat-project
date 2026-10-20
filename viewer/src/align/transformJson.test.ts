import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { bakeCommand, buildTransformJson, sourceFromModelUrl, stemFromSource } from "./transformJson";

describe("align transform JSON", () => {
  it("matches three.js Object3D TRS", () => {
    const o = new THREE.Object3D();
    o.position.set(2, -1, 3);
    o.quaternion
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
    o.scale.setScalar(1.7);
    o.updateMatrix();
    const j = buildTransformJson({ position: o.position, quaternion: o.quaternion, scale: 1.7 }, "a.ply", "t");
    j.matrix.forEach((v, i) => expect(v).toBeCloseTo(o.matrix.elements[i], 12));
    expect(j.eulerOrder).toBe("XYZ");
    const [ex, ey, ez] = j.rotationDeg.map((d) => THREE.MathUtils.degToRad(d));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(ex, ey, ez, "XYZ"));
    expect(Math.abs(q.dot(o.quaternion))).toBeCloseTo(1, 12);
    expect(j.tool).toBe("viewer-align");
  });

  it("cleans float noise in rotationDeg", () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const j = buildTransformJson({ position: new THREE.Vector3(), quaternion: q, scale: 1 }, "a.ply");
    expect(j.rotationDeg).toEqual([-90, 0, 0]);
  });

  it("maps model URLs to sources, stems and a bake command", () => {
    expect(sourceFromModelUrl("/source/OculusMerged_1.ply")).toBe("assets/source_ply/OculusMerged_1.ply");
    expect(sourceFromModelUrl("/models/test/v1/test-lod.rad")).toBe("assets/rad_output/test/v1/test-lod.rad");
    expect(stemFromSource("assets/source_ply/OculusMerged_1.ply")).toBe("OculusMerged_1");
    expect(stemFromSource("assets/rad_output/test/v1/test-lod.rad")).toBe("test");
    expect(bakeCommand("assets/source_ply/OculusMerged_1.ply", "OculusMerged_1")).toBe(
      "node pipeline/transform.mjs assets/source_ply/OculusMerged_1.ply --transform assets/transforms/OculusMerged_1.json --out assets/source_ply/OculusMerged_1-aligned.ply",
    );
  });
});
