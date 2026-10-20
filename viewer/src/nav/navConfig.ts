/**
 * Navigation config: the `navigation` block of the viewer JSON plus URL
 * overrides. Pure (no DOM), so it is unit-testable.
 *
 * Units are metres and degrees. World is three.js Y-up, gravity -Y.
 */

export type NavMode = "walk" | "fly";

export interface NavPose {
  /**
   * Eye (camera) position in world coordinates. In walk mode the player is
   * dropped onto the first walkable surface below `position.y + 0.1`, so a
   * point at floor level works as well as one at eye height.
   */
  position: [number, number, number];
  /** Degrees. 0 looks down -Z, positive turns left (counter-clockwise seen from above). */
  yaw?: number;
  /** Degrees. Positive looks up. Clamped to +-89. */
  pitch?: number;
}

export interface NavigationConfig {
  /** Collision GLB URL (e.g. "/nav/office/v1/collision.glb"). Unset = flat fallback floor. */
  collision?: string;
  /** Player movement mode when the first-person ("walk") controls are active. */
  mode: NavMode;
  /** Flying is fully built but blocked unless this is true. */
  allowFly: boolean;
  allowJump: boolean;
  /** Camera height above the feet. */
  eyeHeight: number;
  /** Capsule radius. */
  radius: number;
  /** Capsule total height (feet to top of head). */
  height: number;
  /** Highest ledge the player walks up without jumping (stairs). */
  stepHeight: number;
  /** Steepest walkable surface. */
  maxSlopeDeg: number;
  walkSpeed: number;
  runSpeed: number;
  flySpeed: number;
  /** Fly-mode run multiplier (Shift). */
  flyRunMultiplier: number;
  /** Initial upward speed of a jump (m/s), only when allowJump. */
  jumpSpeed: number;
  gravity: number;
  /** Optional ceiling plane for flying: the top of the capsule never goes above this Y. */
  maxHeight?: number;
  /** Floor height used when no collision GLB is configured or it failed to load. */
  fallbackFloorY: number;
  /** Below this Y the player respawns. Unset = 20 m below the lowest collider (or fallback floor). */
  killY?: number;
  /** Mouse-look sensitivity, degrees per pixel. */
  lookSensitivity: number;
  /** Start viewpoint for the player. Unset = derived from `camera`, else the collision bounds centre. */
  spawn?: NavPose;
  /** Show the collider wireframe + capsule gizmo at start (toggle with N). */
  debug: boolean;
}

/** JSON shape: everything optional. */
export type NavigationConfigFile = Partial<NavigationConfig>;

export const NAV_DEFAULTS: NavigationConfig = {
  mode: "walk",
  allowFly: false,
  allowJump: false,
  eyeHeight: 1.6,
  radius: 0.3,
  height: 1.8,
  stepHeight: 0.35,
  maxSlopeDeg: 45,
  walkSpeed: 1.6,
  runSpeed: 3.6,
  flySpeed: 3,
  flyRunMultiplier: 2.5,
  jumpSpeed: 4,
  gravity: 9.81,
  fallbackFloorY: 0,
  lookSensitivity: 0.15,
  debug: false,
};

