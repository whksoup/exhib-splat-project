/**
 * Client for the dev-server scene endpoints (dev-server/scenes.ts has the full list).
 * Every call throws an Error with the server's message on failure.
 */
import type { SceneDoc } from "../../../shared/scene-schema.mjs";
import type { PartFileInfo } from "./sceneConfig";

export interface SceneListEntry {
  name: string;
  error?: string;
  /** Source of the first part (cards show it; `parts` has them all). */
  source?: string;
  parts?: { id: string; source: string; enabled: boolean; sourceExists: boolean; state: string }[];
  /** Every enabled part's source exists. */
  sourceExists?: boolean;
  /** At least one part's .rad is on disk. */
  built?: boolean;
  summary?: { total: number; enabled: number; built: number; outdated: number; notBuilt: number; complete: boolean };
  build?: { finishedAt: string; status: string; splatCount: { input: number | null; final: number | null } | null; wallClockSeconds: number | null; peakMemoryBytes: number | null } | null;
  buildAttempt?: { status: "ok" | "failed"; startedAt: string; finishedAt: string; error: string | null } | null;
  transformChanged?: boolean;
  navWarning?: boolean;
  navFiles?: number;
  updatedAt?: string | null;
  building?: boolean;
}

export interface NavFile {
  file: string;
  bytes: number;
}

/** One part's state in the running build (from build-scene.mjs @part / @progress lines). */
export interface BuildPartStatus {
  id: string;
  index: number;
  count: number;
  status: string;
  pct?: number;
  seconds?: number;
  peakMemoryBytes?: number | null;
  error?: string;
  reason?: string;
}

export interface BuildProgress {
  stage: string;
  pct: number;
  message: string;
  part?: { id: string; index: number; count: number; pct: number };
}

export interface BuildStatus {
  running: boolean;
  id: number;
  name: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  progress: BuildProgress | null;
  parts: BuildPartStatus[];
  result: { status: string; error: string | null } | null;
  exitCode: number | null;
  lines: string[];
  /** A build started outside this dev server (build-scene.bat), seen through scenes/.build.lock. */
  external: { scene: string; pid: number; startedAt: string } | null;
}

/** One outline saved in a Spirula ROI region file (its editor block). */
export interface RoiOutline {
  name: string;
  /** Enabled in the ROI editor when the file was saved. */
  enabled: boolean;
  /** A build can crop to it; otherwise `error` says why. */
  usable: boolean;
  error?: string;
}

/** A region file in assets/roi/<scene>/ as the dev server reads it. */
export interface RoiFileInfo {
  path: string;
  bytes: number;
  type: string | null;
  /** Why the top-level region does not read (null: it does). */
  topLevel: string | null;
  outlines: RoiOutline[];
  /** Upload only: a previous copy was replaced, and these outlines' geometry changed. */
  replaced?: boolean;
  changedOutlines?: string[];
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch (err) {
    throw new Error(`Dev server unreachable (${(err as Error).message})`);
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new Error(`${url}: HTTP ${res.status} (not the viewer-v2 dev server?)`);
  const body = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

const post = <T>(url: string, body: unknown) =>
  call<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const api = {
  list: () => call<{ scenes: SceneListEntry[] }>("/__scenes").then((r) => r.scenes),
  sources: () => call<{ files: { path: string; bytes: number }[]; dir: string }>("/__scenes/sources"),
  create: (name: string, sources: string[]) => post<{ scene: SceneDoc }>("/__scenes/create", { name, sources }),
  /** Per-part source sizes / splat counts and whether each part's .rad is on disk. */
  info: (name: string) => call<{ parts: PartFileInfo[] }>(`/__scenes/info?${q({ name })}`).then((r) => r.parts),
  duplicate: (from: string, name: string) => post<{ scene: SceneDoc }>("/__scenes/duplicate", { from, name }),
  remove: (name: string, confirm: string) => post<{ deleted: string }>("/__scenes/delete", { name, confirm }),
  save: (scene: SceneDoc) =>
    call<{ scene: SceneDoc; file: string }>(`/__scenes/save?${q({ name: scene.name })}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scene),
    }),
  navFiles: (name: string) => call<{ files: NavFile[] }>(`/__scenes/nav?${q({ name })}`).then((r) => r.files),
  uploadNavFile: (name: string, file: string, blob: Blob) =>
    call<{ file: string; bytes: number }>(`/__scenes/nav-file?${q({ name, file })}`, { method: "POST", body: blob }),
  /** Outlines of a region file (path = assets/roi/<scene>/<file>.json). */
  roi: (name: string, path: string) => call<RoiFileInfo>(`/__scenes/roi?${q({ name, path })}`),
  /** Copy a dropped region file to assets/roi/<scene>/<file> (scene.json is not touched). */
  uploadRoi: (name: string, file: string, blob: Blob) =>
    call<RoiFileInfo>(`/__scenes/roi?${q({ name, file })}`, { method: "POST", body: blob }),
  build: (name: string, o: { force?: boolean; parts?: string[] } = {}) => post<BuildStatus>("/__build", { name, ...o }),
  buildStatus: () => call<BuildStatus>("/__build/status"),
  cancelBuild: () => post<{ ok: boolean }>("/__build/cancel", {}),
};

/** scene.json straight from the /scenes/ mount (the file as saved). */
export async function fetchSceneJson(name: string): Promise<unknown> {
  const res = await fetch(`/scenes/${encodeURIComponent(name)}/scene.json`, { cache: "no-store" });
  if (res.status === 404) throw new Error(`Scene "${name}" not found (no scenes/${name}/scene.json)`);
  if (!res.ok) throw new Error(`scenes/${name}/scene.json: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`scenes/${name}/scene.json is not valid JSON`);
  }
}

/** HEAD a URL: true when the file exists (used to check the built .rad is really on disk). */
export async function urlExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}
