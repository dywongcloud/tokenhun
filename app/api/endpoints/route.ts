// Machine-readable service descriptor — lists every mapped endpoint.
// Previously served at GET / before that path became the interactive
// terminal console; also used by the console's own `endpoints` command.
export async function GET() {
  return Response.json({
    service: "tokenhub-proxy",
    upstreams: {
      tokenhub: process.env.TOKENHUB_BASE_URL ?? "https://tokenhub-intl.tencentcloudmaas.com",
      kimi: process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai",
    },
    endpoints: [
      { method: "POST", path: "/v1/chat/completions", protocol: "openai", surface: "tokenhub" },
      { method: "POST", path: "/v1/responses", protocol: "openai", surface: "tokenhub" },
      { method: "POST", path: "/v1/embeddings", protocol: "openai", surface: "tokenhub" },
      { method: "POST", path: "/v1/embeddings/multimodal", protocol: "tokenhub-native", surface: "tokenhub" },
      { method: "POST", path: "/v1/messages", protocol: "anthropic", surface: "tokenhub" },
      { method: "POST", path: "/v1/api/translations", protocol: "tokenhub-native", surface: "tokenhub" },
      { method: "GET", path: "/v1/models", protocol: "openai", surface: "tokenhub" },
      { method: "GET", path: "/v1/batches", protocol: "openai", surface: "tokenhub" },
      { method: "POST", path: "/v1/batches", protocol: "openai", surface: "tokenhub" },
      { method: "*", path: "/v1/batches/{...}", protocol: "openai", surface: "tokenhub" },
      { method: "POST", path: "/plan/anthropic/v1/messages", protocol: "anthropic (TokenPlan key)", surface: "tokenhub" },
      { method: "POST", path: "/kimi/v1/messages", protocol: "anthropic", surface: "kimi" },
      { method: "POST", path: "/kimi/v1/messages/count_tokens", protocol: "anthropic", surface: "kimi" },
      { method: "GET", path: "/kimi/v1/models", protocol: "anthropic", surface: "kimi" },
      { method: "POST", path: "/kimi/v1/chat/completions", protocol: "openai", surface: "kimi" },
    ],
  });
}
