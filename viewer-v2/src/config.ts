/**
 * Viewer configuration: an optional JSON file (?config=...) overlaid by URL
 * query parameters. URL params always win so a tester can tweak one value
 * without editing the JSON.
 *
 * Phase 3 (tour) will extend ViewerConfigFile with `viewpoints` / `hotspots`;
 * Phase 4 (WebXR) with an `xr` block. Unknown keys are ignored here.
 */
import type { DeviceProfileId } from "./device";
import {
  navStartsFirstPerson,
  resolveNavigationConfig,
  type NavigationConfig,
  type NavigationConfigFile,
} from "./nav/navConfig";

export type Vec3 = [number, number, number];

export interface ModelSpec {
  url: string;
  /** Stream with Spark's paged loader. Default: true for .rad, false otherwise. */
  paged?: boolean;
  /** Build an LoD tree in the browser for plain files (.ply/.spz/.sog). */
  lod?: boolean | "quality";
  /** Force a file type when it can't be inferred (e.g. "ply", "spz", "pcsogszip", "rad"). */
  fileType?: string;
  /** Per-mesh LoD detail multiplier (SplatMesh.lodScale). */
  lodScale?: number;
}

export interface CameraSpec {
  position: Vec3;
  target: Vec3;
  fov?: number;
}

/** "walk" = first-person collision navigation (src/nav/); "fly" = Spark debug fly (no collision). */
export type ControlsMode = "orbit" | "fly" | "walk";

export interface ViewerConfig {
  models: ModelSpec[];
  camera?: CameraSpec;
  /** Force a device profile (testing a phone budget on desktop, etc.). */
  device?: DeviceProfileId;
  /** Base splat budget -> SparkRenderer.lodSplatCount. Unset = Spark platform default. */
  budget?: number;
  /** Budget multiplier -> SparkRenderer.lodSplatScale. */
  lodScale?: number;
  /** Renderer pixel ratio. Unset = devicePixelRatio capped per profile. */
  pixelRatio?: number;
  /** SparkRenderer.maxStdDev (default sqrt(8); sqrt(5) suggested for Quest). */
  maxStdDev?: number;
  /** SparkRenderer.lodRenderScale (min splat pixel size, default 1). */
  lodRenderScale?: number;
  /** SparkRenderer.pagedExtSplats (paged) / SplatMesh.extSplats (plain files). */
  extSplats?: boolean;
  controls: ControlsMode;
  /** First-person collision navigation (src/nav/navConfig.ts). */
  navigation: NavigationConfig;
  overlay: boolean;
  /** How long Spark must stay idle before LoD counts as "settled". */
  settleWindowMs: number;
  /** Where the JSON config came from, if any (echoed into results). */
  configUrl?: string;
}

/** Shape of the optional JSON file. Everything optional; URL params override. */
export interface ViewerConfigFile extends Partial<Omit<ViewerConfig, "models" | "navigation">> {
  navigation?: NavigationConfigFile;
  models?: (ModelSpec | string)[];
  model?: string;
}

const DEVICE_IDS: DeviceProfileId[] = ["desktop", "iphone", "android", "quest", "visionpro"];

