// Node-side helpers for scene folders (scenes/<name>/): path resolution, atomic
// scene.json read/write, the global build lock and the temp-dir swap.
// The schema itself lives in ../../shared/scene-schema.mjs (shared with the viewer).
import fs from 'node:fs';
import path from 'node:path';
import {
  SCENE_FILE, SCENE_BUILD_DIR, SCENE_NAV_DIR, isValidSceneName, validateScene, stringifyScene,
} from '../../shared/scene-schema.mjs';

export const BUILD_TMP_DIR = '.build-tmp';
export const LOCK_FILE = '.build.lock';

/** Absolute paths of a scene folder. Throws on an invalid name. */
export function scenePaths(scenesRoot, name) {
  if (!isValidSceneName(name)) throw new Error(`invalid scene name "${name}" (letters, digits, _ and -, max 64 chars)`);
  const root = path.resolve(scenesRoot);
  const dir = path.join(root, name);
  if (path.dirname(dir) !== root) throw new Error('scene path escapes the scenes folder');
  return {
    root,
    dir,
    file: path.join(dir, SCENE_FILE),
    nav: path.join(dir, SCENE_NAV_DIR),
    build: path.join(dir, SCENE_BUILD_DIR),
    tmp: path.join(dir, BUILD_TMP_DIR),
  };
}

/** Read + validate scene.json. Throws with all validation errors. */
export function readScene(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  const { scene, errors } = validateScene(raw);
  if (!scene) throw new Error(`invalid ${path.basename(path.dirname(file))}/scene.json: ${errors.join('; ')}`);
  return scene;
}

/** Write scene.json atomically (temp file + rename) so readers never see half a file. */
export function writeSceneAtomic(file, scene) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, stringifyScene(scene));
  renameWithRetrySync(tmp, file);
}

/** Re-read scene.json and apply `fn` to it (so edits saved meanwhile are kept), then write it back. */
export function updateScene(file, fn) {
  const scene = readScene(file);
  const next = fn(scene) ?? scene;
  writeSceneAtomic(file, next);
  return next;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * fs.renameSync with retries: on Windows a rename fails with EPERM/EBUSY/EACCES
 * while another process (antivirus, the dev server streaming a chunk) has a file open.
 */
export function renameWithRetrySync(from, to, { tries = 20, delayMs = 250 } = {}) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= tries - 1 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      sleepSync(delayMs);
    }
  }
}

/**
 * Replace `buildDir` with `tmpDir`. The old build is moved aside first and only
 * deleted once the new one is in place; if the swap fails the old build is restored.
 */
export function swapBuildDir(tmpDir, buildDir) {
  const old = `${path.dirname(buildDir)}${path.sep}.build-old-${Date.now()}`;
  const hadOld = fs.existsSync(buildDir);
  if (hadOld) renameWithRetrySync(buildDir, old);
  try {
    renameWithRetrySync(tmpDir, buildDir);
  } catch (e) {
    if (hadOld) renameWithRetrySync(old, buildDir);
    throw e;
  }
  if (hadOld) {
    try {
      fs.rmSync(old, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.warn(`WARNING: could not delete the previous build at ${old} (${e.code}); delete it by hand.`);
    }
  }
}

/** Remove leftovers of interrupted builds (.build-tmp, .build-old-*) in a scene folder. */
export function removeStaleBuildDirs(sceneDir) {
  if (!fs.existsSync(sceneDir)) return [];
  const removed = [];
  for (const e of fs.readdirSync(sceneDir)) {
    if (e === BUILD_TMP_DIR || e.startsWith('.build-old-')) {
      fs.rmSync(path.join(sceneDir, e), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      removed.push(e);
    }
  }
  return removed;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Take the global build lock (one scene build at a time: build-lod needs GBs of RAM).
 * A lock left by a dead process is replaced. Returns a release function.
 */
export function acquireBuildLock(scenesRoot, name) {
  fs.mkdirSync(scenesRoot, { recursive: true });
  const lock = path.join(scenesRoot, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, scene: name, startedAt: new Date().toISOString() }), { flag: 'wx' });
      return () => {
        try {
          const cur = JSON.parse(fs.readFileSync(lock, 'utf8'));
          if (cur.pid === process.pid) fs.unlinkSync(lock);
        } catch { /* already gone */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let cur = null;
      try { cur = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* unreadable: treat as stale */ }
      if (cur && pidAlive(cur.pid)) {
        throw Object.assign(new Error(`another scene build is running (scene "${cur.scene}", pid ${cur.pid}, since ${cur.startedAt})`), { code: 'ELOCKED' });
      }
      fs.rmSync(lock, { force: true });
    }
  }
  throw Object.assign(new Error('could not take the build lock'), { code: 'ELOCKED' });
}
