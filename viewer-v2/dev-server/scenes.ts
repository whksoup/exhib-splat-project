/**
 * Dev-server endpoints for scene save files (Node side, not shipped).
 *
 * Scenes live in <repo>/scenes/<name>/ (scene.json, nav/, build/); the files
 * themselves are served by the /scenes/ mount in modelFiles.ts. This plugin adds:
 *
 *   GET  /__scenes                          list with build status            -> {ok, scenes: [...]}
 *   GET  /__scenes/sources                  files in assets/source_ply        -> {ok, files: [...]}
 *   POST /__scenes/create     {name, source}
 *   POST /__scenes/duplicate  {from, name}   copies scene.json + nav/ (not build/)
 *   POST /__scenes/delete     {name, confirm} removes scenes/<name>/ only (never the source)
 *   POST /__scenes/save?name=<n>            body = scene.json (validated; build fields stay server-owned)
 *   GET  /__scenes/nav?name=<n>             files in scenes/<n>/nav/
 *   POST /__scenes/nav-file?name=<n>&file=<f>  raw body -> scenes/<n>/nav/<f> (plan exports)
 *   GET  /__scene-source/<n>/<file>         the scene's source file, Range-served (unbuilt preview)
 *   POST /__build             {name}         run pipeline/build-scene.mjs (one at a time)
 *   GET  /__build/status                    {running, name, progress, result, external, ...}
 *                                           external = a build started elsewhere (build-scene.bat),
 *                                           seen through the pipeline's scenes/.build.lock
 *   GET  /__build/events                    Server-Sent Events: reset, log, progress, done
 *   POST /__build/cancel
 *
 * Safety: scene names must match SCENE_NAME_RE (shared/scene-schema.mjs: letters,
 * digits, _ and -, no dots); every resolved path is re-checked to sit directly
 * inside scenes/ (or assets/source_ply/ for sources); bodies are size-limited.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import {
  SCENE_FILE,
  SOURCE_EXTS,
  createScene,
  isSafeSourcePath,
  isValidSceneName,
  navMayBeMisaligned,
  stringifyScene,
  transformChangedSinceBuild,
  validateScene,
} from "../../shared/scene-schema.mjs";
import { serveFile } from "./modelFiles.ts";

type Next = (err?: unknown) => void;
type Json = Record<string, unknown>;

const NAV_FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}\.(png|json|glb)$/;
const MAX_SCENE_BYTES = 2 * 1024 * 1024;
const MAX_NAV_BYTES = 512 * 1024 * 1024;
const MAX_LOG_LINES = 4000;
/** Global build lock written by pipeline/lib/scene-files.mjs acquireBuildLock (keep in sync). */
const BUILD_LOCK_FILE = ".build.lock";

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage, max = MAX_SCENE_BYTES): Promise<Json> {
  const buf = await readBody(req, max);
  try {
    const v = JSON.parse(buf.toString("utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Json;
  } catch {
    throw Object.assign(new Error("body is not a JSON object"), { status: 400 });
  }
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i > 20 || !["EPERM", "EBUSY", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

interface BuildState {
  child: ChildProcess | null;
  id: number;
  name: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lines: string[];
  progress: { stage: string; pct: number; message: string } | null;
  result: { status: string; error: string | null } | null;
  exitCode: number | null;
}

export interface ScenesPluginOptions {
  repoRoot: string;
  scenesDir: string;
  sourcesDir: string;
}

export function scenesPlugin(options: ScenesPluginOptions): Plugin {
  const repoRoot = path.resolve(options.repoRoot);
  const scenesRoot = path.resolve(options.scenesDir);
  const sourcesRoot = path.resolve(options.sourcesDir);
  const buildScript = path.join(repoRoot, "pipeline", "build-scene.mjs");
  const rel = (p: string) => path.relative(repoRoot, p).split(path.sep).join("/");

  const build: BuildState = { child: null, id: 0, name: null, startedAt: null, finishedAt: null, lines: [], progress: null, result: null, exitCode: null };
  const clients = new Set<ServerResponse>();

  /** Absolute scene folder for a validated name (throws 400 otherwise). */
  function sceneDir(name: unknown): string {
    if (!isValidSceneName(name)) throw httpError(400, "invalid scene name (letters, digits, _ and -, max 64 chars)");
    const dir = path.join(scenesRoot, name as string);
    if (path.dirname(dir) !== scenesRoot) throw httpError(400, "path escapes scenes/");
    return dir;
  }

  function readSceneFile(dir: string) {
    const file = path.join(dir, SCENE_FILE);
    if (!fs.existsSync(file)) throw httpError(404, `scene not found: ${rel(dir)}`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const { scene, errors } = validateScene(raw);
    if (!scene) throw httpError(422, `invalid ${rel(file)}: ${errors.join("; ")}`);
    return scene;
  }

  function navFiles(dir: string): { file: string; bytes: number }[] {
    const nav = path.join(dir, "nav");
    if (!fs.existsSync(nav)) return [];
    return fs
      .readdirSync(nav, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => ({ file: `nav/${e.name}`, bytes: fs.statSync(path.join(nav, e.name)).size }))
      .sort((a, b) => a.file.localeCompare(b.file));
  }

  function listSources(): { path: string; bytes: number }[] {
    if (!fs.existsSync(sourcesRoot)) return [];
    const out: { path: string; bytes: number }[] = [];
    for (const e of fs.readdirSync(sourcesRoot, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith(".")) continue;
      const p = rel(path.join(sourcesRoot, e.name));
      if (!isSafeSourcePath(p)) continue;
      out.push({ path: p, bytes: fs.statSync(path.join(sourcesRoot, e.name)).size });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Repo-relative source -> absolute path, only if it is a regular file inside the repo. */
  function resolveSource(source: string): string | null {
    if (!isSafeSourcePath(source)) return null;
    const abs = path.resolve(repoRoot, source);
    if (!abs.startsWith(repoRoot + path.sep)) return null;
    try {
      return fs.statSync(abs).isFile() ? abs : null;
    } catch {
      return null;
    }
  }

  function listScenes() {
    if (!fs.existsSync(scenesRoot)) return [];
    const out: Json[] = [];
    const ext = externalBuild();
    for (const e of fs.readdirSync(scenesRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || !isValidSceneName(e.name)) continue;
      const dir = path.join(scenesRoot, e.name);
      if (!fs.existsSync(path.join(dir, SCENE_FILE))) continue;
      try {
        const s = readSceneFile(dir);
        const nav = navFiles(dir);
        const radPresent = !!s.build && fs.existsSync(path.join(dir, "build", s.build.radFile));
        out.push({
          name: e.name,
          source: s.source,
          sourceExists: !!resolveSource(s.source),
          built: radPresent,
          build: s.build
            ? { finishedAt: s.build.finishedAt, radFile: s.build.radFile, splatCount: s.build.splatCount ?? null, wallClockSeconds: s.build.wallClockSeconds ?? null }
            : null,
          buildAttempt: s.buildAttempt,
          transformChanged: transformChangedSinceBuild(s),
          navWarning: navMayBeMisaligned(s, nav.length),
          navFiles: nav.length,
          updatedAt: s.updatedAt ?? null,
          building: (build.child !== null && build.name === e.name) || ext?.scene === e.name,
        });
      } catch (err) {
        out.push({ name: e.name, error: (err as Error).message });
      }
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  // --- build process --------------------------------------------------------

  function broadcast(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  }

  function onBuildLine(line: string): void {
    if (line.startsWith("@progress ")) {
      try {
        build.progress = JSON.parse(line.slice(10)) as BuildState["progress"];
        broadcast("progress", build.progress);
      } catch {
        /* ignore malformed */
      }
      return;
    }
    if (line.startsWith("@result ")) {
      try {
        const r = JSON.parse(line.slice(8)) as { status: string; error: string | null };
        build.result = { status: r.status, error: r.error ?? null };
      } catch {
        /* ignore */
      }
      return;
    }
    build.lines.push(line);
    if (build.lines.length > MAX_LOG_LINES) build.lines.splice(0, build.lines.length - MAX_LOG_LINES);
    broadcast("log", line);
  }

  function lineSplitter(): (chunk: Buffer) => void {
    let buf = "";
    return (chunk) => {
      buf += chunk.toString("utf8");
      const parts = buf.split(/\r?\n|\r(?!\n)/);
      buf = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) onBuildLine(p);
    };
  }

  function startBuild(name: string): void {
    const dir = sceneDir(name);
    if (!fs.existsSync(path.join(dir, SCENE_FILE))) throw httpError(404, `scene not found: ${name}`);
    if (build.child) throw httpError(409, `a build is already running (scene "${build.name}")`);
    const ext = externalBuild();
    if (ext) throw httpError(409, `a build of scene "${ext.scene}" is already running from the command line (pid ${ext.pid})`);
    build.id++;
    Object.assign(build, { name, startedAt: new Date().toISOString(), finishedAt: null, lines: [], progress: { stage: "start", pct: 0, message: "starting" }, result: null, exitCode: null });
    const child = spawn(process.execPath, [buildScript, name], { cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    build.child = child;
    broadcast("reset", { id: build.id, name, startedAt: build.startedAt });
    child.stdout?.on("data", lineSplitter());
    child.stderr?.on("data", lineSplitter());
    const finish = (code: number | null, err?: Error) => {
      if (build.child !== child) return;
      if (err) onBuildLine(`error: could not start build-scene.mjs: ${err.message}`);
      build.child = null;
      build.exitCode = code;
      build.finishedAt = new Date().toISOString();
      build.result ??= { status: code === 0 ? "ok" : "failed", error: code === 0 ? null : `build-scene.mjs exited with code ${code}` };
      broadcast("done", { id: build.id, name, exitCode: code, ...build.result });
    };
    child.on("error", (e) => finish(-1, e));
    child.on("close", (code) => finish(code));
  }

  function cancelBuild(): boolean {
    const child = build.child;
    if (!child?.pid) return false;
    onBuildLine("Cancelling build…");
    // build-lod runs as a grandchild; kill the whole tree.
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGTERM");
    build.result = { status: "failed", error: "cancelled" };
    return true;
  }

  /** A live build that this server did not start (build-scene.bat / another dev server). */
  function externalBuild(): { scene: string; pid: number; startedAt: string } | null {
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(scenesRoot, BUILD_LOCK_FILE), "utf8")) as { scene: string; pid: number; startedAt: string };
      if (build.child && cur.pid === build.child.pid) return null;
      if (!Number.isInteger(cur.pid) || cur.pid <= 0) return null;
      try {
        process.kill(cur.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM") return null; // stale lock
      }
      return { scene: String(cur.scene), pid: cur.pid, startedAt: String(cur.startedAt) };
    } catch {
      return null;
    }
  }

  function buildStatus(): Json {
    return {
      external: externalBuild(),
      ok: true,
      running: build.child !== null,
      id: build.id,
      name: build.name,
      startedAt: build.startedAt,
      finishedAt: build.finishedAt,
      progress: build.progress,
      result: build.result,
      exitCode: build.exitCode,
      lines: build.lines.slice(-200),
    };
  }

  // --- handlers -------------------------------------------------------------

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    const m = req.method ?? "GET";
    const q = url.searchParams;

    if (p === "/__scenes" && m === "GET") {
      reply(res, 200, { ok: true, scenes: listScenes(), scenesDir: rel(scenesRoot) });
      return true;
    }
    if (p === "/__scenes/sources" && m === "GET") {
      reply(res, 200, { ok: true, dir: rel(sourcesRoot), exts: SOURCE_EXTS, files: listSources() });
      return true;
    }
    if (p === "/__scenes/create" && m === "POST") {
      const body = await readJson(req);
      const dir = sceneDir(body.name);
      const source = String(body.source ?? "");
      if (!listSources().some((s) => s.path === source)) throw httpError(400, `source must be one of the files in ${rel(sourcesRoot)}/`);
      if (fs.existsSync(dir)) throw httpError(409, `scene "${body.name}" already exists`);
      const scene = createScene({ name: body.name as string, source });
      fs.mkdirSync(path.join(dir, "nav"), { recursive: true });
      writeAtomic(path.join(dir, SCENE_FILE), stringifyScene(scene));
      reply(res, 200, { ok: true, scene });
      return true;
    }
    if (p === "/__scenes/duplicate" && m === "POST") {
      const body = await readJson(req);
      const from = sceneDir(body.from);
      const dir = sceneDir(body.name);
      if (fs.existsSync(dir)) throw httpError(409, `scene "${body.name}" already exists`);
      const scene = readSceneFile(from);
      const now = new Date().toISOString();
      // build/ is not copied, so the copy has no build yet; nav assets match the copied transform.
      const copy = { ...scene, name: body.name as string, build: null, buildAttempt: null, createdAt: now, updatedAt: now, duplicatedFrom: scene.name };
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(path.join(from, "nav"))) fs.cpSync(path.join(from, "nav"), path.join(dir, "nav"), { recursive: true });
      else fs.mkdirSync(path.join(dir, "nav"));
      writeAtomic(path.join(dir, SCENE_FILE), stringifyScene(copy));
      reply(res, 200, { ok: true, scene: copy });
      return true;
    }
    if (p === "/__scenes/delete" && m === "POST") {
      const body = await readJson(req);
      const dir = sceneDir(body.name);
      if (body.confirm !== body.name) throw httpError(400, "confirm must repeat the scene name");
      if (!fs.existsSync(path.join(dir, SCENE_FILE))) throw httpError(404, "scene not found");
      if (build.child && build.name === body.name) throw httpError(409, "this scene is building; cancel the build first");
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      reply(res, 200, { ok: true, deleted: rel(dir) });
      return true;
    }
    if (p === "/__scenes/save" && m === "POST") {
      const dir = sceneDir(q.get("name"));
      const current = readSceneFile(dir); // 404 if the scene doesn't exist
      const body = await readJson(req);
      const { scene, errors } = validateScene(body);
      if (!scene) throw httpError(422, errors.join("; "));
      if (scene.name !== q.get("name")) throw httpError(400, "scene.name must match the folder name");
      if (scene.source !== current.source) throw httpError(400, "source cannot be changed (create a new scene instead)");
      // Build info is written by build-scene.mjs only; never let a stale client overwrite it.
      const saved = { ...scene, build: current.build, buildAttempt: current.buildAttempt, updatedAt: new Date().toISOString() };
      writeAtomic(path.join(dir, SCENE_FILE), stringifyScene(saved));
      reply(res, 200, { ok: true, scene: saved, file: rel(path.join(dir, SCENE_FILE)) });
      return true;
    }
    if (p === "/__scenes/nav" && m === "GET") {
      const dir = sceneDir(q.get("name"));
      reply(res, 200, { ok: true, files: navFiles(dir) });
      return true;
    }
    if (p === "/__scenes/nav-file" && m === "POST") {
      const dir = sceneDir(q.get("name"));
      const file = q.get("file") ?? "";
      if (!NAV_FILE_RE.test(file) || file.includes("..")) throw httpError(400, "invalid file name (expected <name>.png|json|glb)");
      if (!fs.existsSync(path.join(dir, SCENE_FILE))) throw httpError(404, "scene not found");
      const nav = path.join(dir, "nav");
      const target = path.resolve(nav, file);
      if (path.dirname(target) !== nav) throw httpError(400, "path escapes the nav folder");
      const buf = await readBody(req, MAX_NAV_BYTES);
      fs.mkdirSync(nav, { recursive: true });
      fs.writeFileSync(target, buf);
      reply(res, 200, { ok: true, file: rel(target), bytes: buf.length });
      return true;
    }
    if (p.startsWith("/__scene-source/") && (m === "GET" || m === "HEAD")) {
      const [name] = p.slice("/__scene-source/".length).split("/");
      const dir = sceneDir(decodeURIComponent(name ?? ""));
      const scene = readSceneFile(dir);
      const abs = resolveSource(scene.source);
      if (!abs) throw httpError(404, `source not found: ${scene.source}`);
      serveFile(req, res, abs);
      return true;
    }
    if (p === "/__build" && m === "POST") {
      const body = await readJson(req);
      startBuild(body.name as string);
      reply(res, 200, buildStatus());
      return true;
    }
    if (p === "/__build/status" && m === "GET") {
      reply(res, 200, buildStatus());
      return true;
    }
    if (p === "/__build/cancel" && m === "POST") {
      reply(res, 200, { ok: cancelBuild() });
      return true;
    }
    if (p === "/__build/events" && m === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`event: reset\ndata: ${JSON.stringify({ id: build.id, name: build.name, startedAt: build.startedAt })}\n\n`);
      for (const l of build.lines) res.write(`event: log\ndata: ${JSON.stringify(l)}\n\n`);
      if (build.progress) res.write(`event: progress\ndata: ${JSON.stringify(build.progress)}\n\n`);
      if (!build.child && build.finishedAt) {
        res.write(`event: done\ndata: ${JSON.stringify({ id: build.id, name: build.name, exitCode: build.exitCode, ...build.result })}\n\n`);
      }
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return true;
    }
    return false;
  }

  const middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const raw = req.url ?? "";
    if (!raw.startsWith("/__scene") && !raw.startsWith("/__build")) return next();
    const url = new URL(raw, "http://localhost");
    handle(req, res, url)
      .then((handled) => {
        if (!handled) reply(res, 404, { ok: false, error: "unknown scenes endpoint" });
      })
      .catch((err: Error & { status?: number }) => {
        if (!res.headersSent) reply(res, err.status ?? 500, { ok: false, error: err.message });
        else res.end();
      });
  };

  return {
    name: "scenes",
    configureServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.on("close", () => {
        if (build.child) cancelBuild();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
