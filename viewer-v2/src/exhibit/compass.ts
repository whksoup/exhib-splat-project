/**
 * The walk's compass strip: where each artwork lies around the visitor, as
 * in open-world games. The strip shows `span` degrees either side of the view
 * direction; an artwork outside it is pinned to the nearer edge. Icons grow as
 * the visitor gets closer. Pure (tested in compass.test.ts); layer.ts draws it.
 */
import { closestPoint, type Vec3, type WalkWork } from "./targeting";

export const COMPASS_TUNING = Object.freeze({
  /** Degrees shown either side of the view direction. */
  spanDeg: 75,
  /** Metres: full size at or under `near`, smallest at or beyond `far`. */
  near: 3,
  far: 40,
  minScale: 0.55,
  maxScale: 1.35,
  /** An artwork within this many degrees of the centre shows its name and distance. */
  centreDeg: 6,
  /** Artworks further than this (metres) are left off. */
  range: 80,
});

export interface CompassItem {
  id: string;
  /** -1 (left edge) to 1 (right edge). */
  x: number;
  /** Bearing from the view direction, degrees, positive to the right. */
  bearing: number;
  /** Metres to the artwork's nearest surface. */
  distance: number;
  scale: number;
  /** Outside the strip, pinned to its edge. */
  pinned: boolean;
  /** Nearest the centre, within `centreDeg`: shows its name and distance. */
  centred: boolean;
}

/** Degrees, positive to the right, from the horizontal view direction `dir` to the point `p`. */
export function bearingTo(eye: Vec3, dir: Vec3, p: Vec3): number {
  const f = Math.atan2(dir[0], -dir[2]);
  const t = Math.atan2(p[0] - eye[0], -(p[2] - eye[2]));
  let d = ((t - f) * 180) / Math.PI;
  d = ((((d + 180) % 360) + 360) % 360) - 180;
  return d;
}

/** Icon size for a distance in metres: smoothstep from maxScale (near) to minScale (far). */
export function compassScale(metres: number, t: typeof COMPASS_TUNING = COMPASS_TUNING): number {
  const k = Math.min(1, Math.max(0, (metres - t.near) / (t.far - t.near)));
  return t.maxScale - (t.maxScale - t.minScale) * k * k * (3 - 2 * k);
}

/**
 * The strip's items. `metresPerUnit` turns this build's units into metres;
 * the bearing uses the artwork's centre, the distance its nearest surface.
 */
export function compassItems(eye: Vec3, dir: Vec3, works: WalkWork[], metresPerUnit = 1, t: typeof COMPASS_TUNING = COMPASS_TUNING): CompassItem[] {
  const items: CompassItem[] = [];
  for (const w of works) {
    const q = closestPoint(w, eye);
    const distance = Math.hypot(q[0] - eye[0], q[1] - eye[1], q[2] - eye[2]) * metresPerUnit;
    if (distance > t.range) continue;
    const bearing = bearingTo(eye, dir, w.center);
    const pinned = Math.abs(bearing) > t.spanDeg;
    items.push({ id: w.id, x: Math.max(-1, Math.min(1, bearing / t.spanDeg)), bearing, distance, scale: compassScale(distance, t), pinned, centred: false });
  }
  let best: CompassItem | null = null;
  for (const i of items) if (Math.abs(i.bearing) <= t.centreDeg && (!best || Math.abs(i.bearing) < Math.abs(best.bearing))) best = i;
  if (best) best.centred = true;
  // Nearer icons draw on top.
  return items.sort((a, b) => b.distance - a.distance);
}

/** Tick marks for the strip: every `stepDeg` of heading, as x in -1..1, `major` every 45°. */
export function compassTicks(dir: Vec3, stepDeg = 15, t: typeof COMPASS_TUNING = COMPASS_TUNING): { x: number; major: boolean }[] {
  const heading = (Math.atan2(dir[0], -dir[2]) * 180) / Math.PI;
  const out: { x: number; major: boolean }[] = [];
  const first = Math.ceil((heading - t.spanDeg) / stepDeg) * stepDeg;
  for (let a = first; a <= heading + t.spanDeg + 1e-9; a += stepDeg) {
    const m = ((Math.round(a) % 45) + 45) % 45 === 0;
    out.push({ x: (a - heading) / t.spanDeg, major: m });
  }
  return out;
}
