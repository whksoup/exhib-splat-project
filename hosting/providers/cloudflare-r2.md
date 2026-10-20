# Cloudflare R2 + Cloudflare CDN

> **Provider choice is pending** (open question in `docs/Project_Scope.md`). Template only; verify against current Cloudflare docs before use.

**Egress:** free. Storage about $0.015/GB-month. Class B (read) operations are billed per million, and cache hits don't count.

## Setup
1. Create a bucket and connect a **custom domain** (e.g. `cdn.example.com`) under *Settings > Public access*. Don't use `r2.dev` in production: it is rate-limited and sits outside the cache.
2. CORS: apply [`cors-s3-r2.json`](cors-s3-r2.json) with the S3 API:
   ```sh
   aws s3api put-bucket-cors --bucket <bucket> --cors-configuration file://hosting/providers/cors-s3-r2.json \
     --endpoint-url https://<account_id>.r2.cloudflarestorage.com
   ```
   (or paste the equivalent rules in the dashboard under *Settings > CORS policy*).
3. Upload with per-object cache headers. R2 stores them and serves them back:
   ```sh
   aws s3 cp <out_dir> s3://<bucket>/models/<name>/<version>/ --recursive \
     --cache-control "public, max-age=31536000, immutable" --content-type application/octet-stream \
     --endpoint-url https://<account_id>.r2.cloudflarestorage.com
   ```
   Don't pass `--content-encoding`.
4. Add a **Cache Rule** for `URI Path starts with /models/` with Eligible for cache, Edge TTL "use cache-control header if present", and Browser TTL "respect origin".
5. **CORS vs. cache:** the Cloudflare cache key ignores `Origin` by default, so a first request without `Origin` can cache a response that has no CORS headers. Add a **Transform Rule > Modify response header** on `/models/*` that sets `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, ETag`. The smoke test sends a no-`Origin` HEAD first so it catches this problem.
6. Compression: Cloudflare doesn't compress `application/octet-stream`. Keep that content type.

## Limits to know
- Default max cacheable file size is **512 MB** on Free, Pro and Business plans. Chunked `.radc` files are far smaller. A monolithic 1+ GB `.rad` would bypass the cache, which is another reason to always build with `--rad-chunked`.
- Range requests are served from the cached full object.

Check: `node hosting/smoke-test.mjs https://cdn.example.com models/<name>/<version>/<file>.rad models/<name>/<version>/<chunk>.radc --origin https://<viewer-origin>`
