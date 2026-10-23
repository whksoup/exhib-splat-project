import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { modelFilesPlugin } from "./dev-server/modelFiles.ts";
import { planExportPlugin } from "./dev-server/planExport.ts";
import { alignTransformPlugin } from "./dev-server/alignTransform.ts";
import { scenesPlugin } from "./dev-server/scenes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const sparkPkg = JSON.parse(
  fs.readFileSync(path.join(here, "node_modules", "@sparkjsdev", "spark", "package.json"), "utf8"),
) as { version: string };
const gslPkg = JSON.parse(
  fs.readFileSync(path.join(here, "node_modules", "gaussian-splat-lite", "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  // Relative base so the built viewer works from any CDN sub-path.
  base: "./",
  define: {
    __SPARK_VERSION__: JSON.stringify(sparkPkg.version),
    __GSL_VERSION__: JSON.stringify(gslPkg.version),
  },
  plugins: [
    modelFilesPlugin({
      mounts: [
        // Scene folders: /scenes/<name>/scene.json, /scenes/<name>/build/<name>-lod.rad, /scenes/<name>/nav/...
        { prefix: "/scenes/", dir: path.join(repoRoot, "scenes") },
        // v1-style direct model URLs (kept for debugging with ?model=).
        { prefix: "/models/", dir: path.join(repoRoot, "assets", "rad_output") },
        { prefix: "/source/", dir: path.join(repoRoot, "assets", "source_ply") },
        { prefix: "/nav/", dir: path.join(repoRoot, "assets", "nav") },
      ],
      reportsDir: path.join(repoRoot, "reports", "raw"),
    }),
    // Scenes (src/scene/): list/create/duplicate/delete/save, nav files, in-app builds.
    scenesPlugin({ repoRoot, scenesDir: path.join(repoRoot, "scenes"), sourcesDir: path.join(repoRoot, "assets", "source_ply") }),
    // v1 endpoints, still used by ?model= debugging: plan export to assets/nav/, transform JSON to assets/transforms/.
    planExportPlugin({ navDir: path.join(repoRoot, "assets", "nav"), repoRoot }),
    alignTransformPlugin({ transformsDir: path.join(repoRoot, "assets", "transforms"), repoRoot }),
  ],
  server: {
    host: true, // listen on 0.0.0.0 so phones / Quest on the LAN can connect
    // 5174 so v2 can run next to the frozen v1 viewer on 5173; falls back to the next free port.
    port: 5174,
    strictPort: false,
    fs: {
      // The scene schema is shared with the pipeline: ../shared/scene-schema.mjs.
      allow: [here, path.join(repoRoot, "shared")],
    },
  },
  // GSL loads its worker and WASM by URL relative to its own modules; pre-bundling would move them.
  optimizeDeps: { exclude: ["gaussian-splat-lite"] },
  preview: {
    host: true,
    port: 4174,
    strictPort: false,
  },
  build: {
    target: "es2022",
    // Spark bundles its WASM + worker code inline (~2.8 MB); don't warn about it.
    chunkSizeWarningLimit: 4000,
  },
});
