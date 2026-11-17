/** The request proxy as deployed: canonical redirects and per-request CSP (audit F9). */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["CANONICAL_REDIRECTS", "CSP_REPORT_ONLY", "PUBLIC_BASE_URL"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function req(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers: { host: new URL(url).host, ...headers } });
}

test("pages get an enforced nonce CSP, a fresh nonce per request", () => {
  const a = proxy(req("http://127.0.0.1:3000/library"));
  const b = proxy(req("http://127.0.0.1:3000/library"));
  const ca = a.headers.get("content-security-policy")!;
  const cb = b.headers.get("content-security-policy")!;
  assert.match(ca, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
  assert.match(ca, /frame-ancestors 'none'/);
  assert.notEqual(ca, cb, "nonce differs per request");
  assert.doesNotMatch(ca, /localhost|127\.0\.0\.1/, "no loopback/private destinations in any directive");
});

test("CSP_REPORT_ONLY switches to the report-only header", () => {
  process.env.CSP_REPORT_ONLY = "true";
  const r = proxy(req("http://127.0.0.1:3000/"));
  assert.equal(r.headers.get("content-security-policy"), null);
  assert.ok(r.headers.get("content-security-policy-report-only"));
});

test("API and MCP responses are not given a page CSP", () => {
  assert.equal(proxy(req("http://127.0.0.1:3000/api/ask")).headers.get("content-security-policy"), null);
  assert.equal(proxy(req("http://127.0.0.1:3000/mcp")).headers.get("content-security-policy"), null);
});

test("with CANONICAL_REDIRECTS, http and www redirect (308) to the https apex; loopback passes", () => {
  process.env.CANONICAL_REDIRECTS = "true";
  process.env.PUBLIC_BASE_URL = "https://thehosksaid.com";
  const http = proxy(req("http://thehosksaid.com/timeline?y=2024", { "x-forwarded-proto": "http" }));
  assert.equal(http.status, 308);
  assert.equal(http.headers.get("location"), "https://thehosksaid.com/timeline?y=2024");
  const www = proxy(req("http://www.thehosksaid.com/api/ask", { "x-forwarded-proto": "https" }));
  assert.equal(www.status, 308, "redirect is method-preserving even for API paths");
  assert.equal(www.headers.get("location"), "https://thehosksaid.com/api/ask");
  const health = proxy(req("http://127.0.0.1:3000/"));
  assert.notEqual(health.status, 308);
});

test("redirects are off by default", () => {
  const r = proxy(req("http://thehosksaid.com/", { "x-forwarded-proto": "http" }));
  assert.notEqual(r.status, 308);
});
