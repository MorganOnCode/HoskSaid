/**
 * In-memory token-bucket rate limiting + tiny TTL cache (server-only). Sufficient for the
 * single-container deploy; swap for Redis if HoskSaid ever scales horizontally.
 *
 * Tiers (match the handoff + /agents docs):
 *   - anonymous: 60 req/min/IP, burst 120
 *   - API key:   600 req/min
 */
import type { NextRequest } from "next/server";
import { isIP } from "node:net";

const ANON_PER_MIN = parseInt(process.env.RATE_LIMIT_ANON || "60", 10);
const KEYED_PER_MIN = parseInt(process.env.RATE_LIMIT_KEYED || "600", 10);

interface Bucket { tokens: number; last: number; capacity: number; refillPerSec: number }
const buckets = new Map<string, Bucket>();
const BUCKET_MAX = 10_000;
const BUCKET_IDLE_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
let lastSweep = 0;

function take(key: string, perMin: number, burst: number, now: number, cost = 1): { ok: boolean; retryAfter: number } {
  if (now - lastSweep >= SWEEP_INTERVAL_MS) {
    for (const [id, bucket] of buckets) {
      // Only discard idle buckets once their allowance would be fully refilled.
      const refillMs = bucket.capacity / bucket.refillPerSec * 1000;
      if (now - bucket.last >= Math.max(BUCKET_IDLE_MS, refillMs)) buckets.delete(id);
    }
    lastSweep = now;
  }
  let b = buckets.get(key);
  if (!b) {
    // Do not evict active identities: doing so would reset their allowances.
    if (buckets.size >= BUCKET_MAX) return { ok: false, retryAfter: 60 };
    b = { tokens: burst, last: now, capacity: burst, refillPerSec: perMin / 60 };
    buckets.set(key, b);
  }
  // Refill.
  const elapsed = Math.max(0, now - b.last) / 1000;
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerSec);
  b.last = now;
  if (cost > b.capacity) return { ok: false, retryAfter: 60 };
  if (b.tokens >= cost) {
    b.tokens -= cost;
    return { ok: true, retryAfter: 0 };
  }
  return { ok: false, retryAfter: Math.ceil((cost - b.tokens) / b.refillPerSec) };
}

/** Anything with request headers: a NextRequest, or next/headers' headers() in a page. */
export type HeaderSource = { headers: { get(name: string): string | null } };

function clientIp(req: HeaderSource): string {
  // Opt in only behind a Cloudflare-only ingress. Never trust caller-supplied
  // X-Forwarded-For. Direct/unidentified clients share a conservative bucket.
  if (process.env.TRUST_CLOUDFLARE_IP === "true") {
    const ip = req.headers.get("cf-connecting-ip")?.trim();
    if (ip && isIP(ip)) return ip;
  }
  return "anon";
}

/** Valid keys come from HOSK_API_KEYS (comma-separated). Empty ⇒ no valid keys. */
function validKeys(): Set<string> {
  return new Set((process.env.HOSK_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean));
}

export interface RateResult {
  ok: boolean;
  status?: number; // 429 (throttled) or 401 (bad key)
  retryAfter?: number;
  body?: unknown;
}

/**
 * The identity a request is limited and charged as: `key:<key>` for an
 * allow-listed bearer key, otherwise `ip:<ip>` (or the shared `ip:anon`).
 * Callers must have passed checkRate, which refuses unknown bearer keys.
 */
export function clientIdentity(req: HeaderSource): string {
  const auth = req.headers.get("authorization");
  if (auth && /^bearer(?:\s|$)/i.test(auth)) {
    const key = auth.slice(6).trim();
    if (key && validKeys().has(key)) return `key:${key}`;
  }
  return `ip:${clientIp(req)}`;
}

/**
 * Check a request against its tier. Returns ok, or the error to send.
 * `cost` charges several units at once (an MCP batch is charged one unit per
 * message); a request costing more than the tier's burst is always refused.
 */
export function checkRate(req: HeaderSource, cost = 1): RateResult {
  const now = Date.now();
  const auth = req.headers.get("authorization");

  if (auth && /^bearer(?:\s|$)/i.test(auth)) {
    const key = auth.slice(6).trim();
    if (!key || !validKeys().has(key)) {
      return { ok: false, status: 401, body: { error: "invalid_key" } };
    }
  }

  const id = clientIdentity(req);
  const perMin = id.startsWith("key:") ? KEYED_PER_MIN : ANON_PER_MIN;
  const burst = id.startsWith("key:") ? KEYED_PER_MIN : ANON_PER_MIN * 2;
  const r = take(id, perMin, burst, now, cost);
  return r.ok ? { ok: true } : { ok: false, status: 429, retryAfter: r.retryAfter, body: { error: "rate_limited" } };
}

/** Build the throttle/auth Response, or null when the request may proceed. */
export function rateLimited(req: NextRequest, cost = 1): Response | null {
  const r = checkRate(req, cost);
  if (r.ok) return null;
  const headers: Record<string, string> = {};
  if (r.retryAfter) headers["Retry-After"] = String(r.retryAfter);
  return Response.json(r.body, { status: r.status ?? 429, headers });
}

// ---------------------------------------------------------------------------
// Tiny TTL cache (hot Ask answers to identical public-archive questions only).
// Never stores key material, request headers or anything user-identifying.
// ---------------------------------------------------------------------------
const cache = new Map<string, { value: unknown; expires: number }>();
const CACHE_MAX = 500;

export function cacheGet<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { cache.delete(key); return null; }
  return hit.value as T;
}

export function cacheSet(key: string, value: unknown, ttlSeconds = 300): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

/** Test hook: drop all cached answers. */
export function cacheClearForTests(): void {
  cache.clear();
}
