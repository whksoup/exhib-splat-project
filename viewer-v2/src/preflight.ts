/**
 * Pre-flight check of a model URL: is it reachable, and does the server honour
 * HTTP Range requests? Spark's paged .rad loader issues Range requests and
 * does not verify the 206 status, so a server that ignores Range silently
 * downloads whole files (or mis-decodes single-file .rad chunks).
 */
export interface PreflightResult {
  ok: boolean;
  status: number;
  /** "ok" = 206 with Content-Range; "ignored" = 200 full body; "unknown" = couldn't tell. */
  range: "ok" | "ignored" | "unknown";
  /** Total size from Content-Range when exposed (cross-origin needs Access-Control-Expose-Headers). */
  totalBytes: number | null;
  error?: string;
}

export async function checkModelUrl(url: string): Promise<PreflightResult> {
  const abort = new AbortController();
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: abort.signal, cache: "no-store" });
    if (!res.ok) {
      abort.abort();
      return {
        ok: false,
        status: res.status,
        range: "unknown",
        totalBytes: null,
        error: res.status === 404 ? "file not found (HTTP 404)" : `HTTP ${res.status} ${res.statusText}`,
      };
    }
    // Vite's SPA fallback answers unknown paths with index.html (200, text/html).
    const type = res.headers.get("content-type") ?? "";
    if (type.startsWith("text/html")) {
      abort.abort();
      return { ok: false, status: res.status, range: "unknown", totalBytes: null, error: "server returned an HTML page, not a model file (wrong path?)" };
    }
    const contentRange = res.headers.get("content-range");
    const total = contentRange ? Number(contentRange.split("/")[1]) : NaN;
    const range = res.status === 206 ? "ok" : res.status === 200 ? "ignored" : "unknown";
    // Don't download the whole file if Range was ignored.
    abort.abort();
    return { ok: true, status: res.status, range, totalBytes: Number.isFinite(total) ? total : null };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: true, status: 0, range: "unknown", totalBytes: null };
    }
    return { ok: false, status: 0, range: "unknown", totalBytes: null, error: `network error: ${(err as Error).message} (CORS?)` };
  }
}
