import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { NextRequest } from "next/server";
import { checkRate, rateLimited } from "../src/lib/ratelimit";

let now = Date.now();
const originalKeys = process.env.HOSK_API_KEYS;
const originalTrust = process.env.TRUST_CLOUDFLARE_IP;

beforeEach(() => {
  // Advance beyond idle expiry between tests without exposing limiter internals.
  now += 10 * 60_000;
  mock.method(Date, "now", () => now);
  delete process.env.HOSK_API_KEYS;
  process.env.TRUST_CLOUDFLARE_IP = "true";
});

afterEach(() => {
  mock.restoreAll();
  if (originalKeys === undefined) delete process.env.HOSK_API_KEYS;
  else process.env.HOSK_API_KEYS = originalKeys;
  if (originalTrust === undefined) delete process.env.TRUST_CLOUDFLARE_IP;
  else process.env.TRUST_CLOUDFLARE_IP = originalTrust;
});

function request(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/ask", { headers });
}

test("absent, empty and whitespace-only allowlists reject rotating arbitrary keys", () => {
  for (const config of [undefined, "", " ,  , "]) {
    if (config === undefined) delete process.env.HOSK_API_KEYS;
    else process.env.HOSK_API_KEYS = config;
    for (let i = 0; i < 700; i++) {
      assert.equal(checkRate(request({ authorization: `Bearer invented-${i}` })).status, 401);
    }
  }
});

test("issued keys retain their allowance; unknown, empty and revoked keys fail closed", () => {
  process.env.HOSK_API_KEYS = " issued-one, issued-two , ";
  for (const auth of ["Bearer unknown", "Bearer", "Bearer   "]) {
    assert.equal(checkRate(request({ authorization: auth })).status, 401);
  }
  const keyed = request({ authorization: "bEaReR issued-one" });
  for (let i = 0; i < 600; i++) assert.equal(checkRate(keyed).ok, true);
  assert.equal(checkRate(keyed).status, 429);
  assert.equal(checkRate(request({ authorization: "Bearer issued-two" })).ok, true);
  now += 100;
  assert.equal(checkRate(keyed).ok, true);
  process.env.HOSK_API_KEYS = "issued-two";
  assert.equal(checkRate(keyed).status, 401);
});

test("anonymous burst and refill survive forged forwarded-header rotation", async () => {
  for (let i = 0; i < 120; i++) {
    assert.equal(checkRate(request({
      "cf-connecting-ip": "192.0.2.1", "x-forwarded-for": `forged-${i}`,
    })).ok, true);
  }
  const sameClient = request({ "cf-connecting-ip": "192.0.2.1", "x-forwarded-for": "new-forgery" });
  const response = rateLimited(sameClient);
  assert.equal(response?.status, 429);
  assert.equal(response?.headers.get("Retry-After"), "1");
  assert.deepEqual(await response?.json(), { error: "rate_limited" });
  assert.equal(checkRate(request({ "cf-connecting-ip": "192.0.2.2" })).ok, true);
  now += 1000;
  assert.equal(checkRate(sameClient).ok, true);
  assert.equal(checkRate(sameClient).status, 429);
});

test("untrusted headers cannot manufacture anonymous identities", () => {
  process.env.TRUST_CLOUDFLARE_IP = "false";
  for (let i = 0; i < 120; i++) {
    assert.equal(checkRate(request({
      "cf-connecting-ip": `192.0.2.${i + 1}`, "x-forwarded-for": `192.0.2.${i + 1}`,
    })).ok, true);
  }
  assert.equal(checkRate(request({ "cf-connecting-ip": "198.51.100.1" })).status, 429);
});

test("missing and malformed trusted IP headers share the fallback bucket", () => {
  for (let i = 0; i < 120; i++) assert.equal(checkRate(request()).ok, true);
  for (const ip of ["not-an-ip", "192.0.2.1, 192.0.2.2", ""]) {
    assert.equal(checkRate(request({ "cf-connecting-ip": ip, "x-forwarded-for": "192.0.2.3" })).status, 429);
  }
});

test("invalid-key responses are 401 and do not consume anonymous allowance", async () => {
  const response = rateLimited(request({ authorization: "Bearer fake" }));
  assert.equal(response?.status, 401);
  assert.equal(response?.headers.has("Retry-After"), false);
  assert.deepEqual(await response?.json(), { error: "invalid_key" });
  for (let i = 0; i < 120; i++) assert.equal(checkRate(request()).ok, true);
  assert.equal(checkRate(request()).status, 429);
});

test("identity cap rejects new arrivals without resetting active limits, and idle slots recover", () => {
  const active = request({ "cf-connecting-ip": "192.0.2.1" });
  for (let i = 0; i < 120; i++) assert.equal(checkRate(active).ok, true);
  for (let i = 1; i < 10_000; i++) {
    assert.equal(checkRate(request({ "cf-connecting-ip": `2001:db8::${i.toString(16)}` })).ok, true);
  }
  const newcomer = request({ "cf-connecting-ip": "198.51.100.1" });
  assert.equal(checkRate(newcomer).status, 429);
  assert.equal(checkRate(active).status, 429);
  // Existing identities can still use their own remaining allowance.
  assert.equal(checkRate(request({ "cf-connecting-ip": "2001:db8::1" })).ok, true);
  now += 5 * 60_000;
  assert.equal(checkRate(newcomer).ok, true);
});
