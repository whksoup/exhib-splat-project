/**
 * Artwork targeting for the embedded exhibition walk, pure (no DOM, no three).
 * Ported from the exhibition's old walk (dist/oculus-walk-prototype/targeting.js):
 * the same look angle, dwell and departure, with artworks as spheres because
 * the splat has no artwork meshes to ray-cast.
 *
 * All positions and distances are in world (viewer) units.
 */
export type Vec3 = [number, number, number];

/** An artwork in the walk, as the host sends it (already in this build's frame). */
export interface WalkWork {
  id: string;
  title: string;
  artist?: string;
  /** One or two sentences for the in-view card. */
  summary?: string;
  /** Where the marker is drawn. */
  anchor: Vec3;
  /** Centre and radius of a sphere around the artwork, for looking at and picking it. */
  center: Vec3;
  radius: number;
}

export const PREVIEW_DEFAULTS = Object.freeze({ angleDeg: 8, dwellMs: 250, departureMs: 350 });

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Distance from the eye to the artwork's surface (0 inside it). */
export function surfaceDistance(eye: Vec3, work: WalkWork): number {
  return Math.max(0, len(sub(work.center, eye)) - work.radius);
}

/**
 * How far (radians) the ray from `eye` along unit `dir` misses the artwork's
 * sphere, measured as an angle: 0 when the ray goes through it.
 */
export function lookOffset(eye: Vec3, dir: Vec3, work: WalkWork): number {
  const to = sub(work.center, eye);
  const d = len(to);
  if (d <= work.radius) return 0;
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(to, dir) / d)));
  return Math.max(0, angle - Math.asin(work.radius / d));
}

/** The artwork the ray goes through, nearest first, within `range` of its surface; else null. */
export function pickWork(eye: Vec3, dir: Vec3, works: readonly WalkWork[], range: number): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const w of works) {
    if (lookOffset(eye, dir, w) > 0) continue;
    const d = surfaceDistance(eye, w);
    if (d <= range && d < bestD) {
      best = w.id;
      bestD = d;
    }
  }
  return best;
}

/** The artwork closest to the centre of the view within `angle` (radians) and `range`; else null. */
export function previewCandidate(eye: Vec3, dir: Vec3, works: readonly WalkWork[], angle: number, range: number): string | null {
  let best: string | null = null;
  let bestA = angle;
  for (const w of works) {
    if (surfaceDistance(eye, w) > range) continue;
    const a = lookOffset(eye, dir, w);
    if (a < bestA || (a === 0 && bestA === 0)) {
      best = w.id;
      bestA = a;
    }
  }
  return best;
}

/** Markers shrink as they leave the centre of the view (old walk: artworkWidgetScale). */
export function widgetScale(lookAngle: number): number {
  const falloffAngle = (18 * Math.PI) / 180;
  const t = Math.min(1, Math.max(0, lookAngle / falloffAngle));
  return 1.12 - 0.38 * t * t * (3 - 2 * t);
}

/** Holds the in-view card steady: a new artwork must stay in view `dwellMs`, a lost one is kept `departureMs`. */
export function createPreviewTracker(tuning: Partial<typeof PREVIEW_DEFAULTS> = {}) {
  const t = { ...PREVIEW_DEFAULTS, ...tuning };
  let candidate: string | null = null;
  let since = 0;
  let selected: string | null = null;
  let departed: number | null = null;
  return {
    update(id: string | null, now: number): string | null {
      if (id !== candidate) {
        candidate = id;
        since = now;
      }
      if (id === selected && id) departed = null;
      else if (departed === null) departed = now;
      if (id && now - since >= t.dwellMs) {
        selected = id;
        departed = null;
      } else if (selected && departed !== null && now - departed >= t.departureMs) selected = null;
      return selected;
    },
    reset(id: string | null = null): void {
      candidate = null;
      selected = id;
      departed = null;
      since = 0;
    },
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const vec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(finite);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Works from the host, checked (it may be another origin over postMessage); malformed entries are dropped. */
export function parseWorks(input: unknown): WalkWork[] {
  if (!Array.isArray(input)) return [];
  const out: WalkWork[] = [];
  for (const w of input.slice(0, 200)) {
    if (!w || typeof w !== "object") continue;
    const o = w as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || !vec3(o.anchor) || !vec3(o.center) || !finite(o.radius) || o.radius < 0) continue;
    out.push({ id: o.id.slice(0, 200), title: text(o.title, 300) || o.id, artist: text(o.artist, 300), summary: text(o.summary, 1000), anchor: o.anchor, center: o.center, radius: o.radius });
  }
  return out;
}