function num(v: string | null): number | undefined {
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function bool(v: string | null): boolean | undefined {
  if (v === null) return undefined;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

function vec3(v: string | null): [number, number, number] | undefined {
  if (!v) return undefined;
  const p = v.split(",").map((s) => Number(s.trim()));
  return p.length === 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2]] : undefined;
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Merge defaults <- JSON `navigation` block <- URL params.
 *
 * URL params: collision, nav (walk|fly), allowFly, allowJump, eyeHeight,
 * radius, height, stepHeight, maxSlope, walkSpeed, runSpeed, flySpeed,
 * maxHeight, floorY, killY, spawn (x,y,z), spawnYaw, spawnPitch, navDebug.
 */
export function resolveNavigationConfig(
  file: NavigationConfigFile | undefined,
  q: URLSearchParams,
): NavigationConfig {
  const f = file ?? {};
  const d = NAV_DEFAULTS;
  const navParam = q.get("nav");
  const mode: NavMode =
    navParam === "walk" || navParam === "fly" ? navParam : f.mode === "fly" || f.mode === "walk" ? f.mode : d.mode;

  const collisionParam = q.get("collision");
  // "?collision=" (empty) or "none" disables a collision file set in the JSON.
  const collision =
    collisionParam !== null ? (collisionParam === "" || collisionParam === "none" ? undefined : collisionParam) : f.collision;

  let spawn: NavPose | undefined = f.spawn && vec3OK(f.spawn.position) ? { ...f.spawn } : undefined;
  const spawnPos = vec3(q.get("spawn"));
  if (spawnPos) spawn = { ...spawn, position: spawnPos };
  const spawnYaw = num(q.get("spawnYaw"));
  const spawnPitch = num(q.get("spawnPitch"));
  if (spawn && spawnYaw !== undefined) spawn.yaw = spawnYaw;
  if (spawn && spawnPitch !== undefined) spawn.pitch = spawnPitch;

  const cfg: NavigationConfig = {
    collision,
    mode,
    allowFly: bool(q.get("allowFly")) ?? f.allowFly ?? d.allowFly,
    allowJump: bool(q.get("allowJump")) ?? f.allowJump ?? d.allowJump,
    eyeHeight: num(q.get("eyeHeight")) ?? finiteOr(f.eyeHeight, d.eyeHeight),
    radius: num(q.get("radius")) ?? finiteOr(f.radius, d.radius),
    height: num(q.get("height")) ?? finiteOr(f.height, d.height),
    stepHeight: num(q.get("stepHeight")) ?? finiteOr(f.stepHeight, d.stepHeight),
    maxSlopeDeg: num(q.get("maxSlope")) ?? finiteOr(f.maxSlopeDeg, d.maxSlopeDeg),
    walkSpeed: num(q.get("walkSpeed")) ?? finiteOr(f.walkSpeed, d.walkSpeed),
    runSpeed: num(q.get("runSpeed")) ?? finiteOr(f.runSpeed, d.runSpeed),
    flySpeed: num(q.get("flySpeed")) ?? finiteOr(f.flySpeed, d.flySpeed),
    flyRunMultiplier: finiteOr(f.flyRunMultiplier, d.flyRunMultiplier),
    jumpSpeed: finiteOr(f.jumpSpeed, d.jumpSpeed),
    gravity: finiteOr(f.gravity, d.gravity),
    maxHeight: num(q.get("maxHeight")) ?? (typeof f.maxHeight === "number" ? f.maxHeight : undefined),
    fallbackFloorY: num(q.get("floorY")) ?? finiteOr(f.fallbackFloorY, d.fallbackFloorY),
    killY: num(q.get("killY")) ?? (typeof f.killY === "number" ? f.killY : undefined),
    lookSensitivity: finiteOr(f.lookSensitivity, d.lookSensitivity),
    spawn,
    debug: bool(q.get("navDebug")) ?? f.debug ?? d.debug,
  };
  return sanitize(cfg);
}

function vec3OK(v: unknown): boolean {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** Keep the capsule geometrically valid whatever the config says. */
export function sanitize(c: NavigationConfig): NavigationConfig {
  const radius = Math.min(Math.max(c.radius, 0.05), 2);
  const height = Math.max(c.height, radius * 2 + 0.1);
  const stepHeight = Math.min(Math.max(c.stepHeight, 0), height - radius * 2 - 0.05);
  const eyeHeight = Math.min(Math.max(c.eyeHeight, 0.1), height);
  const maxSlopeDeg = Math.min(Math.max(c.maxSlopeDeg, 0), 89);
  return { ...c, radius, height, stepHeight, eyeHeight, maxSlopeDeg };
}

/**
 * Whether the viewer should start in first-person ("walk") controls.
 * ?nav= forces it; otherwise a JSON `navigation` block that sets `mode` or
 * `collision` does, unless the JSON sets `controls` explicitly.
 */
export function navStartsFirstPerson(file: NavigationConfigFile | undefined, q: URLSearchParams): boolean {
  const navParam = q.get("nav");
  if (navParam === "walk" || navParam === "fly") return true;
  return !!file && (file.mode !== undefined || file.collision !== undefined);
}
