# tokenhub-proxy

A Next.js API proxy for [Tencent Cloud TokenHub](https://www.tencentcloud.com/document/product/1300/78941) (LLM Service gateway) with **1:1 endpoint mappings**. Your TokenHub API key stays server-side; clients call this proxy with the exact same paths, bodies, and streaming semantics as TokenHub itself.

## Endpoints (1:1 with TokenHub)

| Method | Path | Protocol | Notes |
|--------|------|----------|-------|
| POST | `/v1/chat/completions` | OpenAI-compatible | All language models; SSE via `stream: true` |
| POST | `/v1/responses` | OpenAI-compatible | Responses API (native: hy3, minimax-m3/m2.7/m2.5; compat: glm-5.2, deepseek-v4-*) |
| POST | `/v1/embeddings` | OpenAI-compatible | Kinfra text embeddings; input strings ≤ 2000 chars |
| POST | `/v1/embeddings/multimodal` | TokenHub-native | Fused text/image/video vectors (kinfra-vl-*) |
| POST | `/v1/messages` | Anthropic-compatible | Auth mapped to `x-api-key` upstream; Anthropic SSE events |
| POST | `/v1/api/translations` | TokenHub-native | hy-mt2 translation models, glossary support |
| GET | `/v1/models` | OpenAI-compatible | Models/services visible to your key |
| GET/POST | `/v1/batches` | OpenAI-compatible | Batch list/create |
| GET/POST | `/v1/batches/{...}` | OpenAI-compatible | Batch retrieve/cancel — sub-paths forwarded verbatim |
| POST | `/plan/anthropic/v1/messages` | Anthropic-compatible | TokenPlan surface — needs `TOKENHUB_PLAN_API_KEY` (subscription-plan key) |
| GET | `/` | — | Interactive terminal console (see below) |
| GET | `/api/endpoints` | — | Machine-readable service descriptor (formerly served at `GET /`) |

Endpoints that do **not** exist upstream (verified by live probe) and are therefore not mapped: `/v1/files`, `/v1/completions`, `/v1/rerank`, `/v1/messages/count_tokens`.

## Interactive console

`GET /` serves an xterm.js-based terminal console for exercising every endpoint above without leaving the browser — a REPL with a command per endpoint, each pre-filled with a working example body you can run as-is or override.

```
tokenhub ❯ auth set
Proxy API key (hidden): ••••••••••••••••••
Proxy key set (ending "…yday"). Stored in this browser only.

tokenhub ❯ chat "Say hello"
POST /v1/chat/completions
✓ 200 OK
{
  "id": "…",
  "choices": [ { "message": { "content": "Hello!" } } ],
  …
}

tokenhub ❯ chat.stream "Count to 3"
POST /v1/chat/completions (stream)
✓ 200 streaming…
1, 2, 3
```

- **Auth**: `auth set` prompts for `PROXY_API_KEY` without echoing it to the screen or recording it in command history; `auth <key>` sets it inline (faster, but visible in the terminal transcript, same tradeoff as passing a secret as a CLI argument anywhere); `auth clear` / bare `auth` clear or check status. The key is stored in `localStorage`, scoped to your browser, and never sent anywhere except as this same proxy's own `Authorization` header — it is not logged or persisted server-side.
- **Commands**: one per endpoint (`chat`, `chat.stream`, `messages`, `messages.stream`, `embeddings`, `embeddings.multimodal`, `translate`, `models`, `batches.list`, `batches.create`, `batches.get`, `plan.messages`), plus `endpoints`, `help`, `clear`, and `copy`. Every command accepts `--raw '<json>'` to fully replace its preset body. Run `help` for the full list, `help <command>` for usage.
- **Syntax highlighting**: JSON responses are colorized (keys/strings/numbers/booleans distinguished; long primitive arrays — e.g. embedding vectors — are truncated with a count so a 1024-float response doesn't flood the screen); the input line is colorized live as you type (command name, quoted strings, `--flags`).
- **Copy/paste**: drag-select text and press Ctrl/Cmd+C to copy it to the OS clipboard (does not also trigger cancel — that only fires on Ctrl+C with no active selection); the `copy` command copies the last response body directly. Ctrl/Cmd+V pastes from the OS clipboard into the input line, same as any native terminal.
- Every response is escaped before being written to the terminal (JSON string leaves via `JSON.stringify`'s own escaping, raw streamed text via an explicit sanitizer) so a model response containing a raw control byte can't be interpreted as a live terminal escape sequence.

## Setup

```bash
cp .env.example .env.local   # then paste your real key
npm install                  # or bun install
npm run dev                  # or: npm run build && npm start
```

`.env.local`:

```
TOKENHUB_API_KEY=sk-...                                      # required
TOKENHUB_BASE_URL=https://tokenhub-intl.tencentcloudmaas.com # optional (default)
TOKENHUB_PLAN_API_KEY=sk-...                                 # optional, TokenPlan only
PROXY_API_KEY=...                                            # required — see Auth below
```

Base URLs: Singapore `tokenhub-intl.tencentcloudmaas.com` (default), Guangzhou `tokenhub.tencentcloudmaas.com`; `.tech` variants of both exist as backup domains.

## Auth

The proxy itself is gated by a shared secret, `PROXY_API_KEY` — separate from
`TOKENHUB_API_KEY`, which never leaves the server. Every `/v1/*` and
`/plan/*` request must present it one of three ways: `Authorization: Bearer
<PROXY_API_KEY>`, `x-api-key: <PROXY_API_KEY>`, or `?api_key=<PROXY_API_KEY>`
in the URL; requests without a matching key get a `401` before anything is
forwarded upstream. If more than one is sent, a header wins over the query
param. A missing `PROXY_API_KEY` on the server fails closed (`500`) rather
than silently allowing all traffic.

The query-string form exists for contexts that can't set custom headers —
e.g. a browser `EventSource` consuming an SSE stream directly, or a quick
link for manual testing. Prefer a header when you control the client: query
strings are more likely to end up in server access logs or shell history.
`?api_key=` is always stripped before the request reaches TokenHub, so it
never leaks upstream, but every other query param (e.g. `GET /v1/batches`
pagination) still passes through untouched.

This is the header the client-facing SDK's `apiKey` field carries — set it to
`PROXY_API_KEY`, not your TokenHub key:

```ts
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:3000/v1", apiKey: process.env.PROXY_API_KEY });
const res = await client.chat.completions.create({
  model: "deepseek-v4-flash",
  messages: [{ role: "user", content: "hello" }],
  stream: true,
});
```

Or an Anthropic SDK (base URL **without** `/v1` — the SDK appends `/v1/messages`):

```ts
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "http://localhost:3000", apiKey: process.env.PROXY_API_KEY });
```

The middleware reads whichever header the SDK sends (`Authorization: Bearer`
for OpenAI, `x-api-key` for Anthropic) and validates it against
`PROXY_API_KEY` with a constant-time comparison; `lib/tokenhub.ts` then
strips that header and substitutes the real TokenHub key before forwarding,
so the proxy key and the TokenHub key never mix and the client-supplied key
never reaches Tencent.

## Behavior

- **1:1 forwarding**: method, path, query string, headers (minus hop-by-hop + auth), and body pass through verbatim; upstream status codes and bodies (including error JSON) are returned unmodified.
- **Streaming**: SSE responses (OpenAI `data:` chunks, Anthropic named events) stream through untouched.
- **Request bodies are buffered** (not streamed) before forwarding — TokenHub responds early on some routes (e.g. auth errors) and a buffered body is replayable; response streaming is unaffected.
- **Auth mapping**: OpenAI-protocol routes send `Authorization: Bearer <key>`; Anthropic-protocol routes send `x-api-key: <key>` (upstream accepts both). Vendor headers such as `HY-Preserved-Thinking` and `anthropic-version` pass through.
- **Errors originating in the proxy itself** (missing key, upstream unreachable) use OpenAI error shape with `type: "proxy_configuration_error" | "proxy_upstream_error"` so they are distinguishable from upstream `gateway_error` responses.

## Models (as listed by `GET /v1/models`, 2026-07)

LLMs: `hy3`, `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-202605`, `deepseek-v4-pro-202606`, `deepseek-v3.2`, `glm-5.2`, `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-5v-turbo`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6`, `kimi-k2.5`, `minimax-m3`, `minimax-m2.7`, `minimax-m2.5` · Translation: `hy-mt2-plus` · Embeddings: `kinfra-text-embedding-0.6b/4b`, `kinfra-vl-embedding-2b/8b`

## Deployment notes

- Long streaming responses need a runtime without short function timeouts (self-hosted `next start`, or set an adequate `maxDuration` on your platform).
- `PROXY_API_KEY` gates every mapped endpoint (see Auth above); rotate it the same way you'd rotate any shared secret, and still put the proxy behind your own network controls if it's internet-facing — a single static shared key is not a substitute for per-client credentials or rate limiting.
