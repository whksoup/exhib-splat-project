/**
 * Per-browser view settings (localStorage) set by the editor's top-bar sliders
 * and read by the viewer at start-up: the page pool has to be sized from the
 * detail setting before the first streamed part loads. URL parameters win.
 */
export const PREF_CAMERA_SPEED = "viewer-v2.cameraSpeed";
export const PREF_DETAIL = "viewer-v2.detail";

export function readPref(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function writePref(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* private mode / blocked storage: the setting still applies to this page */
  }
}

/** Spark's page size: the paged pool holds whole 65,536-splat chunks. */
export const PAGE_SPLATS = 65536;
/** Spark's desktop default pool (16.7M splats). */
export const DEFAULT_DESKTOP_PAGES = 256;
/** Largest pool the detail setting asks for on its own (50M splats; ?pages= can go higher). */
export const MAX_AUTO_PAGES = 768;

/**
 * Pool pages for a detail (lodSplatScale) setting on desktop. Chunks are
 * streamed whole, so the resident set is several times the drawn frontier
 * (201 of 256 pages for a 2.5M frontier on HighRezOculus): the pool grows with
 * the budget so raising Detail is not capped by a full pool.
 */
export function poolPagesFor(detail: number): number {
  return Math.min(MAX_AUTO_PAGES, Math.max(DEFAULT_DESKTOP_PAGES, Math.round(DEFAULT_DESKTOP_PAGES * detail)));
}
