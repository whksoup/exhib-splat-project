/**
 * Device detection -> splat budget profile.
 *
 * Detection reuses Spark's own helpers in the same order as
 * SparkRenderer.defaultSplatTarget() (Oculus -> Vision Pro -> Android -> iOS ->
 * desktop), so the profile we display always matches the budget Spark picks
 * when lodSplatCount is left unset.
 */
import { isAndroid, isIos, isMobile, isOculus, isVisionPro } from "@sparkjsdev/spark";

export type DeviceProfileId = "desktop" | "iphone" | "android" | "quest" | "visionpro";

export interface DeviceProfile {
  id: DeviceProfileId;
  /** Spark's platform default for this class of device (splats drawn per frame). */
  defaultBudget: number;
  /** Upper bound we apply to devicePixelRatio unless ?pixelRatio= overrides. */
  maxPixelRatio: number;
  label: string;
}

// Budgets mirror SparkRenderer.defaultSplatTarget() in @sparkjsdev/spark 2.3.1.
export const PROFILES: Record<DeviceProfileId, DeviceProfile> = {
  desktop: { id: "desktop", defaultBudget: 2_500_000, maxPixelRatio: 2, label: "Desktop" },
  iphone: { id: "iphone", defaultBudget: 1_500_000, maxPixelRatio: 1.5, label: "iPhone / iOS" },
  android: { id: "android", defaultBudget: 1_000_000, maxPixelRatio: 1.5, label: "Android" },
  quest: { id: "quest", defaultBudget: 500_000, maxPixelRatio: 1, label: "Quest (Oculus Browser)" },
  visionpro: { id: "visionpro", defaultBudget: 750_000, maxPixelRatio: 1, label: "Vision Pro" },
};

export interface DeviceInfo {
  detected: DeviceProfileId;
  /** Profile actually used (differs from `detected` when forced via ?device=). */
  profile: DeviceProfile;
  forced: boolean;
  mobile: boolean;
  notes: string[];
}

export function detectDevice(): DeviceProfileId {
  if (isOculus()) return "quest";
  if (isVisionPro()) return "visionpro";
  if (isAndroid()) return "android";
  if (isIos()) return "iphone";
  return "desktop";
}

export function resolveDevice(forced?: DeviceProfileId): DeviceInfo {
  const detected = detectDevice();
  const notes: string[] = [];
  // iPadOS Safari reports a Mac UA by default; Spark then treats it as desktop.
  if (detected === "desktop" && /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) {
    notes.push("Looks like an iPad in desktop mode: Spark uses the desktop budget. Try ?device=iphone.");
  }
  const id = forced ?? detected;
  return {
    detected,
    profile: PROFILES[id],
    forced: forced !== undefined && forced !== detected,
    mobile: isMobile(),
    notes,
  };
}

/** Unmasked GPU string where the browser exposes it (useful in reports). */
export function gpuInfo(gl: WebGL2RenderingContext | WebGLRenderingContext): string {
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    return String(gl.getParameter(gl.RENDERER));
  } catch {
    return "unknown";
  }
}
