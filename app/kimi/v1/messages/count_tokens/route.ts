import { NextRequest } from "next/server";
import { proxyKimiCountTokens } from "@/lib/kimi";

export const maxDuration = 300;

// Synthesized locally: the upstream Anthropic surface has no count_tokens
// path, so the count comes from Moonshot's tokenizer endpoint instead.
export async function POST(req: NextRequest) {
  return proxyKimiCountTokens(req);
}
