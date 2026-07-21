import { NextRequest } from "next/server";
import { proxyToTokenHub } from "@/lib/tokenhub";

// Anthropic-compatible Messages API (x-api-key auth upstream; supports SSE streaming).
export async function POST(req: NextRequest) {
  return proxyToTokenHub(req, "/v1/messages", { auth: "anthropic" });
}
