import { NextRequest } from "next/server";
import { proxyToTokenHub } from "@/lib/tokenhub";

// TokenHub-native machine translation API (hy-mt2 models, persistent glossary support).
export async function POST(req: NextRequest) {
  return proxyToTokenHub(req, "/v1/api/translations");
}
