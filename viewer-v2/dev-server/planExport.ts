/**
 * Dev/preview-server endpoint for plan exports (Node side, not shipped).
 *
 * GET  /__plan-export                       -> {"ok":true,"dir":"assets/nav"}  (feature probe)
 * POST /__plan-export?model=<name>&file=<f> -> raw body written to assets/nav/<name>/<f>
 *
 * Writes are confined to `navDir`:
 *  - <name> must match [A-Za-z0-9_-][A-Za-z0-9._-]{0,99} and contain no "..";
 *  - <f> must be "plan-<label>.(png|json|glb)" with the same character rules;
 *  - the resolved path is re-checked to sit inside navDir.
 * Modelled on the /__results endpoint in modelFiles.ts.
 */
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
const FILE_RE = /^plan-[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}\.(png|json|glb)$/;
const MAX_BYTES = 512 * 1024 * 1024;

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** Returns the absolute target path, or an error string. */
export function resolvePlanTarget(navDir: string, model: string | null, file: string | null): string | { error: string } {
  if (!model || !NAME_RE.test(model) || model.includes("..")) return { error: "invalid model name" };
  if (!file || !FILE_RE.test(file) || file.includes("..")) return { error: "invalid file name (expected plan-<label>.png|json|glb)" };
  const root = path.resolve(navDir);
  const full = path.resolve(root, model, file);
  if (!full.startsWith(root + path.sep)) return { error: "path escapes assets/nav" };
  return full;
}

function savePlanFile(req: IncomingMessage, res: ServerResponse, navDir: string, repoRoot: string): void {
  const q = new URL(req.url ?? "", "http://localhost").searchParams;
  const target = resolvePlanTarget(navDir, q.get("model"), q.get("file"));
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
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.concat(chunks));
      reply(res, 200, { ok: true, file: path.relative(repoRoot, target).split(path.sep).join("/"), bytes: size });
    } catch (err) {
      reply(res, 500, { ok: false, error: String(err) });
    }
  });
}

export function planExportPlugin(options: { navDir: string; repoRoot: string }): Plugin {
  const { navDir, repoRoot } = options;
  const middleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    const url = (req.url ?? "").split("?")[0];
    if (url !== "/__plan-export") return next();
    if (req.method === "GET") {
      reply(res, 200, { ok: true, dir: path.relative(repoRoot, navDir).split(path.sep).join("/") });
      return;
    }
    if (req.method === "POST") {
      savePlanFile(req, res, navDir, repoRoot);
      return;
    }
    reply(res, 405, { ok: false, error: "method not allowed" });
  };
  return {
    name: "plan-export",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
