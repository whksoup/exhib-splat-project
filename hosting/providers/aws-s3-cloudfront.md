# AWS S3 + CloudFront

> **Provider choice is pending** (open question in `docs/Project_Scope.md`). Template only. Verify the policy names and IDs in the console.

**Egress:** about $0.085/GB for the first 10 TB in NA/EU (always-free tier is 1 TB/month). S3 storage is about $0.023/GB-month. Origin fetches from S3 to CloudFront are free.

## Setup
1. **Private** S3 bucket, with CloudFront reading through **Origin Access Control (OAC)**.
2. Upload with cache headers. Don't set `Content-Encoding`:
   ```sh
   aws s3 cp <out_dir> s3://<bucket>/models/<name>/<version>/ --recursive \
     --cache-control "public, max-age=31536000, immutable" --content-type application/octet-stream
   ```
3. Distribution behavior for `/models/*`:
   - **Allowed methods:** GET, HEAD, OPTIONS. Also cache OPTIONS.
   - **Cache policy:** managed `CachingOptimized`. It honours origin `Cache-Control`, and its default TTL only applies when the header is missing.
   - **Response headers policy:** create one from [`cloudfront-response-headers-policy.json`](cloudfront-response-headers-policy.json):
     ```sh
     aws cloudfront create-response-headers-policy --response-headers-policy-config file://hosting/providers/cloudfront-response-headers-policy.json
     ```
     CloudFront then answers preflights and adds CORS headers at the edge (`OriginOverride`). With that in place you can drop S3 CORS and the `CORS-S3Origin` origin request policy, and `Origin` stays out of the cache key. The managed `CORS-With-Preflight` policy also works, but it doesn't expose `Content-Range`.
   - **Compress objects automatically:** either setting is fine. CloudFront only compresses text-like types, not `application/octet-stream`.
4. **Range requests:** CloudFront forwards and serves `Range` natively. Don't add a Lambda@Edge or CloudFront Function that rewrites or strips the `Range` header. Leave `Range` out of the cache policy too, because CloudFront handles it itself.
5. If you prefer S3 CORS instead of step 3, use [`cors-s3-r2.json`](cors-s3-r2.json) with `aws s3api put-bucket-cors`. You then also need the `CORS-S3Origin` origin request policy and `Vary: Origin` handling.

Check: `node hosting/smoke-test.mjs https://dxxxx.cloudfront.net models/<name>/<version>/<file>.rad --origin https://<viewer-origin>`
