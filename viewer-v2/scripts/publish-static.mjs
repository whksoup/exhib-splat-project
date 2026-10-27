#!/usr/bin/env node
// Assemble a static site for Cloudflare (or any static host): the published
// viewer build plus the built scenes, ready for
//   npm run deploy:static        (scripts/deploy.wrangler.jsonc; Workers static assets)
// Run Wrangler only through that config: without one, current Wrangler
// auto-configures from the working folder and can publish the wrong directory.
//
//   node scripts/publish-static.mjs --scene <name> [--scene <name>]... [--model <name>=<dir>]... [--out <dir>] [--skip-build]
//
// --model publishes a prebuilt splat-transform SOG folder (lod-meta.json + chunks,
// e.g. assets/rad_output/Splice/a-in-b) as models/<name>/, with a view-only
// models/<name>/viewer.json (Gaussian Splat Lite, the folder's viewer.json camera
// and navigation, its whole splat count as the budget) and a landing-page entry
// that opens ?config=models/<name>/viewer.json.
//
// Output (default <repo>/publish/site, gitignored):
//   index.html, assets/...          VITE_STATIC=1 vite build (landing page + view-only scenes)
//   scenes/index.json               the published scenes (landing page list)
//   scenes/<name>/scene.json        as saved (the viewer reads parts, transform, build record)
//   scenes/<name>/nav/...           collision / plan files used by walk mode
//   scenes/<name>/build/<part>/<stem>-lod.rad + -lod-N.radc   only the streamed files:
//                                   build-report.json / build-lod.log stay home (machine paths)
//   _headers                        cache rules (Pages)
//   404.html                        so a missing chunk is a 404, not the app page (Pages SPA fallback)
// Build files are hard-linked (copied across volumes), so a 3 GB scene costs no extra disk.
// Pages limits checked: 20,000 files per site (Free), 25 MiB per file.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isValidSceneName, validateScene } from '../../shared/scene-schema.mjs';

const VIEWER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(VIEWER, '..');
const PAGES_MAX_FILES = 20000;
const PAGES_MAX_FILE_BYTES = 25 * 1024 * 1024;

function parseArgs(argv) {
  const o = { scenes: [], models: [], out: path.join(REPO, 'publish', 'site'), build: true, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const eq = a.indexOf('=');
      if (eq > 0) return a.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined) o.errors.push(`${a} needs a value`);
      return v;
    };
    if (a.startsWith('--scene')) {
      const v = value();
      if (v !== undefined && !isValidSceneName(v)) o.errors.push(`invalid scene name "${v}"`);
      else if (v !== undefined && !o.scenes.includes(v)) o.scenes.push(v);
    } else if (a.startsWith('--model')) {
      const v = value();
      const m = v === undefined ? null : /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})=(.+)$/.exec(v);
      if (v !== undefined && !m) o.errors.push(`--model wants <name>=<dir>, got "${v}"`);
      else if (m) o.models.push({ name: m[1], dir: path.resolve(REPO, m[2]) });
    } else if (a.startsWith('--out')) {
      const v = value();
      if (v !== undefined) o.out = path.resolve(v);
    } else if (a === '--skip-build') o.build = false;
    else o.errors.push(`unknown option ${a}`);
  }
  if (o.scenes.length === 0 && o.models.length === 0) o.errors.push('pass at least one --scene <name> or --model <name>=<dir>');
  return o;
}

