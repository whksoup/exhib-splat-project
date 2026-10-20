#!/usr/bin/env node
// Smoke test: can Spark 2.x stream LoD assets from this host/CDN?
// Node 24, built-ins only (raw node:http/https so nothing is auto-decompressed).
//
// Usage:
//   node hosting/smoke-test.mjs <baseUrl> <path> [<path> ...] [--origin URL] [--versioned|--unversioned] [--json]
//   node hosting/smoke-test.mjs https://cdn.example.com/models/demo/v1/demo-lod.rad
//
// Exit codes: 0 = all PASS (WARN allowed), 1 = at least one FAIL, 2 = usage / network error.
//
// What Spark 2.3.x actually does (src/SplatPager.ts, fetchRange() in dist/spark.module.js):
//   * .rad header: fetch(url, {headers: {Range: "bytes=0-65535"}}), retrying with 256 KiB and 1 MiB.
//     It accepts any 2xx, so a server ignoring Range still "works" but sends the whole file.
//   * chunked .radc files: plain fetch() of the whole file, NO Range header.
//   * monolithic (non-chunked) .rad: every chunk is a Range request and the body is used as-is,
//     so a 200 full-body reply to a chunk Range would corrupt decoding.
//   * It never reads Content-Range / Accept-Ranges response headers, so Access-Control-Expose-Headers
//     is not required by Spark (only useful for app-level progress/debugging) -> WARN, not FAIL.
//   * The Range request header is sent cross-origin, so the CORS preflight must allow "range".

import http from 'node:http';
import https from 'node:https';
import { parseArgs } from 'node:util';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    origin: { type: 'string', default: 'https://smoke-test.example' },
    versioned: { type: 'boolean', default: false },
    unversioned: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '20000' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function usage(code) {
  console.log(`Usage: node hosting/smoke-test.mjs <baseUrl> <path> [<path> ...] [options]
       node hosting/smoke-test.mjs <fullUrl> [<fullUrl> ...] [options]
Options:
  --origin URL     Origin to send for CORS checks (default https://smoke-test.example;
                   use your real viewer origin when the bucket uses an origin allowlist)
  --versioned      Treat paths as versioned (require immutable caching) regardless of path shape
  --unversioned    Treat paths as unversioned (skip immutable requirement)
  --json           Print results as JSON
  --timeout MS     Per-request timeout (default 20000)
Versioned paths are auto-detected as /models/<name>/<version>/<file>.`);
  process.exit(code);
}
if (opts.help || positionals.length === 0) usage(opts.help ? 0 : 2);

// Resolve targets: either "<base> <path...>" or one or more full URLs.
let targets;
try {
  if (positionals.length >= 2 && !/^https?:\/\//i.test(positionals[1])) {
    const base = positionals[0].endsWith('/') ? positionals[0] : positionals[0] + '/';
    targets = positionals.slice(1).map((p) => new URL(p.replace(/^\//, ''), base));
  } else {
    targets = positionals.map((p) => new URL(p));
  }
} catch (e) {
  console.error(`Invalid URL: ${e.message}`);
  process.exit(2);
}
for (const t of targets) {
  if (t.protocol !== 'http:' && t.protocol !== 'https:') {
    console.error(`Not an http(s) URL: ${t.href}\n(Git Bash rewrites args starting with "/"; drop the leading slash or set MSYS_NO_PATHCONV=1.)`);
    process.exit(2);
  }
}

const TIMEOUT = Number(opts.timeout);
const ORIGIN = opts.origin;
const VERSIONED_RE = /^\/models\/[^/]+\/(?!latest\/|current\/)[^/]+\/.+/;
const ONE_YEAR = 31536000;

// Raw request. Reads at most maxBytes of body, then aborts (so 1 GB files are never downloaded).
function request(url, { method = 'GET', headers = {}, maxBytes = 1 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method, headers: { 'User-Agent': 'spark-smoke-test/1', ...headers } }, (res) => {
      const chunks = [];
      let received = 0;
      let truncated = false;
      const done = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), received, truncated });
      res.on('data', (c) => {
        received += c.length;
        if (received <= maxBytes) chunks.push(c);
        else if (!truncated) { truncated = true; done(); req.destroy(); }
      });
      res.on('end', () => { if (!truncated) done(); });
      res.on('error', (e) => { if (!truncated) reject(e); });
    });
    req.setTimeout(TIMEOUT, () => req.destroy(new Error(`timeout after ${TIMEOUT} ms`)));
    req.on('error', reject);
    req.end();
  });
}

