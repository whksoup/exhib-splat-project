import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { modelFilesPlugin } from "./dev-server/modelFiles.ts";

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
      ],
      reportsDir: path.join(repoRoot, "reports", "raw"),
    }),
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
