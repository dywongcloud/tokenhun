import { NextRequest } from "next/server";
import {
  PROXY_API_KEY_QUERY_PARAM,
  UpstreamUnreachableError,
  fetchWithTransientRetry,
  forwardableRequestHeaders,
  forwardableResponseHeaders,
} from "@/lib/upstream";

const DEFAULT_BASE_URL = "https://tokenhub-intl.tencentcloudmaas.com";

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

  const headers = forwardableRequestHeaders(req);
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
  let retries: number;
  try {
    ({ response: upstream, retries } = await fetchWithTransientRetry(
      url,
      { method: req.method, headers, body, redirect: "manual", cache: "no-store" },
      req.signal,
    ));
  } catch (err) {
    if (!(err instanceof UpstreamUnreachableError)) throw err;
    const errorHeaders = new Headers();
    if (err.retries > 0) errorHeaders.set("x-tokenhub-proxy-retries", String(err.retries));
    return Response.json(
      {
        error: {
          message: `Upstream TokenHub request failed: ${err.message}`,
          type: "proxy_upstream_error",
          code: "upstream_unreachable",
        },
      },
      { status: 502, headers: errorHeaders },
    );
  }

  const responseHeaders = forwardableResponseHeaders(upstream);
  if (retries > 0) responseHeaders.set("x-tokenhub-proxy-retries", String(retries));

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