const listHas = (value, name) =>
  !!value && value.split(',').map((s) => s.trim().toLowerCase()).some((s) => s === name.toLowerCase() || s === '*');

function parseCacheControl(v = '') {
  const out = {};
  for (const part of v.split(',')) {
    const [k, val] = part.trim().toLowerCase().split('=');
    if (k) out[k] = val === undefined ? true : val.replace(/"/g, '');
  }
  return out;
}

async function testOne(url) {
  const results = [];
  const add = (check, status, detail) => results.push({ url: url.href, check, status, detail });
  const isVersioned = opts.versioned || (!opts.unversioned && VERSIONED_RE.test(url.pathname));
  const ext = url.pathname.split('.').pop().toLowerCase();

  // 1. HEAD without Origin first: on a CDN this can prime the cache with a CORS-less response,
  //    which the Origin-bearing checks below would then expose (a classic cache-key bug).
  let size = null;
  try {
    const r = await request(url, { method: 'HEAD' });
    if (r.status >= 200 && r.status < 300) {
      size = r.headers['content-length'] !== undefined ? Number(r.headers['content-length']) : null;
      add('HEAD status', 'PASS', `${r.status}, Content-Length ${size ?? 'missing'}`);
    } else add('HEAD status', r.status === 405 ? 'WARN' : 'FAIL', `${r.status}`);
  } catch (e) {
    add('HEAD status', 'FAIL', e.message);
  }

  // 2. Plain GET (headers + first bytes only), advertising compression like a browser does.
  let get;
  try {
    get = await request(url, { headers: { Origin: ORIGIN, 'Accept-Encoding': 'gzip, deflate, br, zstd' }, maxBytes: 64 * 1024 });
    if (get.status === 200) add('GET status', 'PASS', '200');
    else return add('GET status', 'FAIL', `${get.status} (expected 200; aborting remaining checks)`), results;
    if (size === null && get.headers['content-length']) size = Number(get.headers['content-length']);
  } catch (e) {
    add('GET status', 'FAIL', e.message);
    return results;
  }

  // 3. Content-Type: wrong type is not fatal to Spark, but text/html usually means an error/SPA fallback page.
  const ct = (get.headers['content-type'] || '').toLowerCase();
  if (!ct) add('Content-Type', 'WARN', 'missing');
  else if (ct.startsWith('text/html')) add('Content-Type', 'FAIL', `${ct} (looks like an HTML error/fallback page)`);
  else if (['rad', 'radc', 'spz', 'ply', 'sog', 'bin'].includes(ext) && !ct.startsWith('application/octet-stream'))
    add('Content-Type', 'WARN', `${ct} (expected application/octet-stream; text/* types invite CDN compression)`);
  else add('Content-Type', 'PASS', ct);

  // 4. Compression on the full response.
  const ceFull = (get.headers['content-encoding'] || 'identity').toLowerCase();
  if (ceFull === 'identity') add('No compression (GET)', 'PASS', 'no Content-Encoding');
  else add('No compression (GET)', 'WARN', `Content-Encoding: ${ceFull} - splat data is already compact; compressed responses break byte-range math on some CDNs`);

  // 5. Accept-Ranges. Spark never reads it, but CDNs/browsers use it to decide range caching.
  const ar = (get.headers['accept-ranges'] || '').toLowerCase();
  add('Accept-Ranges', ar === 'bytes' ? 'PASS' : 'WARN', ar ? ar : 'missing (not read by Spark, but should be "bytes")');

  // 6. CORS on the real response.
  const acao = get.headers['access-control-allow-origin'];
  if (acao === '*' || acao === ORIGIN) add('CORS Allow-Origin (GET)', 'PASS', acao);
  else add('CORS Allow-Origin (GET)', 'FAIL', acao ? `${acao} (does not match ${ORIGIN})` : `missing for Origin ${ORIGIN}`);
  if (acao && acao !== '*') {
    add('Vary: Origin', listHas(get.headers.vary, 'origin') ? 'PASS' : 'WARN',
      get.headers.vary ? `Vary: ${get.headers.vary}` : 'missing - CDN may serve one origin\'s CORS headers to another');
  }

  // 7. Range bytes=0-1023 (what Spark does for the .rad header, scaled down).
  const want = size !== null ? Math.min(1024, size) : 1024;
  try {
    const r = await request(url, { headers: { Origin: ORIGIN, Range: 'bytes=0-1023', 'Accept-Encoding': 'gzip, deflate, br, zstd' }, maxBytes: 2 * 1024 * 1024 });
    const cr = r.headers['content-range'];
    const ce = (r.headers['content-encoding'] || 'identity').toLowerCase();
    if (r.status !== 206) {
      add('Range 0-1023 status', 'FAIL', `${r.status} (expected 206; ${r.status === 200 ? 'Range ignored - Spark would download whole files' : 'error'})`);
    } else {
      add('Range 0-1023 status', 'PASS', '206');
      const expectCR = `bytes 0-${want - 1}/${size ?? '*'}`;
      const crOk = cr && (size !== null ? cr === expectCR : /^bytes 0-\d+\/(\d+|\*)$/.test(cr));
      add('Content-Range', crOk ? 'PASS' : 'FAIL', cr ? `${cr}${crOk ? '' : ` (expected ${expectCR})`}` : 'missing');
      const cl = r.headers['content-length'];
      const lenOk = r.received === want && (cl === undefined || Number(cl) === want);
      add('Range body length', lenOk ? 'PASS' : 'FAIL', `received ${r.received} bytes, Content-Length ${cl ?? 'n/a'}, expected ${want}`);
      if (get.body.length >= want) {
        add('Range bytes match GET', r.body.subarray(0, want).equals(get.body.subarray(0, want)) ? 'PASS' : 'FAIL', 'first bytes compared with plain GET');
      }
    }
    add('No compression (Range)', ce === 'identity' ? 'PASS' : 'FAIL',
      ce === 'identity' ? 'no Content-Encoding' : `Content-Encoding: ${ce} - offsets would index the compressed stream`);
    const racao = r.headers['access-control-allow-origin'];
    add('CORS Allow-Origin (Range)', racao === '*' || racao === ORIGIN ? 'PASS' : 'FAIL', racao || 'missing');

    // Expose-Headers: not needed by Spark (it ignores response headers), useful for progress/debug tooling.
    const exp = r.headers['access-control-expose-headers'] || '';
    const missing = ['Content-Range', 'Accept-Ranges'].filter((h) => !listHas(exp, h));
    // Content-Length is CORS-safelisted already; listed only for completeness.
    add('CORS Expose-Headers', missing.length ? 'WARN' : 'PASS',
      missing.length ? `missing ${missing.join(', ')} (Spark does not read them; app tooling can't see them)` : exp);

    const cacheInfo = ['cf-cache-status', 'x-cache', 'age', 'cdn-cache', 'x-served-by']
      .filter((h) => r.headers[h] !== undefined).map((h) => `${h}: ${r.headers[h]}`).join('; ');
    if (cacheInfo) add('CDN cache info', 'INFO', cacheInfo);
  } catch (e) {
    add('Range 0-1023 status', 'FAIL', e.message);
  }

  // 8. Mid-file range: catches CDNs that only handle ranges starting at 0 or serve stale prefixes.
  if (size !== null && size > 4096) {
    const s = Math.floor(size / 2);
    try {
      const r = await request(url, { headers: { Origin: ORIGIN, Range: `bytes=${s}-${s + 511}` }, maxBytes: 1 << 20 });
      const ok = r.status === 206 && r.headers['content-range'] === `bytes ${s}-${s + 511}/${size}` && r.received === 512;
      add('Range mid-file', ok ? 'PASS' : 'FAIL', `${r.status} ${r.headers['content-range'] || ''} (${r.received} bytes)`);
    } catch (e) {
      add('Range mid-file', 'FAIL', e.message);
    }
  }

  // 9. CORS preflight for the Range header. The Fetch spec now safelists simple single ranges,
  //    but browsers differ and any custom requestHeader (e.g. auth) forces a preflight anyway.
  try {
    const r = await request(url, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' },
    });
    const pacao = r.headers['access-control-allow-origin'];
    const allowH = r.headers['access-control-allow-headers'];
    const allowM = r.headers['access-control-allow-methods'];
    const okStatus = r.status >= 200 && r.status < 300;
    const okOrigin = pacao === '*' || pacao === ORIGIN;
    const okHeaders = listHas(allowH, 'range');
    const okMethod = !allowM || listHas(allowM, 'GET');
    const pass = okStatus && okOrigin && okHeaders && okMethod;
    add('CORS preflight (Range)', pass ? 'PASS' : 'FAIL',
      `${r.status}; Allow-Origin ${pacao || 'missing'}; Allow-Headers ${allowH || 'missing'}; Allow-Methods ${allowM || 'n/a'}`);
  } catch (e) {
    add('CORS preflight (Range)', 'FAIL', e.message);
  }

  // 10. Cache-Control.
  const ccRaw = get.headers['cache-control'] || '';
  const cc = parseCacheControl(ccRaw);
  const maxAge = Number(cc['s-maxage'] ?? cc['max-age'] ?? 0);
  if (isVersioned) {
    const ok = cc.immutable && Number(cc['max-age'] ?? 0) >= ONE_YEAR && !cc['no-cache'] && !cc['no-store'] && !cc.private;
    add('Cache-Control (versioned)', ok ? 'PASS' : 'FAIL',
      `${ccRaw || 'missing'}${ok ? '' : ` (want "public, max-age=${ONE_YEAR}, immutable")`}`);
  } else {
    add('Cache-Control (unversioned)', cc.immutable || maxAge > 3600 ? 'WARN' : 'INFO',
      `${ccRaw || 'missing'}${cc.immutable || maxAge > 3600 ? ' - long caching on an unversioned path cannot be invalidated by clients' : ' (path not /models/<name>/<version>/...; immutable not required)'}`);
  }

  return results;
}

