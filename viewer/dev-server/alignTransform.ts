/**
 * Dev/preview-server endpoint for Align-mode transform JSON (Node side, not shipped).
 *
 * GET  /__align-transform                  -> {"ok":true,"dir":"assets/transforms"}  (feature probe)
 * POST /__align-transform?file=<stem>.json -> JSON body written to assets/transforms/<stem>.json
 *
 * Same path safety as /__plan-export (planExport.ts):
 *  - <stem> must match [A-Za-z0-9_-][A-Za-z0-9._-]{0,99}, contain no "..", and end in ".json";
 *  - the resolved path is re-checked to sit inside transformsDir;
 *  - the body must be JSON (<= 1 MB) with tool === "viewer-align".
 */
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}\.json$/;
const MAX_BYTES = 1024 * 1024;

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** Returns the absolute target path, or an error string. */
export function resolveTransformTarget(dir: string, file: string | null): string | { error: string } {
  if (!file || !FILE_RE.test(file) || file.includes("..")) return { error: "invalid file name (expected <stem>.json)" };
  const root = path.resolve(dir);
  const full = path.resolve(root, file);
  if (!full.startsWith(root + path.sep)) return { error: "path escapes assets/transforms" };
  return full;
}

function save(req: IncomingMessage, res: ServerResponse, dir: string, repoRoot: string): void {
  const q = new URL(req.url ?? "", "http://localhost").searchParams;
  const target = resolveTransformTarget(dir, q.get("file"));
  if (typeof target !== "string") {
    req.resume();
    reply(res, 400, { ok: false, error: target.error });
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on("data", (c: Buffer) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_BYTES) {
      aborted = true;
      reply(res, 413, { ok: false, error: "too large" });
      req.destroy();
    } else chunks.push(c);
  });
  req.on("end", () => {
    if (aborted) return;
    let body: { tool?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tool?: unknown };
    } catch {
      reply(res, 400, { ok: false, error: "body is not JSON" });
      return;
    }
    if (body?.tool !== "viewer-align") {
      reply(res, 400, { ok: false, error: 'expected a transform JSON with tool "viewer-align"' });
      return;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(body, null, 2) + "\n");
      reply(res, 200, { ok: true, file: path.relative(repoRoot, target).split(path.sep).join("/"), bytes: size });
    } catch (err) {
      reply(res, 500, { ok: false, error: String(err) });
    }
  });
}

export function alignTransformPlugin(options: { transformsDir: string; repoRoot: string }): Plugin {
  const { transformsDir, repoRoot } = options;
  const middleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    const url = (req.url ?? "").split("?")[0];
    if (url !== "/__align-transform") return next();
    if (req.method === "GET") {
      reply(res, 200, { ok: true, dir: path.relative(repoRoot, transformsDir).split(path.sep).join("/") });
      return;
    }
    if (req.method === "POST") {
      save(req, res, transformsDir, repoRoot);
      return;
    }
    reply(res, 405, { ok: false, error: "method not allowed" });
  };
  return {
    name: "align-transform",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
