# hosting/

Serving chunked LoD splats (`.rad` header + `.radc` chunks) to Spark 2.x from object storage behind a CDN. **The CDN provider has not been chosen yet** (open question in `docs/Project_Scope.md`).

| File | Purpose |
|---|---|
| `local-server.mjs` | Reference server (Node built-ins only). It is the behaviour the CDN must match. |
| `smoke-test.mjs` | Checks a host for Range, CORS, cache and compression behaviour. Prints a pass/fail table. Exits 1 on any FAIL. |
| `providers/` | Config templates: S3/R2 CORS JSON, R2, S3 + CloudFront, GCS and Bunny notes |

## What Spark actually needs

From `@sparkjsdev/spark` 2.3.1 (`PagedSplats.getRadMeta` / `fetchDecodeChunk` / `fetchRange` in `dist/spark.module.js`, source `src/SplatPager.ts`):

- **`.rad` header:** fetched with `Range: bytes=0-65535`, retried with 256 KiB and then 1 MiB if the header is larger. Spark accepts any 2xx, so a host that ignores Range still works but sends the whole header file each time.
- **Chunked `.radc` files:** plain `fetch()` of each **whole** file, with no `Range` header. Chunk filenames resolve relative to the `.rad` URL, so keep them in the same directory.
- **Monolithic (non-chunked) `.rad`:** every chunk is a Range request, and Spark uses the response body as-is. A host that answers with 200 and the full file would corrupt decoding. We always build with `--rad-chunked`.
- Spark **never reads** `Content-Range`, `Accept-Ranges` or `Content-Length` from the responses that matter here. That means `Access-Control-Expose-Headers` is optional for Spark. We still expose them for debugging and progress UIs, and the smoke test only WARNs if they're missing.
- The `Range` request header goes cross-origin, so the **CORS preflight must allow `range`**. The Fetch spec now treats simple single ranges as safelisted, but don't rely on that across browsers. Any custom `requestHeader` (such as auth) forces a preflight anyway.
- `withCredentials: true` would need a specific origin (not `*`) plus `Access-Control-Allow-Credentials`. The templates assume public, credential-less assets.

## Requirements checklist (CDN must match `local-server.mjs`)

- [ ] `GET`/`HEAD` return 200 with a correct `Content-Length`
- [ ] `Range: bytes=a-b` returns **206** with an exact `Content-Range: bytes a-b/size` and body length. Out-of-range requests return 416.
- [ ] `Accept-Ranges: bytes`
- [ ] `Access-Control-Allow-Origin` (`*` or the viewer origin, plus `Vary: Origin` if reflected) on **every** response, including ones served from the cache
- [ ] Preflight `OPTIONS` allows `GET`, `HEAD` and header `range`. `Access-Control-Max-Age` is set.
- [ ] `Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, ETag` (recommended)
- [ ] Versioned paths `/models/<name>/<version>/…` send `Cache-Control: public, max-age=31536000, immutable`. Never overwrite a published version. Publish a new `<version>` instead.
- [ ] Unversioned entry points (tour config, "latest" pointers) use short caching
- [ ] No `Content-Encoding` on `.rad` / `.radc`. Serve them as `Content-Type: application/octet-stream`.
- [ ] No HTML fallback page (SPA rewrite) for missing files. Missing files must return 404.
- [ ] Each chunk file fits under the CDN's max cacheable object size (512 MB on Cloudflare non-Enterprise plans)

## Local server

```sh
node hosting/local-server.mjs                        # serves assets/rad_output on 0.0.0.0:8080 (LAN-visible for phone/Quest tests)
node hosting/local-server.mjs --port 9000 --root path/to/out
node hosting/local-server.mjs --origin https://tour.example,http://localhost:5173   # origin allow-list instead of *
```
It prints LAN URLs on start. Windows may ask to allow Node through the firewall the first time.

## Smoke test

```sh
node hosting/smoke-test.mjs http://localhost:8080 models/demo/v1/demo-lod.rad models/demo/v1/demo-lod-0.radc
node hosting/smoke-test.mjs https://cdn.example.com/models/demo/v1/demo-lod.rad --origin https://tour.example
```
Options: `--origin` (use the real viewer origin when the host uses an allow-list), `--versioned` / `--unversioned` to override path detection, `--json`, `--timeout`. Run it against a `.rad` and at least one `.radc`, **twice** on a real CDN: the first run fills the edge cache and the second tests cached responses. In Git Bash, drop the leading `/` from paths, because MSYS rewrites them into Windows paths.

Verified: the local server passes all checks (0 fail, 0 warn). `python -m http.server` fails on CORS, Range (returns 200), preflight (501) and Cache-Control, and the test exits with 1.

## Provider recommendation (pending sign-off)

A 1–1.5 GB model viewed fully 1,000 times is about 1.2 TB of egress.

1. **Cloudflare R2 + custom domain (recommended):** no egress fees, S3-compatible API, cheap storage. Caveats: you need a Transform Rule so CORS headers survive caching, and a 512 MB per-object cache limit, which is fine for chunked builds. See [`providers/cloudflare-r2.md`](providers/cloudflare-r2.md).
2. **Bunny.net:** about $0.01/GB (about $12 per TB), very simple. CORS and cache headers are set through dashboard edge rules, and you must add `rad`/`radc` to the CORS extension list. See [`providers/gcs-and-bunny.md`](providers/gcs-and-bunny.md).
3. **AWS S3 + CloudFront:** about $0.085/GB (about $85 per TB after the 1 TB free tier). Pick it only if the client is already on AWS. It has the most mature controls (response headers policy, OAC). See [`providers/aws-s3-cloudfront.md`](providers/aws-s3-cloudfront.md).
4. **GCS (+ Cloud CDN):** about $0.08–0.12/GB. Watch out for gzip transcoding, which disables Range. No advantage here unless the client is on GCP.
