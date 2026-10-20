/**
 * Scene document -> viewer inputs (one model per part, navigation block, start camera).
 * Pure, unit tested in sceneConfig.test.ts.
 */
import { loadPlan, PREVIEW_SOURCE_CAP_BYTES, sourceFileName, type PartLoad, type SceneDoc } from "../../../shared/scene-schema.mjs";
import type { CameraSpec, ModelSpec } from "../config";
import type { NavigationConfigFile } from "../nav/navConfig";

/** URL of a file inside the scene folder (served by the /scenes/ mount). */
export function sceneFileUrl(name: string, rel: string): string {
  return `/scenes/${encodeURIComponent(name)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/** A part's built .rad. The query only busts caches after a rebuild; Spark resolves .radc chunk names against the path. */
export function builtPartUrl(scene: SceneDoc, partId: string): string | null {
  const b = scene.build?.parts?.find((p) => p.id === partId);
  if (!b) return null;
  const v = encodeURIComponent(b.finishedAt ?? scene.build?.finishedAt ?? "");
  return `${sceneFileUrl(scene.name, `build/${b.radFile}`)}?v=${v}`;
}

/** Unbuilt preview: a part's original source, served plain (non-paged) through the dev server. */
export function sourcePreviewUrl(scene: SceneDoc, partId: string): string {
  const part = scene.parts.find((p) => p.id === partId);
  const file = sourceFileName(part?.source ?? "");
  return `/__scene-source/${encodeURIComponent(scene.name)}/${encodeURIComponent(partId)}/${encodeURIComponent(file)}`;
}

/** What the dev server knows about a part's files (GET /__scenes/info). */
export interface PartFileInfo {
  id: string;
  source: string;
  exists: boolean;
  bytes: number | null;
  /** Splat count from the .ply header (null for other formats). */
  splats: number | null;
  builtOnDisk: boolean;
}

export interface ScenePlanOptions {
  /** Unbuilt sources above this total are not auto-loaded. */
  capBytes?: number;
  /** Parts the user asked to preview although the scene is over the cap. */
  previewParts?: string[];
}

export interface SceneModels {
  plan: ReturnType<typeof loadPlan>;
  models: ModelSpec[];
  /** built: every shown part streams a .rad; source: every shown part is a raw source; mixed; none: nothing to show. */
  mode: "built" | "source" | "mixed" | "none";
}

/**
 * Models to load for a scene: one per shown part, built .rad (paged) or the
 * source (whole), with the part's matrix inside Viewer.root (see loadPlan).
 * `info` from /__scenes/info; without it every recorded build is assumed on disk.
 */
export function sceneModels(scene: SceneDoc, info: PartFileInfo[] | null, o: ScenePlanOptions = {}): SceneModels {
  const byId = new Map((info ?? []).map((p) => [p.id, p]));
  const plan = loadPlan(scene, {
    builtOnDisk: (id: string) => (info ? !!byId.get(id)?.builtOnDisk : true),
    sourceBytes: info ? Object.fromEntries(info.map((p) => [p.id, p.exists ? p.bytes : null])) : undefined,
    capBytes: o.capBytes ?? PREVIEW_SOURCE_CAP_BYTES,
    previewParts: o.previewParts ?? null,
  });
  const models: ModelSpec[] = [];
  for (const p of plan.parts as PartLoad[]) {
    if (p.mode === "built") models.push({ id: p.id, url: builtPartUrl(scene, p.id) as string, paged: true, matrix: p.localMatrix });
    else if (p.mode === "source") models.push({ id: p.id, url: sourcePreviewUrl(scene, p.id), paged: false, matrix: p.localMatrix });
  }
  const kinds = new Set(plan.parts.filter((p) => p.mode === "built" || p.mode === "source").map((p) => p.mode));
  const mode = kinds.size === 0 ? "none" : kinds.size === 2 ? "mixed" : kinds.has("built") ? "built" : "source";
  return { plan, models, mode };
}

/** Preview cap from ?previewCapGB= (decimal GB), else the shared default (1.5 GB). */
export function previewCapBytes(search: string): number {
  const v = Number(new URLSearchParams(search).get("previewCapGB"));
  return Number.isFinite(v) && v > 0 ? v * 1e9 : PREVIEW_SOURCE_CAP_BYTES;
}

/**
 * The scene's `navigation` block as the viewer's NavigationConfigFile:
 * collision becomes a URL inside the scene folder, floorY feeds the fallback floor.
 */
export function sceneNavigation(scene: SceneDoc): NavigationConfigFile {
  const nav = { ...(scene.navigation ?? {}) } as NavigationConfigFile & { collision?: string };
  if (nav.collision) nav.collision = sceneFileUrl(scene.name, nav.collision);
  else delete nav.collision;
  if (typeof scene.floorY === "number") nav.fallbackFloorY = scene.floorY;
  return nav;
}

export function sceneCamera(scene: SceneDoc): CameraSpec | undefined {
  const c = scene.camera;
  if (!c) return undefined;
  return { position: [...c.position], target: [...c.target], ...(typeof c.fov === "number" && { fov: c.fov }) };
}