function num(v: string | null): number | undefined {
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Accepts plain numbers plus "1.5M" / "500k" shorthand. */
function count(v: string | null): number | undefined {
  if (v === null) return undefined;
  const m = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(v);
  if (!m) return num(v);
  const base = Number(m[1]);
  const mult = m[2].toLowerCase() === "m" ? 1e6 : m[2].toLowerCase() === "k" ? 1e3 : 1;
  return Number.isFinite(base) ? Math.round(base * mult) : undefined;
}

function bool(v: string | null): boolean | undefined {
  if (v === null) return undefined;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

function vec3(v: string | null): Vec3 | undefined {
  if (!v) return undefined;
  const parts = v.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return [parts[0], parts[1], parts[2]];
}

/** "Math.sqrt(5)"-style values are awkward in URLs, so accept "sqrt5" too. */
function stdDev(v: string | null): number | undefined {
  if (!v) return undefined;
  const m = /^sqrt\(?([\d.]+)\)?$/i.exec(v.trim());
  return m ? Math.sqrt(Number(m[1])) : num(v);
}

export function isRadUrl(url: string): boolean {
  return /\.rad(?:$|[?#])/i.test(url);
}

function normalizeModel(m: ModelSpec | string): ModelSpec {
  return typeof m === "string" ? { url: m } : { ...m };
}

/**
 * @param base  config to start from instead of a ?config= file (the scene editor
 *              passes the scene's model, camera and navigation here). URL params still win.
 */
export async function loadConfig(search = window.location.search, base?: ViewerConfigFile): Promise<ViewerConfig> {
  const q = new URLSearchParams(search);
  let file: ViewerConfigFile = base ? { ...base } : {};
  const configUrl = base ? undefined : (q.get("config") ?? undefined);
  if (configUrl) {
    const res = await fetch(configUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`Config "${configUrl}" failed to load: HTTP ${res.status}`);
    file = (await res.json()) as ViewerConfigFile;
  }

  // Models: ?model= may repeat (one SplatMesh per zone). URL replaces file list.
  const urlModels = q.getAll("model").filter(Boolean);
  let models: ModelSpec[] = urlModels.length
    ? urlModels.map((url) => ({ url }))
    : (file.models ?? (file.model ? [file.model] : [])).map(normalizeModel);

  // Per-model URL overrides apply to every model loaded via the URL.
  const paged = bool(q.get("paged"));
  const lodParam = q.get("lod");
  const lod = lodParam === "quality" ? "quality" : bool(lodParam);
  const fileType = q.get("type") ?? undefined;
  const meshLodScale = num(q.get("meshLodScale"));
  models = models.map((m) => ({
    ...m,
    ...(paged !== undefined && { paged }),
    ...(lod !== undefined && { lod }),
    ...(fileType && { fileType }),
    ...(meshLodScale !== undefined && { lodScale: meshLodScale }),
  }));

  const camPos = vec3(q.get("cam"));
  const camTarget = vec3(q.get("target"));
  const fov = num(q.get("fov"));
  let camera: CameraSpec | undefined = file.camera ? { ...file.camera } : undefined;
  if (camPos || camTarget) {
    camera = {
      position: camPos ?? camera?.position ?? [0, 0, 3],
      target: camTarget ?? camera?.target ?? [0, 0, 0],
      fov: camera?.fov,
    };
  }
  if (camera && fov !== undefined) camera.fov = fov;

  const deviceParam = q.get("device") as DeviceProfileId | null;
  const device = deviceParam && DEVICE_IDS.includes(deviceParam) ? deviceParam : file.device;
  const controlsParam = q.get("controls");
  const controls: ControlsMode =
    controlsParam === "fly" || controlsParam === "orbit" || controlsParam === "walk"
      ? controlsParam
      : q.get("nav") === "walk" || q.get("nav") === "fly"
        ? "walk"
        : (file.controls ?? (navStartsFirstPerson(file.navigation, q) ? "walk" : "orbit"));

  return {
    models,
    camera,
    device,
    budget: count(q.get("budget")) ?? file.budget,
    lodScale: num(q.get("lodScale")) ?? file.lodScale,
    pixelRatio: num(q.get("pixelRatio")) ?? file.pixelRatio,
    maxStdDev: stdDev(q.get("maxStdDev")) ?? file.maxStdDev,
    lodRenderScale: num(q.get("lodRenderScale")) ?? file.lodRenderScale,
    extSplats: bool(q.get("extSplats")) ?? file.extSplats,
    controls,
    navigation: resolveNavigationConfig(file.navigation, q),
    overlay: bool(q.get("overlay")) ?? file.overlay ?? true,
    settleWindowMs: num(q.get("settleMs")) ?? file.settleWindowMs ?? 1500,
    configUrl,
  };
}
