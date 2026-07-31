import { NextRequest, NextResponse } from "next/server";
import { PROXY_API_KEY_QUERY_PARAM } from "@/lib/upstream";

// Guards every mapped upstream route with a proxy-level shared secret, so only
// callers who know it can spend your quota. This is checked BEFORE the request
// reaches lib/tokenhub.ts or lib/kimi.ts, which strip whatever
// Authorization/x-api-key header (or ?api_key= query param) the client sent
// and substitute the real upstream key — so the proxy key and the upstream key
// never mix, and the proxy key never reaches the upstream either way.
export const config = {
  matcher: ["/v1/:path*", "/plan/:path*", "/kimi/:path*"],
};

interface GuardedSurface {
  prefix: string;
  keyEnv: string;
  /** Which error envelope this surface's clients can parse. */
  protocol: "openai" | "anthropic";
}

// Ordered: the first matching prefix wins, so more specific paths come first.
// Each surface has its own shared secret, so revoking access to one does not
// revoke the other.
const GUARDED_SURFACES: GuardedSurface[] = [
  { prefix: "/kimi/v1/chat/completions", keyEnv: "KIMI_PROXY_API_KEY", protocol: "openai" },
  { prefix: "/kimi", keyEnv: "KIMI_PROXY_API_KEY", protocol: "anthropic" },
  { prefix: "/v1", keyEnv: "PROXY_API_KEY", protocol: "openai" },
  { prefix: "/plan", keyEnv: "PROXY_API_KEY", protocol: "openai" },
];

function matchSurface(pathname: string): GuardedSurface | null {
  return (
    GUARDED_SURFACES.find(
      (surface) => pathname === surface.prefix || pathname.startsWith(`${surface.prefix}/`),
    ) ?? null
  );
}

interface ErrorShape {
  status: number;
  message: string;
  anthropicType: string;
  openaiType: string;
  openaiCode: string;
}

function errorResponse(surface: GuardedSurface, shape: ErrorShape): NextResponse {
  const body =
    surface.protocol === "anthropic"
      ? { type: "error", error: { type: shape.anthropicType, message: shape.message } }
      : { error: { message: shape.message, type: shape.openaiType, code: shape.openaiCode } };
  return NextResponse.json(body, { status: shape.status });
}

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

// Headers take precedence over the query param when more than one is
// present; most callers send exactly one, so this only matters for a
// caller mixing both, in which case the header is treated as authoritative.
function extractPresentedKey(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  const bearerMatch = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
  if (bearerMatch) return bearerMatch[1];

  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey) return xApiKey;

  const queryKey = req.nextUrl.searchParams.get(PROXY_API_KEY_QUERY_PARAM);
  if (queryKey) return queryKey;

  return null;
}

export function middleware(req: NextRequest) {
  // Preflight requests carry no Authorization header by design; let them
  // through so browser-based CORS callers aren't blocked before their real,
  // authenticated request is even sent.
  if (req.method === "OPTIONS") return NextResponse.next();

  const surface = matchSurface(req.nextUrl.pathname);
  if (!surface) return NextResponse.next();

  const expected = process.env[surface.keyEnv];
  if (!expected) {
    return errorResponse(surface, {
      status: 500,
      message: `${surface.keyEnv} is not configured on the proxy server. Set it in .env.local.`,
      anthropicType: "api_error",
      openaiType: "proxy_configuration_error",
      openaiCode: "missing_proxy_api_key",
    });
  }

  const presented = extractPresentedKey(req);
  if (!presented || !timingSafeEqual(presented, expected)) {
    return errorResponse(surface, {
      status: 401,
      message:
        "Invalid or missing proxy API key. Send it as 'Authorization: Bearer <key>', 'x-api-key: <key>', or '?api_key=<key>'.",
      anthropicType: "authentication_error",
      openaiType: "proxy_auth_error",
      openaiCode: presented ? "invalid_proxy_api_key" : "missing_proxy_api_key",
    });
  }

  return NextResponse.next();
}
