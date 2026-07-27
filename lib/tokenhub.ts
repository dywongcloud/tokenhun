import { NextRequest } from "next/server";

const DEFAULT_BASE_URL = "https://tokenhub-intl.tencentcloudmaas.com";

// Shared with middleware.ts: the query param name it accepts as an
// alternative to Authorization/x-api-key headers for the proxy's own key.
export const PROXY_API_KEY_QUERY_PARAM = "api_key";

/** Hop-by-hop / connection-managed headers that must not be forwarded either direction. */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "content-length",
  "accept-encoding",
  "authorization",
  "x-api-key",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

// TokenHub's TPM (tokens-per-minute) limit is a rolling 1-minute window, so a
// burst that trips it typically clears within a couple of seconds — retrying
// with backoff turns a transient 429 into a slightly slower success instead
// of a hard error every time usage briefly spikes over the ceiling.
const MAX_RATE_LIMIT_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 1000;

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ProxyOptions {
  /**
   * Auth style expected by the upstream endpoint:
   * - "bearer": Authorization: Bearer <key> (OpenAI-compatible endpoints)
   * - "anthropic": x-api-key: <key> plus anthropic-version passthrough (Anthropic-compatible endpoints)
   * Both headers are accepted by TokenHub, but we send the canonical one per protocol.
   */
  auth?: "bearer" | "anthropic";
  /**
   * The TokenPlan surface (/plan/...) uses subscription-plan API keys, which are
   * separate from standard TokenHub keys. Falls back to TOKENHUB_API_KEY if
   * TOKENHUB_PLAN_API_KEY is unset.
   */
  plan?: boolean;
}

/**
 * Forward a request 1:1 to the TokenHub API and stream the response back.
 * The upstream path is mapped verbatim; method, body, and SSE streams pass
 * through untouched, and so does the query string except for a stripped
 * ?api_key= (the proxy's own credential, never the caller's). The TokenHub
 * API key never leaves the server.
 */
export async function proxyToTokenHub(
  req: NextRequest,
  upstreamPath: string,
  opts: ProxyOptions = {},
): Promise<Response> {
  const apiKey =
    (opts.plan ? process.env.TOKENHUB_PLAN_API_KEY : undefined) ??
    process.env.TOKENHUB_API_KEY;
  if (!apiKey) {
    return Response.json(
      {
        error: {
          message:
            "TOKENHUB_API_KEY is not configured on the proxy server. Set it in .env.local.",
          type: "proxy_configuration_error",
          code: "missing_api_key",
        },
      },
      { status: 500 },
    );
  }

  const baseUrl = (process.env.TOKENHUB_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = new URL(baseUrl + upstreamPath);
  url.search = req.nextUrl.search;
  // The proxy's own key may have been presented as ?api_key=... (see
  // middleware.ts); it must never reach TokenHub, so it never enters the
  // 1:1-forwarded query string. Left untouched when absent, so every other
  // query param (e.g. GET /v1/batches pagination) still passes through raw.
  if (url.searchParams.has(PROXY_API_KEY_QUERY_PARAM)) {
    url.searchParams.delete(PROXY_API_KEY_QUERY_PARAM);
  }

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  if (opts.auth === "anthropic") {
    headers.set("x-api-key", apiKey);
  } else {
    headers.set("authorization", `Bearer ${apiKey}`);
  }

  // Buffer the request body rather than streaming it: TokenHub responds early
  // (e.g. auth errors) on some routes, and undici cannot replay a stream body,
  // which surfaces as "fetch failed: expected non-null body source". Requests
  // are JSON; buffering also gives upstream an exact Content-Length.
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : undefined;

  let upstream: Response;
  let retries = 0;
  try {
    while (true) {
      upstream = await fetch(url, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        cache: "no-store",
        signal: req.signal,
      });
      if (upstream.status !== 429 || retries >= MAX_RATE_LIMIT_RETRIES) break;
      const retryAfterMs = parseRetryAfterMs(upstream.headers.get("retry-after"));
      const delayMs = retryAfterMs ?? BASE_RETRY_DELAY_MS * 2 ** retries;
      retries++;
      await sleep(delayMs, req.signal);
    }
  } catch (err) {
    const cause = err instanceof Error && err.cause ? ` (${String(err.cause)})` : "";
    return Response.json(
      {
        error: {
          message: `Upstream TokenHub request failed: ${err instanceof Error ? err.message : String(err)}${cause}`,
          type: "proxy_upstream_error",
          code: "upstream_unreachable",
        },
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  });
  if (retries > 0) responseHeaders.set("x-tokenhub-proxy-retries", String(retries));

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
