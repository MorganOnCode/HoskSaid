/**
 * Security-header policy (edge/proxy-safe: no Node-only imports).
 *
 * The Content-Security-Policy carries a per-request nonce, which Next applies
 * to its own inline scripts; that requires dynamic rendering, so public data is
 * cached at the data layer (lib/cache.ts) instead of as static HTML.
 */
export function buildCsp(nonce: string, opts: { dev?: boolean } = {}): string {
  const dev = !!opts.dev;
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "https://www.youtube.com", "https://s.ytimg.com", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https://i.ytimg.com"],
    "font-src": ["'self'"],
    "connect-src": ["'self'", ...(dev ? ["ws:"] : [])],
    "frame-src": ["https://www.youtube.com", "https://www.youtube-nocookie.com"],
    "media-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

/** Static headers for every response (set in next.config.ts). */
export const STATIC_SECURITY_HEADERS: { key: string; value: string }[] = [
  // One year, no includeSubDomains/preload: those are a separate, harder-to-undo decision.
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
];

/**
 * Canonical-origin redirect decision. Applies only when CANONICAL_REDIRECTS=true
 * (set by the production Compose file, whose only public ingress is the
 * Cloudflare tunnel, which forwards the visitor's scheme in X-Forwarded-Proto).
 * Loopback health checks and any host outside the configured set pass through.
 */
export function canonicalRedirect(
  req: { host: string | null; forwardedProto: string | null; pathAndQuery: string },
  env: { enabled: boolean; baseUrl: string; aliasHosts: string[] }
): string | null {
  if (!env.enabled || !req.host) return null;
  let base: URL;
  try {
    base = new URL(env.baseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "https:") return null;
  const host = req.host.toLowerCase();
  const aliases = new Set([`www.${base.host}`, ...env.aliasHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)]);
  aliases.delete(base.host);
  if (aliases.has(host)) return `${base.origin}${req.pathAndQuery}`;
  if (host === base.host && req.forwardedProto?.split(",")[0].trim().toLowerCase() === "http") {
    return `${base.origin}${req.pathAndQuery}`;
  }
  return null;
}

/**
 * Same-origin check for browser-only POST endpoints (the visitor-key
 * conversation). The browser always sends Origin on a cross-origin or POST
 * fetch; a missing, foreign or cross-site origin is refused, so another site
 * cannot drive visitors' keys (or this site's retrieval budget) through it.
 * Accepts the canonical public origin or the origin the request was addressed to.
 */
export function isSameOriginRequest(
  req: { origin: string | null; host: string | null; secFetchSite: string | null },
  baseUrl: string
): boolean {
  if (req.secFetchSite && req.secFetchSite !== "same-origin") return false;
  if (!req.origin || req.origin === "null") return false;
  let origin: URL;
  try {
    origin = new URL(req.origin);
  } catch {
    return false;
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") return false;
  try {
    if (origin.origin === new URL(baseUrl).origin) return true;
  } catch {
    /* fall through to the Host comparison */
  }
  return !!req.host && origin.host.toLowerCase() === req.host.toLowerCase();
}
