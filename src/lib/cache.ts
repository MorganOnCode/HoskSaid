/**
 * In-process TTL memo for PUBLIC, non-personal data only (archive stats, topic
 * counts, catalogue lists). Concurrent callers share one in-flight query, and
 * failures are never cached. Never use this for answers, keys, subscriber or
 * operator data.
 */
const MAX_ENTRIES = 300;
const store = new Map<string, { value?: unknown; promise?: Promise<unknown>; expires: number }>();

export function publicDataTtlMs(def: number): number {
  const raw = process.env.PUBLIC_DATA_CACHE_SECONDS;
  if (raw && /^\d+$/.test(raw)) return parseInt(raw, 10) * 1000;
  return def;
}

export async function cachedPublic<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  if (ttlMs <= 0) return fn();
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) {
    if ("value" in hit) return hit.value as T;
    if (hit.promise) return hit.promise as Promise<T>;
  }
  const promise = fn().then(
    (value) => {
      if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value!);
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    },
    (err) => {
      store.delete(key);
      throw err;
    }
  );
  store.set(key, { promise, expires: now + ttlMs });
  return promise;
}

export function clearPublicCache(): void {
  store.clear();
}
