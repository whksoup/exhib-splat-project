# Google Cloud Storage and Bunny.net (alternatives)

> **Provider choice is pending** (open question in `docs/Project_Scope.md`). These are short notes. Verify them before use.

## Google Cloud Storage (+ optional Cloud CDN)
**Egress:** about $0.12/GB direct, or about $0.08/GB through Cloud CDN.

`gcs-cors.json`:
```json
[{
  "origin": ["*"],
  "method": ["GET", "HEAD"],
  "responseHeader": ["Range", "Content-Range", "Content-Length", "Accept-Ranges", "ETag"],
  "maxAgeSeconds": 86400
}]
```
`gcloud storage buckets update gs://<bucket> --cors-file=gcs-cors.json`. GCS uses `responseHeader` both as the preflight allow-list and as the exposed headers.

- Upload with `--cache-control="public, max-age=31536000, immutable"`.
- **Never** upload with `Content-Encoding: gzip`. GCS decompressive transcoding then ignores `Range` and returns a 200 with the full file.
- Public objects get `Cache-Control: public, max-age=3600` unless you set it yourself.

## Bunny.net (Storage Zone + Pull Zone)
**Egress:** about $0.01/GB in NA/EU (volume tier about $0.005/GB). Storage is about $0.01–0.02/GB-month. The cheapest paid CDN option.

- Pull Zone > *General > CORS*: enable "Add CORS headers" and **add `rad` and `radc` to the extension list**. The defaults cover only common web types.
- Use **Edge Rules** to set response headers on `*/models/*`: `Cache-Control: public, max-age=31536000, immutable`, `Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, ETag`, and `Access-Control-Allow-Headers: range` (needed for preflight).
- Range requests are supported by default. Leave "Optimizer" / compression off for these paths.
