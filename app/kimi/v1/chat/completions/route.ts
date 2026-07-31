import { NextRequest } from "next/server";
import { proxyKimiChatCompletions } from "@/lib/kimi";

export const maxDuration = 1800;

// OpenAI-compatible surface on the same deployment, for clients that would
// rather speak OpenAI than Anthropic; SSE via "stream": true.
export async function POST(req: NextRequest) {
  return proxyKimiChatCompletions(req);
}
