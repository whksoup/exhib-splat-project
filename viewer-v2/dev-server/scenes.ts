/**
 * Dev-server endpoints for scene save files (Node side, not shipped).
 *
 * Scenes live in <repo>/scenes/<name>/ (scene.json, nav/, build/); the files
 * themselves are served by the /scenes/ mount in modelFiles.ts. This plugin adds:
 *
 *   GET  /__scenes                          list with build status            -> {ok, scenes: [...]}
 *   GET  /__scenes/sources                  splat files under assets/source_ply (subfolders too) -> {ok, files: [...]}
 *   POST /__scenes/create     {name, sources: [...]}   one part per source ({source} also accepted)
 *   POST /__scenes/duplicate  {from, name}   copies scene.json + nav/ (not build/)
 *   POST /__scenes/delete     {name, confirm} removes scenes/<name>/ only (never the sources)
 *   POST /__scenes/save?name=<n>            body = scene.json (validated; build fields stay server-owned;
 *                                           added parts must be files under assets/source_ply)
 *   GET  /__scenes/info?name=<n>            per part: source size, splat count (.ply header), .rad on disk
 *   GET  /__scenes/nav?name=<n>             files in scenes/<n>/nav/
 *   POST /__scenes/nav-file?name=<n>&file=<f>  raw body -> scenes/<n>/nav/<f> (plan exports)
 *   GET  /__scenes/roi?name=<n>&path=<p>    a region file's outlines (p = assets/roi/<n>/<file>.json)
 *   POST /__scenes/roi?name=<n>&file=<f>    raw body = Spirula ROI region .json -> assets/roi/<n>/<f>
 *                                           (validated; replaces a previous copy and reports which
 *                                           outlines changed). scene.json is not touched: the client sets `roi`.
 *   GET  /__scene-source/<n>/<part>/<file>  a part's source file, Range-served (unbuilt preview)
 *   POST /__build             {name, force?, parts?}  run pipeline/build-scene.mjs (one at a time)
 *   GET  /__build/status                    {running, name, progress, parts, result, external, ...}
 *                                           external = a build started elsewhere (build-scene.bat),
 *                                           seen through the pipeline's scenes/.build.lock
 *   GET  /__build/events                    Server-Sent Events: reset, log, progress, part, done
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
  ROI_DIR,
  SCENE_FILE,
  SOURCE_EXTS,
  buildSummary,
  createScene,
  isSafeRoiPath,
  isSafeSceneRelPath,
  isSafeSourcePath,
  isValidPartId,
  isValidSceneName,
  navMayBeMisaligned,
  partState,
  partsFromSources,
  stringifyScene,
  transformChangedSinceBuild,
  validateScene,
} from "../../shared/scene-schema.mjs";
import { parseRoi } from "../../pipeline/lib/roi.mjs";
import { serveFile } from "./modelFiles.ts";

type Next = (err?: unknown) => void;
type Json = Record<string, unknown>;

const NAV_FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}\.(png|json|glb)$/;
const MAX_SCENE_BYTES = 2 * 1024 * 1024;
const MAX_NAV_BYTES = 512 * 1024 * 1024;
const MAX_ROI_BYTES = 4 * 1024 * 1024;
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

interface RoiOutlineInfo {
  name: string;
  /** Enabled in the ROI editor when the file was saved (part of its top-level region). */
  enabled: boolean;
  /** Can be cropped to (a prism with op "add"); otherwise `error` says why. */
  usable: boolean;
  error?: string;
  digest?: string;
}

/**
 * What the editor needs from a Spirula ROI region file: its outlines (each
 * checked with the pipeline's own reader, so the editor offers exactly what a
 * build can crop to) and whether the top-level region reads.
 */
