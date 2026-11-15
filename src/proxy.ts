import { NextRequest, NextResponse } from "next/server";
import { buildCsp, canonicalRedirect } from "@/lib/security";

/**
 * Runs before every non-static request:
 *  1. Canonical HTTPS/host redirect (308, method-preserving) when enabled.
 *  2. Per-request CSP nonce for pages (Next attaches it to its inline scripts).
 */
export function proxy(request: NextRequest) {
  const url = request.nextUrl;
  const target = canonicalRedirect(
    {
      host: request.headers.get("host"),
      forwardedProto: request.headers.get("x-forwarded-proto"),
      pathAndQuery: `${url.pathname}${url.search}`,
    },
    {
      enabled: process.env.CANONICAL_REDIRECTS === "true",
      baseUrl: process.env.PUBLIC_BASE_URL || "https://thehosksaid.com",
      aliasHosts: (process.env.CANONICAL_ALIAS_HOSTS || "").split(","),
    }
  );
  if (target) return NextResponse.redirect(target, 308);

  if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") return NextResponse.next();

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === "development" });
  const headerName = process.env.CSP_REPORT_ONLY === "true" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(headerName, csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|images/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
