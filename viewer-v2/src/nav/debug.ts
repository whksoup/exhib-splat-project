/**
 * Collision debug view: wireframe of every collider (coloured by kind) and a
 * capsule gizmo at the player. Hidden by default; Navigation toggles it (N).
 * The capsule is most useful from orbit / debug-fly mode, looking at the player.
 */
import * as THREE from "three";
import type { ColliderKind, CollisionWorld } from "./colliders";

const COLORS: Record<ColliderKind, number> = {
  floor: 0x3ddc84,
  wall: 0x4da3ff,
  ceiling: 0xb48cff,
  bound: 0xffb020,
  nofly: 0xff4d6d,
  solid: 0xe0e0e0,
};

export class NavDebugView {
  readonly group = new THREE.Group();
  private readonly colliders = new THREE.Group();
  private readonly capsule: THREE.LineSegments;
  private capsuleKey = "";

  constructor(private readonly scene: THREE.Scene) {
    this.group.name = "nav-debug";
    this.group.visible = false;
    this.capsule = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffff00, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.capsule.renderOrder = 1000;
    this.group.add(this.colliders, this.capsule);
    scene.add(this.group);
  }

  get visible(): boolean {
    return this.group.visible;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }

  /** Hide the capsule while looking through the player's own eyes. */
  set capsuleVisible(v: boolean) {
    this.capsule.visible = v;
  }

  setWorld(world: CollisionWorld): void {
    for (const c of this.colliders.children) {
      const l = c as THREE.LineSegments;
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    this.colliders.clear();
    for (const { kind, geometry } of world.debugGeometries()) {
      const lines = new THREE.LineSegments(
        new THREE.WireframeGeometry(geometry),
        new THREE.LineBasicMaterial({ color: COLORS[kind], transparent: true, opacity: 0.75 }),
      );
      lines.name = `nav-debug-${kind}`;
      this.colliders.add(lines);
    }
  }

  /** Place the capsule gizmo; feet = bottom of the capsule. */
  updateCapsule(feet: THREE.Vector3, radius: number, height: number): void {
    const key = `${radius}/${height}`;
    if (key !== this.capsuleKey) {
      this.capsuleKey = key;
      this.capsule.geometry.dispose();
      const cap = new THREE.CapsuleGeometry(radius, Math.max(0, height - 2 * radius), 4, 12);
      this.capsule.geometry = new THREE.WireframeGeometry(cap);
      cap.dispose();
    }
    this.capsule.position.set(feet.x, feet.y + height / 2, feet.z);
  }

  dispose(): void {
    this.setWorld({ debugGeometries: () => [] } as unknown as CollisionWorld);
    this.capsule.geometry.dispose();
    (this.capsule.material as THREE.Material).dispose();
    this.scene.remove(this.group);
  }
}
