/**
 * Section cut through the splats: hide every splat whose centre lies outside
 * floor <= dot(centre, axis) <= cut.
 *
 * Mechanism (verified against @sparkjsdev/spark 2.3.1 types and source): a
 * dyno world modifier. SplatMesh.worldModifiers are applied inside the mesh's
 * splat generator after the object->world transform (SplatMesh.constructGenerator:
 * `for (const modifier of this.worldModifiers) gsplat = modifier.apply({ gsplat }).gsplat`),
 * so `gsplat.center` is in world space. Clearing `gsplat.flags` (GSPLAT_FLAG_ACTIVE)
 * makes the generator emit an empty splat. This runs for plain and paged
 * meshes alike, because both go through the same generator.
 *
 * The cut values are dyno uniforms (dyno.dynoFloat / dyno.dynoVec3); changing
 * them needs SplatMesh.updateVersion() so Spark re-runs the generator. Adding
 * or removing the modifier needs SplatMesh.updateGenerator() (recompile).
 *
 * Note: the test is on splat centres, so a splat centred just below the cut
 * still draws its full footprint. LoD traversal (CPU side) does not know about
 * the cut, so hidden splats still count against the splat budget.
 */
import * as THREE from "three";
import { dyno, type GsplatModifier, type SplatMesh } from "@sparkjsdev/spark";

const FAR = 1e9;

interface Installed {
  mesh: SplatMesh;
  modifier: GsplatModifier;
  previous: GsplatModifier[] | undefined;
}

export class SectionCut {
  private readonly axis = dyno.dynoVec3(new THREE.Vector3(0, 1, 0));
  private readonly lo = dyno.dynoFloat(-FAR);
  private readonly hi = dyno.dynoFloat(FAR);
  private installed: Installed[] = [];

  /** Attach to meshes not yet carrying the cut. */
  install(meshes: SplatMesh[]): void {
    for (const mesh of meshes) {
      if (this.installed.some((i) => i.mesh === mesh)) continue;
      const modifier = this.makeModifier();
      const previous = mesh.worldModifiers;
      mesh.worldModifiers = [...(previous ?? []), modifier];
      mesh.updateGenerator();
      this.installed.push({ mesh, modifier, previous });
    }
  }

  /** Remove the cut from every mesh, restoring any earlier world modifiers. */
  uninstall(): void {
    for (const { mesh, modifier, previous } of this.installed) {
      const rest = (mesh.worldModifiers ?? []).filter((m) => m !== modifier);
      mesh.worldModifiers = rest.length > 0 ? rest : previous;
      mesh.updateGenerator();
    }
    this.installed = [];
  }

  /**
   * Keep splats with floor <= dot(centre, axis) <= cut. Pass null to disable
   * either side.
   */
  set(axis: THREE.Vector3, cut: number | null, floor: number | null): void {
    this.axis.value.copy(axis).normalize();
    this.hi.value = cut ?? FAR;
    this.lo.value = floor ?? -FAR;
    for (const { mesh } of this.installed) mesh.updateVersion();
  }

  private makeModifier(): GsplatModifier {
    const { axis, lo, hi } = this;
    return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
      if (!gsplat) throw new Error("SectionCut: no gsplat input");
      const cut = new dyno.Dyno({
        inTypes: { gsplat: dyno.Gsplat, axis: "vec3", lo: "float", hi: "float" },
        outTypes: { gsplat: dyno.Gsplat },
        inputs: { gsplat, axis, lo, hi },
        statements: ({ inputs, outputs }) => [
          `${outputs.gsplat} = ${inputs.gsplat};`,
          `{`,
          `  float sectionDepth = dot(${inputs.gsplat}.center, ${inputs.axis});`,
          `  if (sectionDepth > ${inputs.hi} || sectionDepth < ${inputs.lo}) {`,
          `    ${outputs.gsplat}.flags = 0u;`,
          `  }`,
          `}`,
        ],
      });
      return { gsplat: cut.outputs.gsplat };
    });
  }
}
