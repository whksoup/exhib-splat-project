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
  /** Centre of the artwork's volume; `radius` is its enclosing sphere. */
  center: Vec3;
  radius: number;
  /**
   * The artwork's box around `center`: three unit axes and half sizes along
   * them. A wall-mounted artwork is a plane (third half size 0). Without a box
   * the sphere is used.
   */
  box?: { axes: [Vec3, Vec3, Vec3]; half: Vec3 };
  mount?: "object" | "wall";
}

export const PREVIEW_DEFAULTS = Object.freeze({ angleDeg: 8, dwellMs: 250, departureMs: 350 });

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** A point in the box's own axes, relative to its centre. */
function toLocal(work: WalkWork, p: Vec3): Vec3 {
  const d = sub(p, work.center), [a, b, c] = work.box!.axes;
  return [dot(d, a), dot(d, b), dot(d, c)];
}

/** The point of the artwork's volume nearest to `p`. */
export function closestPoint(work: WalkWork, p: Vec3): Vec3 {
  if (!work.box) {
    const d = sub(p, work.center), l = len(d);
    return l <= work.radius ? p : add(work.center, d, work.radius / l);
  }
  const q = toLocal(work, p), h = work.box.half, [a, b, c] = work.box.axes;
  const k = q.map((v, i) => Math.max(-h[i], Math.min(h[i], v))) as Vec3;
  return add(add(add(work.center, a, k[0]), b, k[1]), c, k[2]);
}

/** Distance from the eye to the artwork's surface (0 inside it). */
export function surfaceDistance(eye: Vec3, work: WalkWork): number {
  if (!work.box) return Math.max(0, len(sub(work.center, eye)) - work.radius);
  return len(sub(closestPoint(work, eye), eye));
}

/** Does the ray from `eye` along unit `dir` go through the artwork's box (a plane counts)? */
function rayHitsBox(eye: Vec3, dir: Vec3, work: WalkWork): boolean {
  const o = toLocal(work, eye), [a, b, c] = work.box!.axes, d: Vec3 = [dot(dir, a), dot(dir, b), dot(dir, c)];
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const h = Math.max(work.box!.half[i], 1e-6);
    if (Math.abs(d[i]) < 1e-12) {
      if (Math.abs(o[i]) > h) return false;
      continue;
    }
    let ta = (-h - o[i]) / d[i], tb = (h - o[i]) / d[i];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * How far (radians) the ray from `eye` along unit `dir` misses the artwork's
 * sphere, measured as an angle: 0 when the ray goes through it.
 */
export function lookOffset(eye: Vec3, dir: Vec3, work: WalkWork): number {
  if (work.box) {
    if (rayHitsBox(eye, dir, work)) return 0;
    // How far off the view is: the angle to the box's nearest point to the ray, taken level with the box centre.
    const along = Math.max(0, dot(sub(work.center, eye), dir));
    const q = sub(closestPoint(work, add(eye, dir, along)), eye), l = len(q);
    return l < 1e-9 ? 0 : Math.acos(Math.max(-1, Math.min(1, dot(q, dir) / l)));
  }
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
export function createPreviewTracker(tuning: { angleDeg?: number; dwellMs?: number; departureMs?: number } = {}) {
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
    const b = o.box as { axes?: unknown; half?: unknown } | undefined;
    const box =
      b && Array.isArray(b.axes) && b.axes.length === 3 && b.axes.every(vec3) && vec3(b.half) && b.half.every((h) => h >= 0)
        ? { axes: b.axes as [Vec3, Vec3, Vec3], half: b.half }
        : undefined;
    const mount = o.mount === "wall" ? "wall" : "object";
    out.push({ id: o.id.slice(0, 200), title: text(o.title, 300) || o.id, artist: text(o.artist, 300), summary: text(o.summary, 1000), anchor: o.anchor, center: o.center, radius: o.radius, ...(box && { box, mount }) });
  }
  return out;
}
