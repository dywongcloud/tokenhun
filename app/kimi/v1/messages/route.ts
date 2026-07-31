import { NextRequest } from "next/server";
import { proxyKimiMessages } from "@/lib/kimi";

// Vercel's real ceiling: 1800s (30 min, Pro/Enterprise beta) — see vercel.json.
export const maxDuration = 1800;

// Anthropic-compatible Messages API backed by Moonshot's native Anthropic
// endpoint; supports SSE streaming via "stream": true.
export async function POST(req: NextRequest) {
  return proxyKimiMessages(req);
}
