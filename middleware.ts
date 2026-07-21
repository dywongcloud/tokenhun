import { NextRequest, NextResponse } from "next/server";

// Guards every mapped TokenHub route with a proxy-level shared secret, so
// only callers who know PROXY_API_KEY can spend your TokenHub quota. This is
// checked BEFORE the request reaches lib/tokenhub.ts, which strips whatever
// Authorization/x-api-key header the client sent and substitutes the real
// upstream key — so the proxy key and the TokenHub key never mix.
export const config = {
  matcher: ["/v1/:path*", "/plan/:path*"],
};

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

function extractPresentedKey(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  const bearerMatch = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
  if (bearerMatch) return bearerMatch[1];

  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey) return xApiKey;

  return null;
}

export function middleware(req: NextRequest) {
  // Preflight requests carry no Authorization header by design; let them
  // through so browser-based CORS callers aren't blocked before their real,
  // authenticated request is even sent.
  if (req.method === "OPTIONS") return NextResponse.next();

  const expected = process.env.PROXY_API_KEY;
  if (!expected) {
    return NextResponse.json(
      {
        error: {
          message: "PROXY_API_KEY is not configured on the proxy server. Set it in .env.local.",
          type: "proxy_configuration_error",
          code: "missing_proxy_api_key",
        },
      },
      { status: 500 },
    );
  }

  const presented = extractPresentedKey(req);
  if (!presented || !timingSafeEqual(presented, expected)) {
    return NextResponse.json(
      {
        error: {
          message:
            "Invalid or missing proxy API key. Send it as 'Authorization: Bearer <key>' or 'x-api-key: <key>'.",
          type: "proxy_auth_error",
          code: presented ? "invalid_proxy_api_key" : "missing_proxy_api_key",
        },
      },
      { status: 401 },
    );
  }

  return NextResponse.next();
}
