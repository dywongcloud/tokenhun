import { NextRequest } from "next/server";
import {
  UpstreamUnreachableError,
  fetchWithTransientRetry,
  forwardableResponseHeaders,
} from "@/lib/upstream";

const DEFAULT_BASE_URL = "https://api.moonshot.ai";
const DEFAULT_MODEL = "kimi-k3";

// Moonshot serves a native Anthropic Messages API under this prefix, so the
// proxy forwards rather than translating. Its OpenAI-compatible surface lives
// at /v1 on the same host.
const ANTHROPIC_PREFIX = "/anthropic";
const OPENAI_PREFIX = "/v1";

const TOKENIZER_PATH = "/v1/tokenizers/estimate-token-count";

export interface KimiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type ConfigResult = { ok: true; config: KimiConfig } | { ok: false; response: Response };

const ANTHROPIC_ERROR_TYPE_BY_STATUS: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  422: "invalid_request_error",
  429: "rate_limit_error",
  529: "overloaded_error",
};

function anthropicErrorType(status: number): string {
  return ANTHROPIC_ERROR_TYPE_BY_STATUS[status] ?? (status >= 500 ? "api_error" : "invalid_request_error");
}

export function anthropicError(status: number, message: string, type?: string): Response {
  return Response.json(
    { type: "error", error: { type: type ?? anthropicErrorType(status), message } },
    { status },
  );
}

export function kimiConfig(): ConfigResult {
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      response: anthropicError(
        500,
        "KIMI_API_KEY is not configured on the proxy server. Set it in .env.local.",
        "api_error",
      ),
    };
  }
  return {
    ok: true,
    config: {
      apiKey,
      baseUrl: (process.env.KIMI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
      model: process.env.KIMI_MODEL ?? DEFAULT_MODEL,
    },
  };
}

/**
 * The upstream accepts any model string and echoes it back rather than
 * rejecting it, so an un-coerced "claude-sonnet-4-5" request would silently
 * run on something other than the model this proxy advertises. Anything not
 * already naming a Kimi model is therefore rewritten to the configured one.
 */
export function coerceModel(requested: unknown, configured: string): string {
  return typeof requested === "string" && requested.startsWith("kimi-") ? requested : configured;
}

function upstreamHeaders(apiKey: string): Headers {
  // Deliberately not a copy of the caller's headers: client feature flags
  // (anthropic-beta) and SDK telemetry (x-stainless-*) are not implemented
  // upstream, and forwarding them risks a rejection for no benefit. Prompt
  // caching upstream is automatic and needs no opt-in header.
  return new Headers({ "content-type": "application/json", "x-api-key": apiKey });
}

async function readJsonBody(req: NextRequest): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, response: anthropicError(400, "Could not read the request body.") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, response: anthropicError(400, `Request body is not valid JSON: ${detail}`) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: anthropicError(400, "Request body must be a JSON object.") };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

function upstreamMessage(parsed: Record<string, unknown>, fallback: string): string {
  const error = parsed.error;
  if (error !== null && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") {
    return (error as Record<string, unknown>).message as string;
  }
  // The gateway's routing failures put a machine-readable code in `error` and
  // a localized phrase in `message`; the code plus the path it could not route
  // is the part a caller can act on.
  if (typeof error === "string") {
    const target = [parsed.method, parsed.url].filter((part) => typeof part === "string").join(" ");
    return target ? `${error} (${target})` : error;
  }
  if (typeof parsed.message === "string") return parsed.message;
  return fallback;
}

/**
 * Upstream failures are not Anthropic-shaped (its gateway emits
 * {code, error, message, scode, ...}), which an Anthropic SDK client cannot
 * parse into a meaningful exception. Anything that is not already a
 * {type:"error"} envelope is rewritten into one.
 */
async function normalizeErrorResponse(upstream: Response, retries: number): Promise<Response> {
  let text: string;
  try {
    text = await upstream.text();
  } catch (err) {
    // The connection dropped mid-read of an already-non-ok response; degrade
    // to a named error rather than letting the read failure propagate uncaught.
    const detail = err instanceof Error ? err.message : String(err);
    const response = anthropicError(upstream.status, `Upstream returned ${upstream.status} but its body could not be read: ${detail}`, "api_error");
    if (retries > 0) response.headers.set("x-kimi-proxy-retries", String(retries));
    return response;
  }
  let message = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.type === "error" && parsed?.error?.message) {
      const headers = new Headers({ "content-type": "application/json" });
      if (retries > 0) headers.set("x-kimi-proxy-retries", String(retries));
      return new Response(text, { status: upstream.status, headers });
    }
    message = upstreamMessage(parsed ?? {}, text);
  } catch {
    // Non-JSON upstream body (e.g. an HTML gateway page); use it verbatim.
  }
  const response = anthropicError(upstream.status, message || `Upstream returned ${upstream.status}.`);
  if (retries > 0) response.headers.set("x-kimi-proxy-retries", String(retries));
  return response;
}

