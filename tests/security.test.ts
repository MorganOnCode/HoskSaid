/** Pure security/validation helpers: canonical redirects, CSP, input bounds, body reader. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCsp, canonicalRedirect, STATIC_SECURITY_HEADERS } from "../src/lib/security";
import { clampInt, isIsoDate, validateFilters, validateQuery } from "../src/lib/limits";
import { readJsonBody } from "../src/lib/body";
import { decodeEntities } from "../src/lib/text";
import { parseModelOutput, renumberCitations } from "../src/lib/ask-core";

const env = { enabled: true, baseUrl: "https://thehosksaid.com", aliasHosts: [] as string[] };

test("canonical redirect: http -> https and www -> apex only behind the trusted proxy", () => {
  const r = (host: string | null, proto: string | null, p = "/library?q=x") =>
    canonicalRedirect({ host, forwardedProto: proto, pathAndQuery: p }, env);
  assert.equal(r("thehosksaid.com", "http"), "https://thehosksaid.com/library?q=x");
  assert.equal(r("www.thehosksaid.com", "https"), "https://thehosksaid.com/library?q=x");
  assert.equal(r("thehosksaid.com", "https"), null);
  assert.equal(r("127.0.0.1:3000", null, "/"), null, "loopback health checks pass through");
  assert.equal(r("evil.example", "http"), null, "unknown hosts are never redirected anywhere");
  assert.equal(canonicalRedirect({ host: "thehosksaid.com", forwardedProto: "http", pathAndQuery: "/" }, { ...env, enabled: false }), null);
});

test("CSP: nonce scripts, no inline/eval in production, same-origin connect only", () => {
  const csp = buildCsp("abc123");
  assert.match(csp, /script-src 'self' 'nonce-abc123'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp.match(/script-src[^;]*/)![0], /unsafe-inline/);
  assert.equal(csp.match(/connect-src[^;]*/)![0], "connect-src 'self'", "no localhost/private-network destinations");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(buildCsp("n", { dev: true }), /unsafe-eval/);
  const names = STATIC_SECURITY_HEADERS.map((h) => h.key);
  for (const h of ["Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Permissions-Policy"]) {
    assert.ok(names.includes(h), h);
  }
});

test("query and filter validation", () => {
  assert.deepEqual(validateQuery("  hi "), { ok: true, value: "hi" });
  assert.equal((validateQuery(42) as { error: string }).error, "invalid_query");
  assert.equal((validateQuery("x".repeat(1001)) as { error: string }).error, "query_too_long");
  const ok = validateFilters({ date_from: "2026-01-01", date_to: "2026-01-31", video_ids: ["abcdefghijk", "abcdefghijk"], topics: ["Smart Contracts"] });
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.scope.youtubeIds, ["abcdefghijk"]);
  assert.deepEqual(ok.value.scope.topicSlugs, ["smart-contracts"]);
  assert.equal(ok.value.scope.to?.toISOString(), "2026-02-01T00:00:00.000Z", "date_to includes that whole day");
  assert.ok(!validateFilters({ date_from: "2026-02-30" }).ok);
  assert.ok(!validateFilters({ date_from: "2026-02-02", date_to: "2026-02-01" }).ok);
  assert.ok(!validateFilters({ video_ids: Array.from({ length: 21 }, () => "abcdefghijk") }).ok);
  assert.ok(!validateFilters({ video_ids: ["../etc/passwd"] }).ok);
  assert.ok(isIsoDate("2024-02-29") && !isIsoDate("2023-02-29"));
  assert.equal(clampInt("-5", 10, 1, 50), 1);
  assert.equal(clampInt("abc", 10, 1, 50), 10);
  assert.equal(clampInt("9999", 10, 1, 50), 50);
});

test("bounded JSON body reader", async () => {
  const mk = (body: string, type = "application/json") => new Request("http://x/", { method: "POST", headers: { "content-type": type }, body });
  assert.deepEqual(await readJsonBody(mk('{"a":1}'), 100), { ok: true, value: { a: 1 } });
  assert.equal((await readJsonBody(mk("x".repeat(101)), 100)).ok, false);
  assert.equal(((await readJsonBody(mk("{bad"), 100)) as { error: string }).error, "invalid_body");
  assert.equal(((await readJsonBody(mk("{}", "text/plain"), 100)) as { status: number }).status, 415);
});

test("entity decoding repairs double-escaped transcript text, as plain text", () => {
  assert.equal(decodeEntities("how&amp;#39;s it &amp;quot;going&amp;quot;"), `how's it "going"`);
  assert.equal(decodeEntities("&lt;script&gt;"), "<script>", "returns text; React escapes it on render");
  assert.equal(decodeEntities("AT&T &unknown;"), "AT&T &unknown;");
});

test("citation parsing tolerates variants and never invents sources", () => {
  assert.deepEqual(parseModelOutput('```json\n{"lede":"L","answer":"A [2]"}\n```'), { lede: "L", answer: "A [2]" });
  assert.deepEqual(parseModelOutput("plain words"), { lede: "", answer: "plain words" });
  const r = renumberCitations("First [[3]], then [Source 1], bogus [9].", 3);
  assert.deepEqual(r.order, [3, 1]);
  assert.equal(r.text, "First [1], then [2], bogus .");
});