function describeRoi(json: unknown, name: string): { type: string | null; topLevel: string | null; outlines: RoiOutlineInfo[] } {
  const j = json as { type?: unknown; editor?: { shapes?: { name?: unknown; enabled?: unknown }[] } };
  const shapes = Array.isArray(j?.editor?.shapes) ? j.editor.shapes : [];
  const outlines = shapes
    .filter((s) => typeof s?.name === "string" && s.name)
    .map((s): RoiOutlineInfo => {
      const outlineName = s.name as string;
      try {
        return { name: outlineName, enabled: s.enabled === true, usable: true, digest: parseRoi(json as object, name, [outlineName]).digest };
      } catch (e) {
        return { name: outlineName, enabled: s.enabled === true, usable: false, error: (e as Error).message };
      }
    });
  let topLevel: string | null = null;
  try {
    parseRoi(json as object, name);
  } catch (e) {
    topLevel = (e as Error).message;
  }
  return { type: typeof j?.type === "string" ? j.type : null, topLevel, outlines };
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
  progress: { stage: string; pct: number; message: string; part?: { id: string; index: number; count: number; pct: number } } | null;
  /** Per-part state, from build-scene.mjs @part lines (and @progress part percentages). */
  parts: Json[];
  result: { status: string; error: string | null } | null;
  exitCode: number | null;
}

