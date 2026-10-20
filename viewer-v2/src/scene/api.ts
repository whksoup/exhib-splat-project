/**
 * Client for the dev-server scene endpoints (dev-server/scenes.ts has the full list).
 * Every call throws an Error with the server's message on failure.
 */
import type { SceneDoc } from "../../../shared/scene-schema.mjs";

export interface SceneListEntry {
  name: string;
  error?: string;
  source?: string;
  sourceExists?: boolean;
  built?: boolean;
  build?: { finishedAt: string; radFile: string; splatCount: { input: number | null; final: number | null } | null; wallClockSeconds: number | null } | null;
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

export interface BuildStatus {
  running: boolean;
  id: number;
  name: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  progress: { stage: string; pct: number; message: string } | null;
  result: { status: string; error: string | null } | null;
  exitCode: number | null;
  lines: string[];
  /** A build started outside this dev server (build-scene.bat), seen through scenes/.build.lock. */
  external: { scene: string; pid: number; startedAt: string } | null;
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
  create: (name: string, source: string) => post<{ scene: SceneDoc }>("/__scenes/create", { name, source }),
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
  build: (name: string) => post<BuildStatus>("/__build", { name }),
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
