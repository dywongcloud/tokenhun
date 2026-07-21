import { NextRequest } from "next/server";
import { proxyToTokenHub } from "@/lib/tokenhub";

export const dynamic = "force-dynamic";

// OpenAI-compatible Batch object endpoints (retrieve, cancel, ...): the
// sub-path is forwarded verbatim so the mapping stays 1:1 with upstream.
async function forward(req: NextRequest, params: Promise<{ path: string[] }>) {
  const { path } = await params;
  return proxyToTokenHub(req, `/v1/batches/${path.join("/")}`);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, ctx.params);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, ctx.params);
}