/** A prebuilt SOG folder as models/<name>/ with a view-only viewer.json. */
function publishModel({ name, dir }, out) {
  const meta = path.join(dir, 'lod-meta.json');
  if (!fs.existsSync(meta)) throw new Error(`--model ${name}: no lod-meta.json in ${dir}`);
  const target = path.join(out, 'models', name);
  fs.mkdirSync(target, { recursive: true });
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name !== 'viewer.json' && !e.name.startsWith('.')) {
        linkOrCopy(abs, path.join(target, path.relative(dir, abs)));
        files++;
        bytes += fs.statSync(abs).size;
      }
    }
  };
  walk(dir);
  // Splat count from the index: every leaf's LoD ranges (one level for a single-SOG model).
  let splats = 0;
  const count = (n) => {
    if (n.lods) for (const l of Object.values(n.lods)) splats += l.count;
    for (const c of n.children ?? []) count(c);
  };
  count(JSON.parse(fs.readFileSync(meta, 'utf8')).tree);
  const local = fs.existsSync(path.join(dir, 'viewer.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'viewer.json'), 'utf8')) : {};
  const config = {
    renderer: 'gsl',
    overlay: false,
    models: [{ url: `models/${name}/lod-meta.json` }],
    // Room for every splat: a single SOG level can't trade detail for budget.
    budget: Math.max(splats, 1_000_000),
    lodScale: 1,
    ...(local.camera && { camera: local.camera }),
    ...(local.navigation && { navigation: local.navigation }),
  };
  fs.writeFileSync(path.join(target, 'viewer.json'), JSON.stringify(config, null, 2) + '\n');
  return {
    entry: { name, kind: 'model', href: `?config=models/${encodeURIComponent(name)}/viewer.json`, parts: 1, splats, bytes, builtAt: fs.statSync(meta).mtime.toISOString() },
    files: files + 1,
    bytes,
  };
}

function linkOrCopy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.rmSync(dst, { force: true });
  try {
    fs.linkSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
  }
}

