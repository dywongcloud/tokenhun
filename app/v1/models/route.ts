import { NextRequest } from "next/server";
import { proxyToTokenHub } from "@/lib/tokenhub";

export const dynamic = "force-dynamic";
// Vercel's real ceiling: 1800s (30 min, Pro/Enterprise beta) — see vercel.json.
export const maxDuration = 1800;

// OpenAI-compatible model list (models/services visible to the API key).
export async function GET(req: NextRequest) {
  return proxyToTokenHub(req, "/v1/models");
}
