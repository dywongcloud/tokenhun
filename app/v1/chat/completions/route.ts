import { NextRequest } from "next/server";
import { proxyToTokenHub } from "@/lib/tokenhub";

// OpenAI-compatible Chat Completions (supports SSE streaming via `stream: true`).
export async function POST(req: NextRequest) {
  return proxyToTokenHub(req, "/v1/chat/completions");
}