function streamedResponse(upstream: Response, retries: number): Response {
  const headers = forwardableResponseHeaders(upstream);
  if (retries > 0) headers.set("x-kimi-proxy-retries", String(retries));
  // Defeats buffering by intermediaries that would otherwise hold the SSE
  // stream and deliver it as one delayed blob.
  if (headers.get("content-type")?.includes("text/event-stream")) {
    headers.set("x-accel-buffering", "no");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function forward(
  config: KimiConfig,
  upstreamPath: string,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  let upstream: Response;
  let retries: number;
  try {
    ({ response: upstream, retries } = await fetchWithTransientRetry(
      new URL(config.baseUrl + upstreamPath),
      {
        method: "POST",
        headers: upstreamHeaders(config.apiKey),
        body,
        redirect: "manual",
        cache: "no-store",
      },
      signal,
    ));
  } catch (err) {
    if (!(err instanceof UpstreamUnreachableError)) throw err;
    const response = anthropicError(502, `Upstream Moonshot request failed: ${err.message}`, "api_error");
    if (err.retries > 0) response.headers.set("x-kimi-proxy-retries", String(err.retries));
    return response;
  }

  if (!upstream.ok) return normalizeErrorResponse(upstream, retries);
  return streamedResponse(upstream, retries);
}

/**
 * POST /v1/messages against Moonshot's native Anthropic surface. The only
 * mutation is model coercion; every other field is forwarded as sent.
 */
export async function proxyKimiMessages(req: NextRequest): Promise<Response> {
  const cfg = kimiConfig();
  if (!cfg.ok) return cfg.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;

  const body: Record<string, unknown> = {
    ...parsed.body,
    model: coerceModel(parsed.body.model, cfg.config.model),
  };
  if (!Array.isArray(body.messages)) {
    return anthropicError(400, "'messages' is required and must be an array.");
  }
  if (typeof body.max_tokens !== "number") {
    return anthropicError(400, "'max_tokens' is required and must be a number.");
  }

  return forward(cfg.config, `${ANTHROPIC_PREFIX}/v1/messages`, JSON.stringify(body), req.signal);
}

function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (block === null || typeof block !== "object") return "";
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text":
      return typeof b.text === "string" ? b.text : "";
    case "thinking":
      return typeof b.thinking === "string" ? b.thinking : "";
    case "tool_use":
      return `${String(b.name ?? "")} ${JSON.stringify(b.input ?? {})}`;
    case "tool_result":
      return Array.isArray(b.content)
        ? b.content.map(blockText).join("\n")
        : typeof b.content === "string"
          ? b.content
          : "";
    default:
      return "";
  }
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join("\n");
  return "";
}

/**
 * The tokenizer endpoint takes OpenAI-shaped messages, so Anthropic content
 * blocks are flattened to their text. Image blocks contribute no countable
 * text and are therefore under-counted; tool definitions are included as a
 * system message because they do occupy context.
 */
function flattenForTokenizer(body: Record<string, unknown>): { role: string; content: string }[] {
  const messages: { role: string; content: string }[] = [];

  const system = flattenContent(body.system);
  if (system) messages.push({ role: "system", content: system });

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    messages.push({ role: "system", content: JSON.stringify(body.tools) });
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message === null || typeof message !== "object") continue;
      const m = message as Record<string, unknown>;
      const content = flattenContent(m.content);
      if (!content) continue;
      messages.push({ role: m.role === "assistant" ? "assistant" : "user", content });
    }
  }

  return messages;
}

/**
 * Anthropic's count_tokens has no upstream equivalent (that path 404s), so the
 * count is computed with Moonshot's own tokenizer rather than estimated.
 */
