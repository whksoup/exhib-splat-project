/**
 * Collision world: triangles from the collision GLB, grouped by the
 * object-name conventions below, one three-mesh-bvh MeshBVH per group.
 *
 * Name conventions (case-insensitive prefix of the mesh name or of the
 * nearest ancestor that has a known prefix):
 *   floor*    walkable ground (still subject to the slope limit)
 *   wall*     blocks sideways movement only, never walkable, never stepped onto
 *   ceiling*  blocks upward movement (jumping / flying), never walkable
 *   bound*    invisible barriers (glass, railings, scan edge): treated as walls
 *   nofly*    volumes only the flying player can't enter
 *   anything else: solid (blocks, and walkable where flat enough)
 * Lines and points are ignored.
 *
 * Geometry is taken in world space exactly as the GLB places it (node
 * transforms applied, nothing else). Pure three.js, no DOM.
 */
import * as THREE from "three";
import { MeshBVH, type ExtendedTriangle } from "three-mesh-bvh";

export type ColliderKind = "floor" | "wall" | "ceiling" | "bound" | "nofly" | "solid";

export const COLLIDER_KINDS: ColliderKind[] = ["floor", "wall", "ceiling", "bound", "nofly", "solid"];

const PREFIXES: [string, ColliderKind][] = [
  ["floor", "floor"],
  ["wall", "wall"],
  ["ceiling", "ceiling"],
  ["bound", "bound"],
  ["nofly", "nofly"],
];

/** Kind from one name, or null if the name has no known prefix. */
export function kindFromName(name: string | undefined): ColliderKind | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  for (const [p, k] of PREFIXES) if (n.startsWith(p)) return k;
  return null;
}

/** Kind of an object: its own name, else the nearest named ancestor's, else solid. */
export function classifyObject(obj: THREE.Object3D): ColliderKind {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
    const k = kindFromName(o.name);
    if (k) return k;
  }
  return "solid";
}

export interface RayHit {
  point: THREE.Vector3;
  /** Face normal, flipped to face the ray origin (collider winding doesn't matter). */
  normal: THREE.Vector3;
  distance: number;
  kind: ColliderKind;
}

export interface PushResult {
  /** Total displacement applied to the capsule. */
  offset: THREE.Vector3;
  /** Number of triangles that were penetrating. */
  contacts: number;
  /** Lowest push-direction Y seen (< -0.3 means something above pushed down). */
  minPushY: number;
  /** Highest push-direction Y seen. */
  maxPushY: number;
}

interface Group {
  kind: ColliderKind;
  geometry: THREE.BufferGeometry;
  bvh: MeshBVH;
}

const _v = new THREE.Vector3();
const _triPoint = new THREE.Vector3();
const _capPoint = new THREE.Vector3();
const _box = new THREE.Box3();
const _seg = new THREE.Line3();
const _dir = new THREE.Vector3();
const _n = new THREE.Vector3();
const _ray = new THREE.Ray();
const _mat = new THREE.Matrix4();
const _tmpMat = new THREE.Matrix4();
const DOUBLE = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

export class CollisionWorld {
  readonly groups: Group[] = [];
  readonly bounds = new THREE.Box3();
  /** Triangle count per kind (for the HUD / debugging). */
  readonly counts: Record<ColliderKind, number> = { floor: 0, wall: 0, ceiling: 0, bound: 0, nofly: 0, solid: 0 };

  private constructor(perKind: Map<ColliderKind, number[]>) {
    for (const [kind, positions] of perKind) {
      if (positions.length < 9) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeBoundingBox();
      const bvh = new MeshBVH(geometry);
      this.groups.push({ kind, geometry, bvh });
      this.counts[kind] = positions.length / 9;
      this.bounds.union(geometry.boundingBox!);
    }
  }

