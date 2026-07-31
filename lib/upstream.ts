import { NextRequest } from "next/server";

// Shared with middleware.ts: the query param name it accepts as an
// alternative to Authorization/x-api-key headers for a proxy's own key.
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

// Transient-failure retry budget, shared across two distinct causes:
//  - TPM (tokens-per-minute) 429s: a rolling 1-minute window, so a burst that
//    trips it typically clears within a couple of seconds.
//  - 502/503/504 and network-level throws (ECONNRESET, socket hang up, DNS
//    blips): momentary connectivity/capacity hiccups between this server and
//    the upstream, unrelated to the request itself.
// 500 is deliberately excluded: it means the upstream's application code
// errored on this specific request, which an identical retry would most likely
// just reproduce, unlike the connectivity/capacity issues above.
const MAX_TRANSIENT_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 1000;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

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

/** Copies the caller's headers minus hop-by-hop and client-supplied credentials. */
export function forwardableRequestHeaders(req: NextRequest): Headers {
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  return headers;
}

export function forwardableResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  return headers;
}

export class UpstreamUnreachableError extends Error {
  readonly retries: number;

  constructor(cause: unknown, retries: number) {
    const detail = cause instanceof Error && cause.cause ? ` (${String(cause.cause)})` : "";
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`${message}${detail}`);
    this.name = "UpstreamUnreachableError";
    this.retries = retries;
  }
}

export interface UpstreamResult {
  response: Response;
  retries: number;
}

/**
 * Performs the upstream fetch, retrying only the transient failure classes
 * described above. Throws UpstreamUnreachableError when the network itself
 * never yielded a response within the retry budget; every other outcome
 * (including 4xx/5xx) is returned for the caller to shape.
 */
export async function fetchWithTransientRetry(
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<UpstreamResult> {
  let retries = 0;
  while (true) {
    let response: Response | undefined;
    let networkError: unknown;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (err) {
      networkError = err;
    }

    const retryableStatus = response !== undefined && RETRYABLE_STATUSES.has(response.status);
    if ((networkError === undefined && !retryableStatus) || retries >= MAX_TRANSIENT_RETRIES) {
      if (networkError !== undefined) throw new UpstreamUnreachableError(networkError, retries);
      return { response: response!, retries };
    }

    const retryAfterMs = response ? parseRetryAfterMs(response.headers.get("retry-after")) : null;
    const delayMs = retryAfterMs ?? BASE_RETRY_DELAY_MS * 2 ** retries;
    retries++;
    await sleep(delayMs, signal);
  }
}
