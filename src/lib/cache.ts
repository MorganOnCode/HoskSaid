/**
 * In-process TTL memo for PUBLIC, non-personal data only (archive stats, topic
 * counts, catalogue lists). Concurrent callers share one in-flight query, and
 * failures are never cached. Never use this for questions, answers, keys or
 * operator data.
 */
type Store = Map<string, { value?: unknown; promise?: Promise<unknown>; expires: number }>;
const stores: Store[] = [];

export function publicDataTtlMs(def: number): number {
  const raw = process.env.PUBLIC_DATA_CACHE_SECONDS;
  if (raw && /^\d+$/.test(raw)) return parseInt(raw, 10) * 1000;
  return def;
}

/**
 * A separately bounded memo, so keys derived from visitor input (free-text
 * queries) can never evict the fixed keys held by another store.
 */
export function createPublicCache(maxEntries: number) {
  const store: Store = new Map();
  stores.push(store);
  const cached = async <T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> => {
    if (ttlMs <= 0) return fn();
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expires > now) {
      if ("value" in hit) return hit.value as T;
      if (hit.promise) return hit.promise as Promise<T>;
    }
    const promise = fn().then(
      (value) => {
        if (store.size >= maxEntries) store.delete(store.keys().next().value!);
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
  };
  const forget = (key: string): void => {
    store.delete(key);
  };
  return { cached, forget };
}

const shared = createPublicCache(300);
export const cachedPublic = shared.cached;
export const forgetPublic = shared.forget;

export function clearPublicCache(): void {
  for (const s of stores) s.clear();
}