/** Splat count from a .ply header (first 64 KB), null when not a readable .ply. */
function plySplatCount(file: string): number | null {
  if (!file.toLowerCase().endsWith(".ply")) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("latin1");
    const end = text.indexOf("end_header");
    if (!text.startsWith("ply") || end < 0) return null;
    const m = /^element vertex (\d+)\s*$/m.exec(text.slice(0, end));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
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

  const build: BuildState = { child: null, id: 0, name: null, startedAt: null, finishedAt: null, lines: [], progress: null, parts: [], result: null, exitCode: null };
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

  /** Splat files under assets/source_ply, including subfolders (e.g. parts/<scan>/part0.ply), up to 4 levels. */
  function listSources(): { path: string; bytes: number }[] {
    if (!fs.existsSync(sourcesRoot)) return [];
    const out: { path: string; bytes: number }[] = [];
    const walk = (dir: string, depth: number) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 4) walk(full, depth + 1);
          continue;
        }
        if (!e.isFile()) continue;
        const p = rel(full);
        if (!isSafeSourcePath(p)) continue;
        out.push({ path: p, bytes: fs.statSync(full).size });
      }
    };
    walk(sourcesRoot, 0);
    return out.sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }));
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

  /** assets/roi/<scene>/<file>.json -> absolute path (throws 400 for anything else). */
  function resolveRoi(rp: string): string {
    if (!isSafeRoiPath(rp)) throw httpError(400, `invalid region path "${rp}" (expected ${ROI_DIR}/<scene>/<file>.json)`);
    const root = path.resolve(repoRoot, ...ROI_DIR.split("/"));
    const abs = path.resolve(repoRoot, ...rp.split("/"));
    if (!abs.startsWith(root + path.sep)) throw httpError(400, "path escapes the roi folder");
    return abs;
  }

  /** A part's built .rad inside scenes/<n>/build/, if it is really there. */
  function builtRad(dir: string, radFile: string | undefined): string | null {
    if (!radFile || !isSafeSceneRelPath(radFile)) return null;
    const buildDir = path.join(dir, "build");
    const abs = path.resolve(buildDir, ...radFile.split("/"));
    if (!abs.startsWith(buildDir + path.sep)) return null;
    return fs.existsSync(abs) ? abs : null;
  }

  type Scene = NonNullable<ReturnType<typeof validateScene>["scene"]>;

  function partInfo(dir: string, s: Scene) {
    return s.parts.map((p) => {
      const abs = resolveSource(p.source);
      const b = s.build?.parts?.find((x) => x.id === p.id);
      return {
        id: p.id,
        source: p.source,
        exists: !!abs,
        bytes: abs ? fs.statSync(abs).size : null,
        splats: abs ? plySplatCount(abs) : null,
        builtOnDisk: !!b && !!builtRad(dir, b.radFile),
      };
    });
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
        const parts = s.parts.map((p) => ({
          id: p.id,
          source: p.source,
          enabled: p.enabled !== false,
          sourceExists: !!resolveSource(p.source),
          state: partState(s, p),
        }));
        const radPresent = (s.build?.parts ?? []).some((b) => !!builtRad(dir, b.radFile));
        out.push({
          name: e.name,
          source: s.parts[0]?.source,
          parts,
          summary: buildSummary(s),
          sourceExists: parts.every((p) => !p.enabled || p.sourceExists),
          built: radPresent,
          build: s.build
            ? { finishedAt: s.build.finishedAt, status: s.build.status, splatCount: s.build.splatCount ?? null, wallClockSeconds: s.build.wallClockSeconds ?? null, peakMemoryBytes: s.build.peakMemoryBytes ?? null }
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
        const pp = build.progress?.part;
        if (pp) {
          const row = build.parts.find((r) => r.id === pp.id);
          if (row) row.pct = pp.pct;
        }
        broadcast("progress", build.progress);
      } catch {
        /* ignore malformed */
      }
      return;
    }
    if (line.startsWith("@part ")) {
      try {
        const p = JSON.parse(line.slice(6)) as Json & { id: string };
        const i = build.parts.findIndex((r) => r.id === p.id);
        const row = { ...(i >= 0 ? build.parts[i] : {}), ...p, ...(p.status === "built" || p.status === "reused" || p.status === "kept" ? { pct: 100 } : {}) };
        if (i >= 0) build.parts[i] = row;
        else build.parts.push(row);
        broadcast("part", row);
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

  function startBuild(name: string, opts: { force?: unknown; parts?: unknown } = {}): void {
    const dir = sceneDir(name);
    if (!fs.existsSync(path.join(dir, SCENE_FILE))) throw httpError(404, `scene not found: ${name}`);
    if (build.child) throw httpError(409, `a build is already running (scene "${build.name}")`);
    const ext = externalBuild();
    if (ext) throw httpError(409, `a build of scene "${ext.scene}" is already running from the command line (pid ${ext.pid})`);
    const args = [buildScript, name];
    if (opts.force === true) args.push("--force");
    if (opts.parts !== undefined) {
      if (!Array.isArray(opts.parts) || !opts.parts.every((p) => isValidPartId(p))) throw httpError(400, "parts must be a list of part ids");
      for (const p of opts.parts as string[]) args.push("--part", p);
    }
    build.id++;
    Object.assign(build, { name, startedAt: new Date().toISOString(), finishedAt: null, lines: [], progress: { stage: "start", pct: 0, message: "starting" }, parts: [], result: null, exitCode: null });
    const child = spawn(process.execPath, args, { cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
      parts: build.parts,
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
      const sources = Array.isArray(body.sources) ? body.sources.map(String) : body.source !== undefined ? [String(body.source)] : [];
      if (sources.length === 0) throw httpError(400, "pick at least one source file");
      if (sources.length > 256) throw httpError(400, "at most 256 parts");
      if (new Set(sources).size !== sources.length) throw httpError(400, "a source is listed twice");
      const known = new Set(listSources().map((s) => s.path));
      const bad = sources.find((s) => !known.has(s));
      if (bad !== undefined) throw httpError(400, `source must be one of the files under ${rel(sourcesRoot)}/ (got "${bad}")`);
      if (fs.existsSync(dir)) throw httpError(409, `scene "${body.name}" already exists`);
      const scene = createScene({ name: body.name as string, parts: partsFromSources(sources) });
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
      // Parts can be added, removed, enabled and disabled; a new source must be a file under assets/source_ply.
      const before = new Set(current.parts.map((p) => p.source));
      const added = scene.parts.filter((p) => !before.has(p.source));
      if (added.length) {
        const known = new Set(listSources().map((s) => s.path));
        const bad = added.find((p) => !known.has(p.source));
        if (bad) throw httpError(400, `part "${bad.id}": source must be one of the files under ${rel(sourcesRoot)}/ (got "${bad.source}")`);
      }
      // A region file set or changed here must be one the editor uploaded (assets/roi/<scene>/...).
      const roiPaths = (s: Scene) => new Set([s.roi, ...s.parts.map((x) => x.roi)].filter((x): x is string => typeof x === "string"));
      const oldRoi = roiPaths(current);
      for (const rp of roiPaths(scene)) {
        if (oldRoi.has(rp)) continue;
        if (!fs.existsSync(resolveRoi(rp))) throw httpError(400, `region file not found: ${rp}`);
      }
      // Build info is written by build-scene.mjs only; never let a stale client overwrite it.
      const saved = { ...scene, build: current.build, buildAttempt: current.buildAttempt, updatedAt: new Date().toISOString() };
      writeAtomic(path.join(dir, SCENE_FILE), stringifyScene(saved));
      reply(res, 200, { ok: true, scene: saved, file: rel(path.join(dir, SCENE_FILE)) });
      return true;
    }
    if (p === "/__scenes/info" && m === "GET") {
      const dir = sceneDir(q.get("name"));
      const scene = readSceneFile(dir);
      reply(res, 200, { ok: true, parts: partInfo(dir, scene) });
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
    if (p === "/__scenes/roi" && m === "GET") {
      sceneDir(q.get("name"));
      const rp = q.get("path") ?? "";
      const abs = resolveRoi(rp);
      if (!fs.existsSync(abs)) throw httpError(404, `region file not found: ${rp}`);
      let json: unknown;
      try {
        json = JSON.parse(fs.readFileSync(abs, "utf8"));
      } catch (e) {
        throw httpError(422, `${rp} is not valid JSON: ${(e as Error).message}`);
      }
      reply(res, 200, { ok: true, path: rp, bytes: fs.statSync(abs).size, ...describeRoi(json, path.basename(abs)) });
      return true;
    }
    if (p === "/__scenes/roi" && m === "POST") {
      const name = q.get("name");
      const dir = sceneDir(name);
      if (!fs.existsSync(path.join(dir, SCENE_FILE))) throw httpError(404, "scene not found");
      // Keep the dropped file's name (readable in scene.json), made safe.
      const file = (q.get("file") ?? "").replace(/^.*[\\/]/, "").replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^[._ -]+/, "");
      const rp = `${ROI_DIR}/${name}/${file}`;
      if (!isSafeRoiPath(rp)) throw httpError(400, "invalid file name (expected <name>.json)");
      const buf = await readBody(req, MAX_ROI_BYTES);
      let json: unknown;
      try {
        json = JSON.parse(buf.toString("utf8"));
      } catch (e) {
        throw httpError(400, `${file} is not valid JSON: ${(e as Error).message}`);
      }
      if (!json || typeof json !== "object" || Array.isArray(json)) throw httpError(400, `${file} is not a JSON object`);
      const info = describeRoi(json, file);
      if (!info.outlines.some((o) => o.usable) && info.topLevel) throw httpError(422, `${file} holds no usable region: ${info.topLevel}`);
      const abs = resolveRoi(rp);
      // Which outlines the replaced copy had with other geometry (parts using them rebuild).
      let replaced = false;
      const changedOutlines: string[] = [];
      if (fs.existsSync(abs)) {
        replaced = true;
        try {
          const before = describeRoi(JSON.parse(fs.readFileSync(abs, "utf8")), file);
          for (const o of info.outlines) {
            const b = before.outlines.find((x) => x.name === o.name);
            if (b && b.digest !== o.digest) changedOutlines.push(o.name);
          }
        } catch {
          /* the old copy was unreadable: nothing to compare */
        }
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      writeAtomic(abs, buf.toString("utf8"));
      reply(res, 200, { ok: true, path: rp, bytes: buf.length, replaced, changedOutlines, ...info });
      return true;
    }
    if (p.startsWith("/__scene-source/") && (m === "GET" || m === "HEAD")) {
      // /__scene-source/<scene>/<part id>/<file name> (the file name is cosmetic: Spark infers the type from it)
      const [name, partId] = p.slice("/__scene-source/".length).split("/").map((s) => decodeURIComponent(s ?? ""));
      const dir = sceneDir(name);
      if (!isValidPartId(partId)) throw httpError(400, "invalid part id");
      const scene = readSceneFile(dir);
      const part = scene.parts.find((x) => x.id === partId);
      if (!part) throw httpError(404, `no part "${partId}" in scene "${name}"`);
      const abs = resolveSource(part.source);
      if (!abs) throw httpError(404, `source not found: ${part.source}`);
      serveFile(req, res, abs);
      return true;
    }
    if (p === "/__build" && m === "POST") {
      const body = await readJson(req);
      startBuild(body.name as string, { force: body.force, parts: body.parts });
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
      for (const row of build.parts) res.write(`event: part\ndata: ${JSON.stringify(row)}\n\n`);
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
