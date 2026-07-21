import { NextRequest } from "next/server";
import { proxyToTokenHub } from "@/lib/tokenhub";

export const dynamic = "force-dynamic";

// OpenAI-compatible Batch API: list and create.
export async function GET(req: NextRequest) {
  return proxyToTokenHub(req, "/v1/batches");
}

export async function POST(req: NextRequest) {
  return proxyToTokenHub(req, "/v1/batches");
}
