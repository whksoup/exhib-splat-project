import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { modelFilesPlugin } from "./dev-server/modelFiles.ts";
import { planExportPlugin } from "./dev-server/planExport.ts";
import { alignTransformPlugin } from "./dev-server/alignTransform.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const sparkPkg = JSON.parse(
  fs.readFileSync(path.join(here, "node_modules", "@sparkjsdev", "spark", "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  // Relative base so the built viewer works from any CDN sub-path.
  base: "./",
  define: {
    __SPARK_VERSION__: JSON.stringify(sparkPkg.version),
  },
  plugins: [
    modelFilesPlugin({
      mounts: [
        { prefix: "/models/", dir: path.join(repoRoot, "assets", "rad_output") },
        { prefix: "/source/", dir: path.join(repoRoot, "assets", "source_ply") },
        // Collision GLBs (and plan exports) for navigation: /nav/<model>/<file>.glb
        { prefix: "/nav/", dir: path.join(repoRoot, "assets", "nav") },
      ],
      reportsDir: path.join(repoRoot, "reports", "raw"),
    }),
    // Plan export (src/plan/): POST /__plan-export writes into assets/nav/<model>/ only.
    planExportPlugin({ navDir: path.join(repoRoot, "assets", "nav"), repoRoot }),
    // Align mode (src/align/): POST /__align-transform writes assets/transforms/<stem>.json only.
    alignTransformPlugin({ transformsDir: path.join(repoRoot, "assets", "transforms"), repoRoot }),
  ],
  server: {
    host: true, // listen on 0.0.0.0 so phones / Quest on the LAN can connect
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    target: "es2022",
    // Spark bundles its WASM + worker code inline (~2.8 MB); don't warn about it.
    chunkSizeWarningLimit: 4000,
  },
});
