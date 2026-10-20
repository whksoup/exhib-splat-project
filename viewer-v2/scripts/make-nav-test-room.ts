/**
 * Writes public/examples/nav-test-room.glb: the navigation test room from
 * src/nav/testRoom.ts, exported with three's GLTFExporter.
 *
 *   npm run make:nav-test        (node >= 22.6 runs .ts directly)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { buildNavTestRoom } from "../src/nav/testRoom.ts";

// GLTFExporter uses the browser FileReader to turn Blobs into ArrayBuffers.
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onload: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => this.done(buf));
  }
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => this.done(`data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buf).toString("base64")}`));
  }
  private done(result: ArrayBuffer | string): void {
    this.result = result;
    this.onload?.();
    this.onloadend?.();
  }
}
(globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader;

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "public", "examples", "nav-test-room.glb");

const root = buildNavTestRoom();
const glb = (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(glb));
console.log(`wrote ${path.relative(process.cwd(), out)} (${glb.byteLength} bytes)`);
