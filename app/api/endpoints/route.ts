// Machine-readable service descriptor — lists every 1:1 mapped endpoint.
// Previously served at GET / before that path became the interactive
// terminal console; also used by the console's own `endpoints` command.
export async function GET() {
  return Response.json({
    service: "tokenhub-proxy",
    upstream: process.env.TOKENHUB_BASE_URL ?? "https://tokenhub-intl.tencentcloudmaas.com",
    endpoints: [
      { method: "POST", path: "/v1/chat/completions", protocol: "openai" },
      { method: "POST", path: "/v1/responses", protocol: "openai" },
      { method: "POST", path: "/v1/embeddings", protocol: "openai" },
      { method: "POST", path: "/v1/embeddings/multimodal", protocol: "tokenhub-native" },
      { method: "POST", path: "/v1/messages", protocol: "anthropic" },
      { method: "POST", path: "/v1/api/translations", protocol: "tokenhub-native" },
      { method: "GET", path: "/v1/models", protocol: "openai" },
      { method: "GET", path: "/v1/batches", protocol: "openai" },
      { method: "POST", path: "/v1/batches", protocol: "openai" },
      { method: "*", path: "/v1/batches/{...}", protocol: "openai" },
      { method: "POST", path: "/plan/anthropic/v1/messages", protocol: "anthropic (TokenPlan key)" },
    ],
  });
}
