/**
 * Scene document -> viewer inputs (model URL, navigation block, start camera).
 * Pure, unit tested in sceneConfig.test.ts.
 */
import type { SceneDoc } from "../../../shared/scene-schema.mjs";
import type { CameraSpec, ModelSpec } from "../config";
import type { NavigationConfigFile } from "../nav/navConfig";

/** URL of a file inside the scene folder (served by the /scenes/ mount). */
export function sceneFileUrl(name: string, rel: string): string {
  return `/scenes/${encodeURIComponent(name)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

export function builtRadUrl(scene: SceneDoc): string | null {
  if (!scene.build) return null;
  // The query only busts caches after a rebuild; Spark resolves .radc chunk names against the path.
  const v = encodeURIComponent(scene.build.finishedAt ?? "");
  return `${sceneFileUrl(scene.name, `build/${scene.build.radFile}`)}?v=${v}`;
}

/** Unbuilt preview: the original source, served plain (non-paged) through the dev server. */
export function sourcePreviewUrl(scene: SceneDoc): string {
  const file = scene.source.slice(scene.source.lastIndexOf("/") + 1);
  return `/__scene-source/${encodeURIComponent(scene.name)}/${encodeURIComponent(file)}`;
}

export interface SceneModelChoice {
  mode: "built" | "source";
  model: ModelSpec;
}

/** Which file to load: the built paged .rad when it exists, else the source (whole file, no paging). */
export function sceneModel(scene: SceneDoc, builtAvailable: boolean): SceneModelChoice {
  const rad = builtAvailable ? builtRadUrl(scene) : null;
  if (rad) return { mode: "built", model: { url: rad, paged: true } };
  return { mode: "source", model: { url: sourcePreviewUrl(scene), paged: false } };
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
