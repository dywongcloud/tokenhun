import { NextRequest } from "next/server";
import { proxyToTokenHub } from "@/lib/tokenhub";

export const dynamic = "force-dynamic";

// OpenAI-compatible model list (models/services visible to the API key).
export async function GET(req: NextRequest) {
  return proxyToTokenHub(req, "/v1/models");
}