let all = [];
try {
  for (const t of targets) all = all.concat(await testOne(t));
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(2);
}

const fails = all.filter((r) => r.status === 'FAIL').length;
const warns = all.filter((r) => r.status === 'WARN').length;

if (opts.json) {
  console.log(JSON.stringify({ origin: ORIGIN, fails, warns, results: all }, null, 2));
} else {
  const color = process.stdout.isTTY
    ? { PASS: '\x1b[32m', FAIL: '\x1b[31m', WARN: '\x1b[33m', INFO: '\x1b[36m', reset: '\x1b[0m' }
    : { PASS: '', FAIL: '', WARN: '', INFO: '', reset: '' };
  for (const t of targets) {
    const rows = all.filter((r) => r.url === t.href);
    const w = Math.max(...rows.map((r) => r.check.length));
    console.log(`\n${t.href}  (Origin: ${ORIGIN})`);
    console.log(`  ${'CHECK'.padEnd(w)}  RESULT  DETAIL`);
    console.log(`  ${'-'.repeat(w)}  ------  ${'-'.repeat(40)}`);
    for (const r of rows) console.log(`  ${r.check.padEnd(w)}  ${color[r.status]}${r.status.padEnd(6)}${color.reset}  ${r.detail}`);
  }
  console.log(`\n${fails ? 'FAILED' : 'PASSED'}: ${all.filter((r) => r.status === 'PASS').length} pass, ${warns} warn, ${fails} fail`);
}
process.exit(fails ? 1 : 0);
