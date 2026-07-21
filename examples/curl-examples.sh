#!/usr/bin/env bash
# Runnable usage examples for tokenhub-proxy, authenticated with PROXY_API_KEY.
#
#   PROXY_API_KEY=... ./examples/curl-examples.sh
#   PROXY_API_KEY=... BASE_URL=https://proxy.example.com ./examples/curl-examples.sh
#
# PROXY_API_KEY must match the value set in .env.local on the proxy server —
# it is deliberately NOT hardcoded here so a real key never ends up in git history.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
if [ -z "${PROXY_API_KEY:-}" ]; then
  echo "Set PROXY_API_KEY to the value configured in the proxy's .env.local, e.g.:" >&2
  echo "  PROXY_API_KEY=your-key ./examples/curl-examples.sh" >&2
  exit 1
fi

echo "=== Non-streaming chat completion ==="
curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Say hello in one short sentence."}],
    "max_tokens": 40
  }'
echo -e "\n"

echo "=== Streaming chat completion (SSE) ==="
curl -sN -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Count from 1 to 3."}],
    "max_tokens": 40,
    "stream": true
  }'
echo -e "\n"

echo "=== Anthropic-protocol messages (x-api-key also accepted) ==="
curl -s -X POST "$BASE_URL/v1/messages" \
  -H "x-api-key: $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "max_tokens": 40,
    "messages": [{"role": "user", "content": "Say hello in one short sentence."}]
  }'
echo -e "\n"

echo "=== List models ==="
curl -s "$BASE_URL/v1/models" \
  -H "Authorization: Bearer $PROXY_API_KEY"
echo -e "\n"

echo "=== List models, authenticated via ?api_key= instead of a header ==="
echo "    (for clients that can't set custom headers, e.g. a browser EventSource)"
curl -s -G "$BASE_URL/v1/models" \
  --data-urlencode "api_key=$PROXY_API_KEY"
echo -e "\n"

echo "=== Missing/wrong proxy key -> 401 from the proxy itself (never reaches TokenHub) ==="
curl -s -w '\n[status=%{http_code}]\n' "$BASE_URL/v1/models" \
  -H "Authorization: Bearer wrong-key"