export async function proxyKimiCountTokens(req: NextRequest): Promise<Response> {
  const cfg = kimiConfig();
  if (!cfg.ok) return cfg.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  if (!Array.isArray(parsed.body.messages)) {
    return anthropicError(400, "'messages' is required and must be an array.");
  }

  const messages = flattenForTokenizer(parsed.body);
  if (messages.length === 0) return Response.json({ input_tokens: 0 });

  let upstream: Response;
  try {
    ({ response: upstream } = await fetchWithTransientRetry(
      new URL(cfg.config.baseUrl + TOKENIZER_PATH),
      {
        method: "POST",
        headers: new Headers({
          "content-type": "application/json",
          authorization: `Bearer ${cfg.config.apiKey}`,
        }),
        body: JSON.stringify({ model: coerceModel(parsed.body.model, cfg.config.model), messages }),
        redirect: "manual",
        cache: "no-store",
      },
      req.signal,
    ));
  } catch (err) {
    if (!(err instanceof UpstreamUnreachableError)) throw err;
    return anthropicError(502, `Upstream Moonshot tokenizer request failed: ${err.message}`, "api_error");
  }

  if (!upstream.ok) return normalizeErrorResponse(upstream, 0);

  const payload = await upstream.json().catch(() => null);
  const total = payload?.data?.total_tokens;
  if (typeof total !== "number") {
    return anthropicError(502, "Upstream tokenizer returned an unrecognized response shape.", "api_error");
  }
  return Response.json({ input_tokens: total });
}

/**
 * Anthropic's model list has no upstream equivalent (that path 404s), so the
 * OpenAI-shaped list is re-enveloped into the Anthropic one.
 */
export async function proxyKimiModels(req: NextRequest): Promise<Response> {
  const cfg = kimiConfig();
  if (!cfg.ok) return cfg.response;

  let upstream: Response;
  try {
    ({ response: upstream } = await fetchWithTransientRetry(
      new URL(`${cfg.config.baseUrl}${OPENAI_PREFIX}/models`),
      {
        method: "GET",
        headers: new Headers({ authorization: `Bearer ${cfg.config.apiKey}` }),
        redirect: "manual",
        cache: "no-store",
      },
      req.signal,
    ));
  } catch (err) {
    if (!(err instanceof UpstreamUnreachableError)) throw err;
    return anthropicError(502, `Upstream Moonshot request failed: ${err.message}`, "api_error");
  }

  if (!upstream.ok) return normalizeErrorResponse(upstream, 0);

  const payload = await upstream.json().catch(() => null);
  const models = Array.isArray(payload?.data) ? payload.data : [];
  const data = models
    .filter((model: unknown) => typeof (model as Record<string, unknown>)?.id === "string")
    .map((model: Record<string, unknown>) => ({
      type: "model",
      id: String(model.id),
      display_name: String(model.id),
      created_at: new Date(Number(model.created ?? 0) * 1000).toISOString(),
    }))
    // Moonshot returns this list in non-deterministic order across identical
    // calls; sorting makes the response (and its first_id/last_id) stable, so
    // a caller diffing two calls doesn't see a spurious "change".
    .sort((a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return Response.json({
    data,
    has_more: false,
    first_id: data.length > 0 ? data[0].id : null,
    last_id: data.length > 0 ? data[data.length - 1].id : null,
  });
}

/**
 * The OpenAI-compatible surface, forwarded verbatim apart from model coercion,
 * so OpenAI-SDK clients can share this deployment without the Anthropic shape.
 */
export async function proxyKimiChatCompletions(req: NextRequest): Promise<Response> {
  const cfg = kimiConfig();
  if (!cfg.ok) return cfg.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;

  const body: Record<string, unknown> = {
    ...parsed.body,
    model: coerceModel(parsed.body.model, cfg.config.model),
  };

  let upstream: Response;
  let retries: number;
  try {
    ({ response: upstream, retries } = await fetchWithTransientRetry(
      new URL(`${cfg.config.baseUrl}${OPENAI_PREFIX}/chat/completions`),
      {
        method: "POST",
        headers: new Headers({
          "content-type": "application/json",
          authorization: `Bearer ${cfg.config.apiKey}`,
        }),
        body: JSON.stringify(body),
        redirect: "manual",
        cache: "no-store",
      },
      req.signal,
    ));
  } catch (err) {
    if (!(err instanceof UpstreamUnreachableError)) throw err;
    return Response.json(
      {
        error: {
          message: `Upstream Moonshot request failed: ${err.message}`,
          type: "proxy_upstream_error",
          code: "upstream_unreachable",
        },
      },
      { status: 502 },
    );
  }

  return streamedResponse(upstream, retries);
}
