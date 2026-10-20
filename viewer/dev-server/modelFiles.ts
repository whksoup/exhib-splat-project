/**
 * Dev/preview-server middleware (Node side, not shipped to the browser).
 *
 * - Serves model files from directories outside the Vite root with real
 *   HTTP Range support (206 / Content-Range / 416), which Spark relies on for
 *   paged .rad streaming. Vite's built-in static serving only covers files
 *   inside the project root/publicDir, so ../assets/* needs this.
 * - GET  /__models   JSON list of loadable model files (powers the picker shown
 *                    when no ?model= is given; handy on phones/Quest).
 * - POST /__results  Saves a perf-overlay result JSON into ../reports/raw/.
 *
 * Production hosting (CDN, CORS, cache rules) lives in ../hosting, not here.
 */
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export interface MountPoint {
  /** URL prefix, e.g. "/models/" (must start and end with "/"). */
  prefix: string;
  /** Absolute directory on disk. */
  dir: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".rad": "application/octet-stream",
  ".radc": "application/octet-stream",
  ".ply": "application/octet-stream",
  ".spz": "application/octet-stream",
  ".splat": "application/octet-stream",
  ".ksplat": "application/octet-stream",
  ".sog": "application/zip",
  ".zip": "application/zip",
  ".json": "application/json",
  ".webp": "image/webp",
  // Navigation assets (/nav/): collision meshes, plan images.
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".png": "image/png",
};

/** Files that can be opened directly as a model (chunk files are excluded). */
const LOADABLE_EXT = new Set([".rad", ".ply", ".spz", ".sog", ".splat", ".ksplat", ".zip"]);

type Next = (err?: unknown) => void;

function setCommonHeaders(res: ServerResponse): void {
  // Same-origin in dev, but mirror what the CDN must do so behaviour matches.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, ETag");
  res.setHeader("Timing-Allow-Origin", "*");
  res.setHeader("Accept-Ranges", "bytes");
  // no-store keeps every page load "cold cache" so first-frame timings are comparable.
  res.setHeader("Cache-Control", "no-store");
}

/** Parse a single "bytes=a-b" range. Returns null if absent, "invalid" if unsatisfiable. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or malformed: ignore, serve full body (allowed by RFC 9110)
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === "" && b === "") return "invalid";
  if (a === "") {
    // suffix range: last N bytes
    const n = Number(b);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

function resolveInside(dir: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const full = path.resolve(dir, "." + path.posix.normalize("/" + decoded));
  const root = path.resolve(dir);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

function serveFile(req: IncomingMessage, res: ServerResponse, file: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  if (!stat.isFile()) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  setCommonHeaders(res);
  res.setHeader("Content-Type", CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Last-Modified", stat.mtime.toUTCString());
  res.setHeader("ETag", `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`);

  const range = parseRange(req.headers.range, stat.size);
  if (range === "invalid") {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${stat.size}`);
    res.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  res.statusCode = range ? 206 : 200;
  if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  res.setHeader("Content-Length", String(stat.size === 0 ? 0 : end - start + 1));
  if (req.method === "HEAD" || stat.size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function listModels(mounts: MountPoint[]): { url: string; bytes: number }[] {
  const out: { url: string; bytes: number }[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      const url = prefix + encodeURIComponent(e.name);
      if (e.isDirectory()) {
        // An unbundled SOG is a directory containing meta.json.
        walk(full, url + "/", depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (LOADABLE_EXT.has(ext) || e.name === "meta.json") {
          out.push({ url, bytes: fs.statSync(full).size });
        }
      }
    }
  };
  for (const m of mounts) walk(m.dir, m.prefix, 0);
  return out.sort((a, b) => a.url.localeCompare(b.url));
}

function saveResult(req: IncomingMessage, res: ServerResponse, reportsDir: string): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > 2_000_000) req.destroy();
    else chunks.push(c);
  });
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { device?: { profile?: string } };
      const profile = String(body.device?.profile ?? "unknown").replace(/[^a-z0-9_-]/gi, "");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.mkdirSync(reportsDir, { recursive: true });
      const file = path.join(reportsDir, `${stamp}_${profile}.json`);
      fs.writeFileSync(file, JSON.stringify(body, null, 2));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, file: path.relative(path.resolve(reportsDir, "..", ".."), file) }));
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
  });
}

export function modelFilesPlugin(options: { mounts: MountPoint[]; reportsDir: string }): Plugin {
  const { mounts, reportsDir } = options;
  const middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const url = (req.url ?? "").split("?")[0];
    if (url === "/__models" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(listModels(mounts)));
      return;
    }
    if (url === "/__results" && req.method === "POST") {
      saveResult(req, res, reportsDir);
      return;
    }
    for (const m of mounts) {
      if (!url.startsWith(m.prefix)) continue;
      if (req.method === "OPTIONS") {
        setCommonHeaders(res);
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const file = resolveInside(m.dir, url.slice(m.prefix.length));
      if (!file) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }
      serveFile(req, res, file);
      return;
    }
    next();
  };
  return {
    name: "splat-model-files",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