/** The streamed files of one part: <stem>-lod.rad and its <stem>-lod-N.radc chunks. */
function partFiles(buildDir, radFile) {
  const dir = path.join(buildDir, ...path.posix.dirname(radFile).split('/').filter((s) => s !== '.'));
  const rad = path.posix.basename(radFile);
  if (!rad.endsWith('-lod.rad') || !fs.existsSync(path.join(dir, rad))) throw new Error(`${radFile} is missing from build/ (build the scene first)`);
  const stem = rad.slice(0, -'-lod.rad'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${stem}-lod(\\.rad|-\\d+\\.radc)$`);
  return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => ({ abs: path.join(dir, f), rel: path.posix.join(path.posix.dirname(radFile), f) }));
}

function publishScene(name, out) {
  const dir = path.join(REPO, 'scenes', name);
  const { scene, errors } = validateScene(JSON.parse(fs.readFileSync(path.join(dir, 'scene.json'), 'utf8')));
  if (!scene) throw new Error(`scenes/${name}/scene.json is invalid: ${errors.join('; ')}`);
  if (!scene.build) throw new Error(`scene "${name}" is not built`);
  const enabled = scene.parts.filter((p) => p.enabled !== false);
  const missing = enabled.filter((p) => !scene.build.parts.some((b) => b.id === p.id));
  if (missing.length) throw new Error(`scene "${name}": parts not built: ${missing.map((p) => p.id).join(', ')}`);
  if (scene.build.status !== 'ok') console.warn(`WARNING: scene "${name}" build is "${scene.build.status}" (some parts carry an older transform)`);

  const target = path.join(out, 'scenes', name);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(dir, 'scene.json'), path.join(target, 'scene.json'));
  let files = 1;
  let bytes = fs.statSync(path.join(dir, 'scene.json')).size;
  const navDir = path.join(dir, 'nav');
  if (fs.existsSync(navDir)) {
    for (const f of fs.readdirSync(navDir)) {
      const abs = path.join(navDir, f);
      if (!fs.statSync(abs).isFile() || f.startsWith('.')) continue;
      linkOrCopy(abs, path.join(target, 'nav', f));
      files++;
      bytes += fs.statSync(abs).size;
    }
  }
  const buildDir = path.join(dir, 'build');
  let streamed = 0;
  for (const b of scene.build.parts) {
    if (!enabled.some((p) => p.id === b.id)) continue;
    for (const f of partFiles(buildDir, b.radFile)) {
      linkOrCopy(f.abs, path.join(target, 'build', ...f.rel.split('/')));
      const size = fs.statSync(f.abs).size;
      files++;
      bytes += size;
      streamed += size;
    }
  }
  return {
    entry: {
      name,
      parts: enabled.length,
      splats: scene.build.splatCount?.final ?? null,
      bytes: streamed,
      builtAt: scene.build.finishedAt ?? null,
    },
    files,
    bytes,
  };
}

const HEADERS = `# Cloudflare Pages response headers (written by scripts/publish-static.mjs).
# Viewer code and styles have content-hashed names: cache them for a year.
/assets/*
  Cache-Control: public, max-age=31536000, immutable

# Scene files keep their names across rebuilds (a new deploy replaces them), so
# browsers revalidate (cheap 304s); Cloudflare's edge serves them from cache per deployment.
/scenes/*
  Cache-Control: public, max-age=0, must-revalidate
  Access-Control-Allow-Origin: *

/models/*
  Cache-Control: public, max-age=0, must-revalidate
  Access-Control-Allow-Origin: *
`;

const NOT_FOUND = `<!doctype html>
<meta charset="utf-8">
<title>Not found</title>
<p>Not found. <a href="./">Back to the tours</a></p>
`;

function walkStats(dir) {
  let files = 0;
  let bytes = 0;
  let largest = { size: 0, file: '' };
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else {
        const size = fs.statSync(abs).size;
        files++;
        bytes += size;
        if (size > largest.size) largest = { size, file: path.relative(dir, abs) };
      }
    }
  };
  walk(dir);
  return { files, bytes, largest };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.errors.length) {
    for (const e of o.errors) console.error(`error: ${e}`);
    console.error('usage: node scripts/publish-static.mjs --scene <name> [--scene <name>]... [--model <name>=<dir>]... [--out <dir>] [--skip-build]');
    return 2;
  }
  if (o.build) {
    console.log(`Building the published viewer into ${o.out} ...`);
    const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'build', '--outDir', o.out, '--emptyOutDir'], {
      cwd: VIEWER,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, VITE_STATIC: '1' },
    });
    if (r.status !== 0) {
      console.error('error: vite build failed');
      return 1;
    }
  } else if (!fs.existsSync(path.join(o.out, 'index.html'))) {
    console.error(`error: --skip-build but ${o.out} has no index.html`);
    return 2;
  }
  fs.rmSync(path.join(o.out, 'scenes'), { recursive: true, force: true });
  fs.rmSync(path.join(o.out, 'models'), { recursive: true, force: true });
  fs.mkdirSync(path.join(o.out, 'scenes'), { recursive: true });
  const index = [];
  for (const m of o.models) {
    try {
      const r = publishModel(m, o.out);
      index.push(r.entry);
      console.log(`model ${m.name}: ${r.files} files, ${(r.bytes / 1e6).toFixed(0)} MB`);
    } catch (e) {
      console.error(`error: ${e.message}`);
      return 1;
    }
  }
  for (const name of o.scenes) {
    try {
      const r = publishScene(name, o.out);
      index.push(r.entry);
      console.log(`scene ${name}: ${r.files} files, ${(r.bytes / 1e9).toFixed(2)} GB`);
    } catch (e) {
      console.error(`error: ${e.message}`);
      return 1;
    }
  }
  fs.writeFileSync(path.join(o.out, 'scenes', 'index.json'), JSON.stringify(index, null, 2) + '\n');
  fs.writeFileSync(path.join(o.out, '_headers'), HEADERS);
  fs.writeFileSync(path.join(o.out, '404.html'), NOT_FOUND);
  // Never publish Wrangler's own cache (account id and name) if it lands in the folder.
  fs.writeFileSync(path.join(o.out, '.assetsignore'), '.wrangler\n.assetsignore\n');
  fs.rmSync(path.join(o.out, '.wrangler'), { recursive: true, force: true });

  const s = walkStats(o.out);
  console.log(`\nSite: ${o.out}`);
  console.log(`  ${s.files} files, ${(s.bytes / 1e9).toFixed(2)} GB, largest ${(s.largest.size / 1e6).toFixed(1)} MB (${s.largest.file})`);
  let ok = true;
  if (s.files > PAGES_MAX_FILES) {
    console.error(`  FAIL: ${s.files} files > ${PAGES_MAX_FILES} (Cloudflare Pages Free limit per site): publish fewer scenes per project`);
    ok = false;
  }
  if (s.largest.size > PAGES_MAX_FILE_BYTES) {
    console.error(`  FAIL: ${s.largest.file} is over 25 MiB (Cloudflare Pages per-file limit)`);
    ok = false;
  }
  if (ok) console.log(`  Within Cloudflare Free limits (${PAGES_MAX_FILES} files, 25 MiB per file).\n  Deploy: npm run deploy:static (scripts/deploy.wrangler.jsonc; default --out only)`);
  return ok ? 0 : 1;
}

process.exit(main());
