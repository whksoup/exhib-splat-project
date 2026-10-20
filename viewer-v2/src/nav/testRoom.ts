/**
 * The navigation test room, as three.js meshes named by the collider
 * conventions. Used by scripts/make-nav-test-room.ts (writes
 * public/examples/nav-test-room.glb) and by the unit tests, so both test
 * the same layout. Not imported by the viewer itself.
 *
 * Layout (metres, Y up, floor top at y = 0, room x -6..6, z -5..5, ceiling at 3):
 *   spawn           (0, 1.6, 0) looking down -Z
 *   pillar_1        solid 0.6 x 3 x 0.6 at (0, -2.5)
 *   floor_step      0.20 m step,  1 x 1 at (-2.5, -2)   -> climbable
 *   block_tall      0.50 m block, 1 x 1 at ( 2.5, -2)   -> too tall
 *   floor_stairs_N  3 steps of 0.17 m at x -5.8..-4.6, z 0.5..1.4, landing to z 4.8 at 0.51
 *   floor_ramp      15 deg ramp x 4.0..5.2, z 0.5..2.74 up to 0.6, then a landing
 *   floor_ramp_steep 55 deg ramp x 2.4..3.4, z 3.0..3.7 up to 1.0 -> too steep
 *   bound_glass     1.0 m tall glass barrier, x -2..1 at z 2.5
 *   nofly_zone      volume x -5.8..-3.5, z -4.8..-3, full height
 */
import * as THREE from "three";

export const NAV_TEST_SPAWN = { position: [0, 1.6, 0] as [number, number, number], yaw: 0, pitch: 0 };

const MAT = new THREE.MeshBasicMaterial({ color: 0x888888 });

/** Axis-aligned box from min/max corners, position attribute only (keeps the GLB tiny). */
function box(name: string, min: [number, number, number], max: [number, number, number]): THREE.Mesh {
  // 8 shared corners centred on the node origin, 12 outward-facing triangles.
  const h = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
  const v: number[] = [];
  for (let i = 0; i < 8; i++) v.push(i & 1 ? h[0] : -h[0], i & 2 ? h[1] : -h[1], i & 4 ? h[2] : -h[2]);
  const idx = [
    0, 4, 6, 0, 6, 2, // -x
    1, 3, 7, 1, 7, 5, // +x
    0, 1, 5, 0, 5, 4, // -y
    2, 6, 7, 2, 7, 3, // +y
    0, 2, 3, 0, 3, 1, // -z
    4, 5, 7, 4, 7, 6, // +z
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, MAT);
  m.name = name;
  m.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  return m;
}

/** Wedge rising along +Z from (z0, y=0) to (z1, y=h), between x0 and x1. */
function ramp(name: string, x0: number, x1: number, z0: number, z1: number, h: number): THREE.Mesh {
  const v = [
    [x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], // bottom 0..3
    [x0, h, z1], [x1, h, z1], // top edge 4..5
  ];
  const idx = [
    0, 3, 4, 0, 4, 1, 1, 4, 5, // slope (0,1,5,4)
    0, 1, 2, 0, 2, 3, // bottom
    3, 2, 5, 3, 5, 4, // back (vertical at z1)
    0, 4, 3, // side x0
    1, 2, 5, // side x1
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v.flat(), 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, MAT);
  m.name = name;
  return m;
}

export function buildNavTestRoom(): THREE.Group {
  const root = new THREE.Group();
  root.name = "nav_test_room";
  const t = 0.2; // wall thickness
  root.add(
    box("floor_main", [-6, -0.2, -5], [6, 0, 5]),
    box("ceiling_main", [-6, 3, -5], [6, 3.2, 5]),
    box("wall_north", [-6 - t, -0.2, -5 - t], [6 + t, 3.2, -5]),
    box("wall_south", [-6 - t, -0.2, 5], [6 + t, 3.2, 5 + t]),
    box("wall_west", [-6 - t, -0.2, -5], [-6, 3.2, 5]),
    box("wall_east", [6, -0.2, -5], [6 + t, 3.2, 5]),
    box("pillar_1", [-0.3, 0, -2.8], [0.3, 3, -2.2]),
    box("floor_step", [-3, 0, -2.5], [-2, 0.2, -1.5]),
    box("block_tall", [2, 0, -2.5], [3, 0.5, -1.5]),
    box("floor_stairs_1", [-5.8, 0, 0.5], [-4.6, 0.17, 0.8]),
    box("floor_stairs_2", [-5.8, 0, 0.8], [-4.6, 0.34, 1.1]),
    box("floor_stairs_3", [-5.8, 0, 1.1], [-4.6, 0.51, 1.4]),
    box("floor_landing", [-5.8, 0, 1.4], [-4.6, 0.51, 4.8]),
    ramp("floor_ramp", 4.0, 5.2, 0.5, 0.5 + 0.6 / Math.tan(THREE.MathUtils.degToRad(15)), 0.6),
    box("floor_ramp_top", [4.0, 0, 0.5 + 0.6 / Math.tan(THREE.MathUtils.degToRad(15))], [5.2, 0.6, 4.8]),
    ramp("floor_ramp_steep", 2.4, 3.4, 3.0, 3.7, 1.0),
    box("bound_glass", [-2, 0, 2.49], [1, 1.0, 2.51]),
    box("nofly_zone", [-5.8, 0, -4.8], [-3.5, 3, -3]),
  );
  return root;
}
