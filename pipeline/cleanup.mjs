// Cleanup hook (crop, floater removal, recentre near the origin).
//
// PHASE 2 STUB. The scope (docs/Project_Scope.md, "Technical architecture"
// step 2) runs cleanup before build-lod. For Phase 1 this is a pass-through
// so build.mjs already has the call site; Phase 2 replaces the body.
//
// Until then, two things are already possible without this hook:
//   - Cropping: pass build-lod's own crop flags after `--`, e.g.
//       node build.mjs in.ply --name m -- --within-dist=0,0,0,40
//     (verified in rust/build-lod/src/main.rs: --min-box=x,y,z, --max-box=x,y,z,
//      --within-dist=x,y,z,r). These crop but do NOT recentre.
//   - Recentring: build-lod has no translate option. It must be done to the
//     .ply before the build (e.g. PlayCanvas splat-transform, SuperSplat, or a
//     Phase 2 streaming rewrite of x/y/z using the centroid build.mjs prints).

/**
 * @param {string} inputPath
 * @param {{ header: object, bounds: object|null, enabled: boolean }} ctx
 * @returns {Promise<{ path: string, applied: string[] }>} file to feed build-lod
 */
export async function cleanup(inputPath, ctx) {
  if (ctx.enabled) {
    console.warn('[cleanup] --cleanup requested, but cleanup/recentre is not implemented until Phase 2; using input unchanged.');
  }
  return { path: inputPath, applied: [] };
}
