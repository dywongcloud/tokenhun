import { NextRequest } from "next/server";
import { proxyToTokenHub } from "@/lib/tokenhub";

// OpenAI-compatible text embeddings (Kinfra text embedding models).
export async function POST(req: NextRequest) {
  return proxyToTokenHub(req, "/v1/embeddings");
}