  /** Build from a loaded GLB scene (or any Object3D). */
  static fromObject(root: THREE.Object3D): CollisionWorld {
    root.updateMatrixWorld(true);
    const perKind = new Map<ColliderKind, number[]>();
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return; // Line / LineSegments / Points are not meshes
      const geom = mesh.geometry as THREE.BufferGeometry | undefined;
      const pos = geom?.getAttribute("position");
      if (!geom || !pos) return;
      const kind = classifyObject(mesh);
      const out = perKind.get(kind) ?? [];
      perKind.set(kind, out);
      const inst = mesh as unknown as THREE.InstancedMesh;
      const instances = inst.isInstancedMesh ? inst.count : 1;
      for (let i = 0; i < instances; i++) {
        if (inst.isInstancedMesh) {
          inst.getMatrixAt(i, _tmpMat);
          _mat.multiplyMatrices(mesh.matrixWorld, _tmpMat);
        } else {
          _mat.copy(mesh.matrixWorld);
        }
        appendTriangles(geom, _mat, out);
      }
    });
    return new CollisionWorld(perKind);
  }

  /** A single horizontal floor square (fallback when no collision GLB). */
  static flatFloor(y: number, halfSize = 5000): CollisionWorld {
    const s = halfSize;
    const positions = [-s, y, -s, -s, y, s, s, y, s, -s, y, -s, s, y, s, s, y, -s];
    return new CollisionWorld(new Map([["floor", positions]]));
  }

  get triangleCount(): number {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }

  get isEmpty(): boolean {
    return this.groups.length === 0;
  }

  /** Geometry per kind, for the debug wireframe. */
  debugGeometries(): { kind: ColliderKind; geometry: THREE.BufferGeometry }[] {
    return this.groups.map((g) => ({ kind: g.kind, geometry: g.geometry }));
  }

  /** All hits along a ray within [0, far], nearest first. */
  raycastAll(origin: THREE.Vector3, direction: THREE.Vector3, far: number, kinds: ReadonlySet<ColliderKind>): RayHit[] {
    _ray.set(origin, direction);
    const hits: RayHit[] = [];
    for (const g of this.groups) {
      if (!kinds.has(g.kind)) continue;
      for (const h of g.bvh.raycast(_ray, DOUBLE, 0, far)) {
        const normal = h.face ? h.face.normal.clone() : new THREE.Vector3(0, 1, 0);
        if (normal.dot(direction) > 0) normal.negate();
        hits.push({ point: h.point.clone(), normal, distance: h.distance, kind: g.kind });
      }
    }
    return hits.sort((a, b) => a.distance - b.distance);
  }

  /**
   * Push a capsule (segment start/end + radius) out of the given collider
   * kinds. Mutates `segment`. `horizontalOnly` drops the Y component of each
   * push (walls). `prevCenter` resolves the direction when the segment
   * passes exactly through a triangle.
   */
  pushOut(
    segment: THREE.Line3,
    radius: number,
    kinds: ReadonlySet<ColliderKind>,
    opts: { horizontalOnly?: (kind: ColliderKind) => boolean; prevCenter?: THREE.Vector3; iterations?: number } = {},
  ): PushResult {
    const result: PushResult = { offset: new THREE.Vector3(), contacts: 0, minPushY: 0, maxPushY: 0 };
    const iterations = opts.iterations ?? 4;
    for (let it = 0; it < iterations; it++) {
      let moved = false;
      for (const g of this.groups) {
        if (!kinds.has(g.kind)) continue;
        const horizontal = opts.horizontalOnly?.(g.kind) ?? false;
        _box.makeEmpty().expandByPoint(segment.start).expandByPoint(segment.end).expandByScalar(radius);
        g.bvh.shapecast({
          intersectsBounds: (box) => box.intersectsBox(_box),
          intersectsTriangle: (tri: ExtendedTriangle) => {
            const dist = tri.closestPointToSegment(segment, _triPoint, _capPoint);
            if (dist >= radius) return false;
            if (dist > 1e-6) {
              _dir.subVectors(_capPoint, _triPoint).divideScalar(dist);
            } else {
              // Segment touches the triangle plane: use the face normal, facing the previous centre.
              tri.getNormal(_n);
              segment.getCenter(_v);
              const ref = opts.prevCenter ?? _v;
              if (_n.dot(_v.subVectors(ref, _triPoint)) < 0) _n.negate();
              _dir.copy(_n);
            }
            let depth = radius - dist;
            if (horizontal) {
              const h = Math.hypot(_dir.x, _dir.z);
              if (h < 1e-3) return false; // a wall face seen from straight above/below: ignore
              _dir.set(_dir.x / h, 0, _dir.z / h);
              depth = Math.min(depth / h, radius); // horizontal distance needed to clear
            }
            segment.start.addScaledVector(_dir, depth);
            segment.end.addScaledVector(_dir, depth);
            result.offset.addScaledVector(_dir, depth);
            result.contacts++;
            result.minPushY = Math.min(result.minPushY, _dir.y);
            result.maxPushY = Math.max(result.maxPushY, _dir.y);
            _box.makeEmpty().expandByPoint(segment.start).expandByPoint(segment.end).expandByScalar(radius);
            moved = true;
            return false;
          },
        });
      }
      if (!moved) break;
    }
    return result;
  }

  /** True if the capsule overlaps any collider of the given kinds (by more than `slop`). */
  overlaps(segment: THREE.Line3, radius: number, kinds: ReadonlySet<ColliderKind>, slop = 1e-3): boolean {
    _seg.copy(segment);
    _box.makeEmpty().expandByPoint(_seg.start).expandByPoint(_seg.end).expandByScalar(radius);
    for (const g of this.groups) {
      if (!kinds.has(g.kind)) continue;
      const hit = g.bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(_box),
        intersectsTriangle: (tri: ExtendedTriangle) => tri.closestPointToSegment(_seg, _triPoint, _capPoint) < radius - slop,
      });
      if (hit) return true;
    }
    return false;
  }

  dispose(): void {
    for (const g of this.groups) g.geometry.dispose();
    this.groups.length = 0;
  }
}

const _a = new THREE.Vector3();

function appendTriangles(geom: THREE.BufferGeometry, matrix: THREE.Matrix4, out: number[]): void {
  const pos = geom.getAttribute("position");
  const index = geom.getIndex();
  const push = (i: number) => {
    _a.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    out.push(_a.x, _a.y, _a.z);
  };
  // Respect draw range/groups loosely: triangles only (glTF mode 4). Strips/fans
  // are rare in collision exports and are skipped by GLTFLoader conversion anyway.
  const count = index ? index.count : pos.count;
  const start = Math.max(0, geom.drawRange.start);
  const end = Math.min(count, geom.drawRange.start + geom.drawRange.count);
  for (let i = start; i + 2 < end; i += 3) {
    if (index) {
      push(index.getX(i));
      push(index.getX(i + 1));
      push(index.getX(i + 2));
    } else {
      push(i);
      push(i + 1);
      push(i + 2);
    }
  }
}
