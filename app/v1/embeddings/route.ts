import { NextRequest } from "next/server";
import { proxyToTokenHub } from "@/lib/tokenhub";

// Vercel's real ceiling: 1800s (30 min, Pro/Enterprise beta) — see vercel.json.
export const maxDuration = 1800;

// OpenAI-compatible text embeddings (Kinfra text embedding models).
export async function POST(req: NextRequest) {
  return proxyToTokenHub(req, "/v1/embeddings");
}
