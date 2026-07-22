import { NextRequest } from "next/server";
import { proxyToTokenHub } from "@/lib/tokenhub";

// Vercel's real ceiling: 1800s (30 min, Pro/Enterprise beta) — see vercel.json.
export const maxDuration = 1800;

// TokenPlan (subscription plan) Anthropic-compatible Messages endpoint.
// Requires a TokenPlan API key (TOKENHUB_PLAN_API_KEY), distinct from standard keys.
export async function POST(req: NextRequest) {
  return proxyToTokenHub(req, "/plan/anthropic/v1/messages", {
    auth: "anthropic",
    plan: true,
  });
}
