import { NextRequest } from "next/server";
import { proxyToTokenHub } from "@/lib/tokenhub";

// TokenHub-native multimodal embeddings (fused text + image + video vectors).
export async function POST(req: NextRequest) {
  return proxyToTokenHub(req, "/v1/embeddings/multimodal");
}
