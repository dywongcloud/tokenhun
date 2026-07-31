import { NextRequest } from "next/server";
import { proxyKimiModels } from "@/lib/kimi";

export const maxDuration = 300;

// Synthesized locally: the upstream Anthropic surface has no models path, so
// the OpenAI-shaped list is re-enveloped into the Anthropic one.
export async function GET(req: NextRequest) {
  return proxyKimiModels(req);
}
