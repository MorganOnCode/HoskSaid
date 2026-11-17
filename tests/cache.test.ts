/** Public browse-data memo (audit F7): dedupe, bounded TTL, failure handling, key isolation. */
import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { cachedPublic, clearPublicCache, createPublicCache, publicDataTtlMs } from "../src/lib/cache";

beforeEach(() => {
  mock.restoreAll();
  clearPublicCache();
  delete process.env.PUBLIC_DATA_CACHE_SECONDS;
});

test("concurrent callers for one key share a single in-flight query", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return { videos: 752 };
  };
  const results = await Promise.all(Array.from({ length: 10 }, () => cachedPublic("stats", 60_000, fn)));
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r === results[0]));
  await cachedPublic("stats", 60_000, fn);
  assert.equal(calls, 1, "served from memo within TTL");
});

test("entries expire after the TTL and are recomputed", async () => {
  let t = 1_000_000;
  mock.method(Date, "now", () => t);
  let calls = 0;
  const fn = async () => ++calls;
  assert.equal(await cachedPublic("k", 1000, fn), 1);
  t += 999;
  assert.equal(await cachedPublic("k", 1000, fn), 1);
  t += 2;
  assert.equal(await cachedPublic("k", 1000, fn), 2);
});

test("failures are never cached", async () => {
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error("db down");
  };
  await assert.rejects(cachedPublic("f", 60_000, failing));
  await assert.rejects(cachedPublic("f", 60_000, failing));
  assert.equal(calls, 2);
  assert.equal(await cachedPublic("f", 60_000, async () => "ok"), "ok");
});

test("keys are isolated and TTL 0 bypasses the memo", async () => {
  assert.equal(await cachedPublic("topic:a", 60_000, async () => "A"), "A");
  assert.equal(await cachedPublic("topic:b", 60_000, async () => "B"), "B");
  let calls = 0;
  await cachedPublic("z", 0, async () => ++calls);
  await cachedPublic("z", 0, async () => ++calls);
  assert.equal(calls, 2);
});

test("PUBLIC_DATA_CACHE_SECONDS overrides the default, invalid values fall back", () => {
  assert.equal(publicDataTtlMs(120_000), 120_000);
  process.env.PUBLIC_DATA_CACHE_SECONDS = "0";
  assert.equal(publicDataTtlMs(120_000), 0);
  process.env.PUBLIC_DATA_CACHE_SECONDS = "abc";
  assert.equal(publicDataTtlMs(120_000), 120_000);
});

test("a separate bounded store never evicts the shared store's keys", async () => {
  let calls = 0;
  await cachedPublic("an:subjects", 60_000, async () => ++calls);
  const visitor = createPublicCache(5);
  for (let i = 0; i < 1000; i++) await visitor.cached(`an:cov:${i}`, 60_000, async () => i);
  assert.equal(await cachedPublic("an:subjects", 60_000, async () => ++calls), 1);
  assert.equal(calls, 1);
  let recomputed = 0;
  await visitor.cached("an:cov:0", 60_000, async () => ++recomputed);
  assert.equal(recomputed, 1, "the visitor store stays bounded");
  clearPublicCache();
  assert.equal(await cachedPublic("an:subjects", 60_000, async () => ++calls), 2, "clearPublicCache clears every store");
});
