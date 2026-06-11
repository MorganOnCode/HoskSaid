/**
 * In-memory token-bucket rate limiting + tiny TTL cache. Sufficient for the
 * single-container deploy; swap for Redis if HoskSaid ever scales horizontally.
 *
 * Tiers (match the handoff + /agents docs):
 *   - anonymous: 60 req/min/IP, burst 120
 *   - API key:   600 req/min
 */
import type { NextRequest } from "next/server";

const ANON_PER_MIN = parseInt(process.env.RATE_LIMIT_ANON || "60", 10);
const KEYED_PER_MIN = parseInt(process.env.RATE_LIMIT_KEYED || "600", 10);

interface Bucket { tokens: number; last: number; capacity: number; refillPerSec: number }
const buckets = new Map<string, Bucket>();

function take(key: string, perMin: number, burst: number, now: number): { ok: boolean; retryAfter: number } {
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: burst, last: now, capacity: burst, refillPerSec: perMin / 60 };
    buckets.set(key, b);
  }
  // Refill.
  const elapsed = (now - b.last) / 1000;
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerSec);
  b.last = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, retryAfter: 0 };
  }
  return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / b.refillPerSec) };
}

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  return (xff ? xff.split(",")[0].trim() : null) || req.headers.get("cf-connecting-ip") || "anon";
}

/** Valid keys come from HOSK_API_KEYS (comma-separated). Empty ⇒ keys ignored. */
function validKeys(): Set<string> {
  return new Set((process.env.HOSK_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean));
}

export interface RateResult {
  ok: boolean;
  status?: number; // 429 (throttled) or 401 (bad key)
  retryAfter?: number;
  body?: unknown;
}

/** Check a request against its tier. Returns ok, or the error to send. */
export function checkRate(req: NextRequest): RateResult {
  const now = Date.now();
  const auth = req.headers.get("authorization");
  const keys = validKeys();

  if (auth?.toLowerCase().startsWith("bearer ")) {
    const key = auth.slice(7).trim();
    if (keys.size > 0 && !keys.has(key)) {
      return { ok: false, status: 401, body: { error: "invalid_key" } };
    }
    const r = take(`key:${key}`, KEYED_PER_MIN, KEYED_PER_MIN, now);
    return r.ok ? { ok: true } : { ok: false, status: 429, retryAfter: r.retryAfter, body: { error: "rate_limited" } };
  }

  const r = take(`ip:${clientIp(req)}`, ANON_PER_MIN, ANON_PER_MIN * 2, now);
  return r.ok ? { ok: true } : { ok: false, status: 429, retryAfter: r.retryAfter, body: { error: "rate_limited" } };
}

/** Build the throttle/auth Response, or null when the request may proceed. */
export function rateLimited(req: NextRequest): Response | null {
  const r = checkRate(req);
  if (r.ok) return null;
  const headers: Record<string, string> = {};
  if (r.retryAfter) headers["Retry-After"] = String(r.retryAfter);
  return Response.json(r.body, { status: r.status ?? 429, headers });
}

// ---------------------------------------------------------------------------
// Tiny TTL cache (hot Ask queries).
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
