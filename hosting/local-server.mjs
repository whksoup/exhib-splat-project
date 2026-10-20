#!/usr/bin/env node
// Reference static server for Spark LoD assets (.rad / .radc).
// Node built-ins only. This is the behaviour the production CDN must match:
//   - single-range HTTP Range requests (206 / 416), Accept-Ranges: bytes
//   - CORS incl. preflight allowing the Range request header, exposed range headers
//   - Cache-Control: immutable 1-year for versioned paths /models/<name>/<version>/...
//   - no Content-Encoding on binary assets (compression breaks byte offsets)
//
// Usage: node hosting/local-server.mjs [--root DIR] [--port 8080] [--host 0.0.0.0]
//                                      [--origin "*" | "https://a.com,https://b.com"]

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: opts } = parseArgs({
  options: {
    root: { type: 'string', default: path.resolve(here, '..', 'assets', 'rad_output') },
    port: { type: 'string', short: 'p', default: '8080' },
    host: { type: 'string', default: '0.0.0.0' },
    origin: { type: 'string', default: '*' },
    quiet: { type: 'boolean', short: 'q', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (opts.help) {
  console.log('node hosting/local-server.mjs [--root DIR] [--port 8080] [--host 0.0.0.0] [--origin "*"|list] [--quiet]');
  process.exit(0);
}

const ROOT = path.resolve(opts.root);
const PORT = Number(opts.port);
const ALLOWED_ORIGINS = opts.origin === '*' ? null : opts.origin.split(',').map((s) => s.trim());

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=60, must-revalidate';
// /models/<name>/<version>/<file>; mutable aliases like "latest" are never immutable.
const VERSIONED_RE = /^\/models\/[^/]+\/(?!latest\/|current\/)[^/]+\/.+/;

const TYPES = {
  '.rad': 'application/octet-stream', '.radc': 'application/octet-stream',
  '.spz': 'application/octet-stream', '.ply': 'application/octet-stream',
  '.sog': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.json': 'application/json', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!ALLOWED_ORIGINS) return { 'Access-Control-Allow-Origin': '*' };
  const h = { Vary: 'Origin' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

const EXPOSE = 'Content-Range, Content-Length, Accept-Ranges, ETag, Content-Encoding';

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

// Returns {start,end} | 'unsatisfiable' | null (ignore header -> full 200).
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or garbage: RFC 9110 allows ignoring
  let [, a, b] = m;
  if (a === '' && b === '') return null;
  let start, end;
  if (a === '') { // suffix range: last N bytes
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(a); end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (start >= size || start > end) return 'unsatisfiable';
  }
  return { start, end };
}

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  res.on('finish', () => {
    if (!opts.quiet) {
      const r = req.headers.range ? ` [${req.headers.range}]` : '';
      console.log(`${new Date().toISOString()} ${req.method} ${req.url}${r} -> ${res.statusCode} (${Date.now() - t0} ms)`);
    }
  });

  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') {
    return send(res, 204, {
      ...cors,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Range, If-Range, If-None-Match',
      'Access-Control-Max-Age': '86400',
      ...(ALLOWED_ORIGINS ? {} : { Vary: 'Access-Control-Request-Headers' }),
      'Content-Length': '0',
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { ...cors, Allow: 'GET, HEAD, OPTIONS' }, 'Method Not Allowed');
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, cors, 'Bad Request');
  }
  const filePath = path.resolve(ROOT, '.' + urlPath);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return send(res, 403, cors, 'Forbidden');

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { ...cors, 'Content-Type': 'text/plain' }, 'Not Found');

    const size = st.size;
    const etag = `"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const base = {
      ...cors,
      'Access-Control-Expose-Headers': EXPOSE,
      'Timing-Allow-Origin': '*', // lets the viewer's perf overlay read Resource Timing sizes
      'Accept-Ranges': 'bytes',
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': VERSIONED_RE.test(urlPath) ? IMMUTABLE : SHORT,
      'Last-Modified': st.mtime.toUTCString(),
      ETag: etag,
      // Deliberately never set Content-Encoding: binary splat data must be byte-addressable.
    };

    if (req.headers['if-none-match'] === etag && !req.headers.range) return send(res, 304, base);

    let range = req.headers.range ? parseRange(req.headers.range, size) : null;
    // If-Range: only honour Range when the validator still matches.
    if (range && req.headers['if-range'] && req.headers['if-range'] !== etag) range = null;

    if (range === 'unsatisfiable') {
      return send(res, 416, { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' });
    }
    const status = range ? 206 : 200;
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const headers = { ...base, 'Content-Length': String(size === 0 ? 0 : end - start + 1) };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) return res.end();
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
});

server.listen(PORT, opts.host, () => {
  console.log(`Serving ${ROOT}`);
  console.log(`CORS origin: ${opts.origin}   immutable paths: /models/<name>/<version>/...`);
  const urls = [`http://localhost:${PORT}/`];
  if (opts.host === '0.0.0.0' || opts.host === '::') {
    for (const ifs of Object.values(os.networkInterfaces())) {
      for (const a of ifs || []) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}/`);
    }
  }
  for (const u of urls) console.log(`  ${u}`);
});
