/**
 * Paid-call accounting across /api/ask, /api/search and MCP (audit F2), using a
 * fake OpenAI server that counts every embedding and completion request.
 * No real provider is ever contacted.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, mock, test } from "node:test";
import { NextRequest } from "next/server";
import { SKIP_DB, createTestDb, near, randomUnit, seedVideo, type TestDb } from "./helpers/db";
import { startFakeOpenAI, type FakeOpenAI } from "./helpers/fake-openai";

const q = randomUnit(4242);
let now = Date.now();

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: text,
  });
}

describe("paid-call bounds", { skip: SKIP_DB }, () => {
  let db: TestDb;
  let fake: FakeOpenAI;
  // Imported after env/DB setup so module-level config reads the test values.
  let askRoute: typeof import("../src/app/api/ask/route");
  let mcpRoute: typeof import("../src/app/mcp/route");
  let searchRoute: typeof import("../src/app/api/search/route");
  let usage: typeof import("../src/lib/usage");
  let retrieval: typeof import("../src/lib/retrieval");
  let ratelimit: typeof import("../src/lib/ratelimit");

  before(async () => {
    db = await createTestDb();
    await seedVideo(db.sql, {
      youtube_id: "PAIDvid0001",
      chunks: Array.from({ length: 12 }, (_x, c) => ({ content: `Segment ${c} on the topic.`, start: c * 30, embedding: near(q, 0.02, 100 + c) })),
    });
    fake = await startFakeOpenAI({ embeddingFor: () => q });
    askRoute = await import("../src/app/api/ask/route");
    mcpRoute = await import("../src/app/mcp/route");
    searchRoute = await import("../src/app/api/search/route");
    usage = await import("../src/lib/usage");
    retrieval = await import("../src/lib/retrieval");
    ratelimit = await import("../src/lib/ratelimit");
  });

  after(async () => {
    mock.restoreAll();
    await fake?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    // Fresh limiter buckets (idle expiry), caches, counters and usage rows per test.
    now += 10 * 60_000;
    mock.method(Date, "now", () => now);
    retrieval.clearEmbeddingCache();
    ratelimit.cacheClearForTests();
    fake.calls.embeddings = 0;
    fake.calls.chat = 0;
    fake.calls.maxConcurrentChat = 0;
    fake.chatDelayMs = 0;
    delete process.env.SITE_DAILY_ANSWER_CAP;
    delete process.env.SITE_DAILY_EMBEDDING_CAP;
    await db.sql`DELETE FROM site_usage_daily`;
    await db.sql`DELETE FROM answers`;
  });

  const mcpCall = (id: number, query: string, tool = "search_archive") => ({
    jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: { query } },
  });

  test("MCP batch above the cap is rejected before any paid call", async () => {
    const batch = Array.from({ length: 9 }, (_x, i) => mcpCall(i, `question ${i}`));
    const res = await mcpRoute.POST(post("/mcp", batch));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, -32600);
    assert.equal(fake.calls.embeddings + fake.calls.chat, 0);
  });

  test("an empty batch is an invalid request", async () => {
    const res = await mcpRoute.POST(post("/mcp", []));
    assert.equal(res.status, 400);
    assert.equal(fake.calls.chat, 0);
  });

  test("MCP batch of 8 distinct search_archive calls: bounded, sequential, each charged", async () => {
    fake.chatDelayMs = 20;
    const batch = Array.from({ length: 8 }, (_x, i) => mcpCall(i, `distinct question ${i}`));
    const res = await mcpRoute.POST(post("/mcp", batch));
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.length, 8);
    assert.ok(out.every((r: { result: { isError: boolean } }) => r.result.isError === false));
    assert.equal(fake.calls.chat, 8, "one completion per tool call, no amplification");
    assert.equal(fake.calls.maxConcurrentChat, 1, "batch messages are handled one at a time");
    const [row] = await db.sql<{ calls: number }[]>`SELECT calls FROM site_usage_daily WHERE kind = 'answer'`;
    assert.equal(row.calls, 8);
  });

  test("each batch message is charged to the rate limiter", async () => {
    // Anonymous burst is 120 tokens: 15 full batches of 8 fit, the 16th does not.
    const batch = Array.from({ length: 8 }, (_x, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    for (let i = 0; i < 15; i++) {
      const res = await mcpRoute.POST(post("/mcp", batch));
      assert.equal(res.status, 200, `batch ${i}`);
    }
    const res = await mcpRoute.POST(post("/mcp", batch));
    assert.equal(res.status, 429);
  });

  test("MCP request body above 64 KiB is refused unread", async () => {
    const big = JSON.stringify(mcpCall(1, "x".repeat(70 * 1024)));
    const res = await mcpRoute.POST(post("/mcp", big));
    assert.equal(res.status, 413);
    assert.equal(fake.calls.embeddings + fake.calls.chat, 0);
  });

  test("query length cap is the same on Ask, search and MCP", async () => {
    const long = "y".repeat(1001);
    const a = await askRoute.POST(post("/api/ask", { query: long }));
    assert.equal(a.status, 400);
    assert.equal((await a.json()).error, "query_too_long");
    const s = await searchRoute.GET(new NextRequest(`http://localhost/api/search?q=${long}`));
    assert.equal(s.status, 400);
    const m = await mcpRoute.POST(post("/mcp", mcpCall(1, long)));
    const mb = await m.json();
    assert.equal(mb.result.isError, true);
    assert.match(mb.result.content[0].text, /at most 1000/);
    assert.equal(fake.calls.embeddings + fake.calls.chat, 0);
  });

  test("malformed filters are a 400, not a 500", async () => {
    for (const filters of [{ topics: "governance" }, { video_ids: "abc" }, { date_from: "yesterday" }, []]) {
      const res = await askRoute.POST(post("/api/ask", { query: "fine question", filters }));
      assert.equal(res.status, 400, JSON.stringify(filters));
    }
    assert.equal(fake.calls.embeddings, 0);
    // Unknown filter keys stay ignored for backward compatibility.
    const lenient = await askRoute.POST(post("/api/ask", { query: "fine question", filters: { legacy_flag: true } }));
    assert.equal(lenient.status, 200);
  });

  test("daily answer cap holds and degrades to 503 with a reset hint", async () => {
    process.env.SITE_DAILY_ANSWER_CAP = "3";
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await askRoute.POST(post("/api/ask", { query: `capped question ${i}` }));
      statuses.push(res.status);
      if (res.status === 503) {
        const body = await res.json();
        assert.equal(body.error, "site_budget_exhausted");
        assert.ok(Number(res.headers.get("retry-after")) > 0);
      }
    }
    assert.deepEqual(statuses, [200, 200, 200, 503, 503]);
    assert.equal(fake.calls.chat, 3);
  });

  test("cap 0 disables site-funded answers entirely", async () => {
    process.env.SITE_DAILY_ANSWER_CAP = "0";
    const res = await askRoute.POST(post("/api/ask", { query: "disabled" }));
    assert.equal(res.status, 503);
    assert.equal(fake.calls.chat, 0);
  });

  test("budget errors name the exhausted cap; embedding exhaustion offers no route around retrieval", async () => {
    process.env.SITE_DAILY_ANSWER_CAP = "0";
    const a = await askRoute.POST(post("/api/ask", { query: "answer cap question" }));
    assert.equal(a.status, 503);
    const ab = await a.json();
    assert.equal(ab.error, "site_budget_exhausted");
    assert.equal(ab.budget, "answer");
    assert.match(ab.message, /answer allowance/);

    assert.equal(fake.calls.embeddings, 0, "no retrieval is paid for once answers are exhausted");
    assert.equal(fake.calls.chat, 0);

    delete process.env.SITE_DAILY_ANSWER_CAP;
    retrieval.clearEmbeddingCache();
    fake.calls.embeddings = 0;
    process.env.SITE_DAILY_EMBEDDING_CAP = "0";
    const responses = [
      await askRoute.POST(post("/api/ask", { query: "embedding cap question" })),
      await searchRoute.GET(new NextRequest("http://localhost/api/search?q=embedding+cap")),
    ];
    for (const res of responses) {
      assert.equal(res.status, 503);
      const b = await res.json();
      assert.equal(b.budget, "embedding");
      assert.doesNotMatch(b.message, /model|engine|api key|your key/i, "must not suggest another model or key bypasses retrieval");
      assert.match(b.message, /keyword search still works/i);
    }
    const mcp = await mcpRoute.POST(post("/mcp", mcpCall(1, "embedding cap via mcp")));
    const m = await mcp.json();
    assert.equal(m.result.isError, true);
    assert.equal(JSON.parse(m.result.content[0].text).budget, "embedding");
    assert.equal(fake.calls.embeddings, 0);
    assert.equal(fake.calls.chat, 0);
  });

  test("legacy or unknown Ask body fields are ignored, not rejected", async () => {
    const res = await askRoute.POST(post("/api/ask", { query: "compat question", engine: { provider: "x", model: "y" }, extra: 1 }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.citations.length > 0, "cited-answer contract unchanged");
    assert.equal("generated_by" in body, false, "response shape matches the original contract");
  });

  test("absent cap config uses conservative defaults, never unlimited", () => {
    assert.equal(usage.dailyCap("answer"), usage.DEFAULT_DAILY_CAPS.answer);
    assert.equal(usage.dailyCap("embedding"), usage.DEFAULT_DAILY_CAPS.embedding);
    process.env.SITE_DAILY_ANSWER_CAP = "lots";
    assert.equal(usage.dailyCap("answer"), usage.DEFAULT_DAILY_CAPS.answer);
  });

  test("cap reservation is concurrency-safe (50 parallel reservations, cap 10)", async () => {
    process.env.SITE_DAILY_EMBEDDING_CAP = "10";
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => usage.reserveSiteCalls("embedding")));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
    assert.ok(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof usage.BudgetExceededError));
    const [row] = await db.sql<{ calls: number }[]>`SELECT calls FROM site_usage_daily WHERE kind = 'embedding'`;
    assert.equal(row.calls, 10);
  });

  test("concurrency gate bounds simultaneous site-funded completions", async () => {
    const gate = usage.gates().site;
    fake.chatDelayMs = 60;
    const n = 10;
    await Promise.all(Array.from({ length: n }, (_x, i) => askRoute.POST(post("/api/ask", { query: `parallel ${i}` }))));
    assert.ok(fake.calls.maxConcurrentChat <= gate.max, `max concurrent ${fake.calls.maxConcurrentChat} > ${gate.max}`);
    assert.equal(fake.calls.chat, n);
  });

  test("Semaphore rejects when its queue is full (busy -> 503)", async () => {
    const s = new usage.Semaphore(1, 1, 1000);
    const r1 = await s.acquire();
    const waiting = s.acquire();
    await assert.rejects(s.acquire(), usage.BusyError);
    r1();
    (await waiting)();
  });

  test("answer cache serves repeats on Ask and MCP without new paid calls", async () => {
    const r1 = await askRoute.POST(post("/api/ask", { query: "Cached question?" }));
    assert.equal(r1.status, 200);
    const r2 = await askRoute.POST(post("/api/ask", { query: "  cached   QUESTION? " }));
    assert.equal(r2.headers.get("x-cache"), "hit");
    const m = await mcpRoute.POST(post("/mcp", mcpCall(1, "Cached question?")));
    assert.equal((await m.json()).result.isError, false);
    assert.equal(fake.calls.chat, 1);
    assert.equal(fake.calls.embeddings, 1);
  });

  test("query embeddings are cached across search calls", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await searchRoute.GET(new NextRequest("http://localhost/api/search?q=hydra&limit=-5"));
      assert.equal(res.status, 200);
      const { items } = await res.json();
      assert.ok(items.length >= 1, "negative limit is clamped, not a 500");
    }
    assert.equal(fake.calls.embeddings, 1);
  });

  test("site answers are persisted unless PERSIST_ASK_QUESTIONS=false", async () => {
    await askRoute.POST(post("/api/ask", { query: "persist me" }));
    process.env.PERSIST_ASK_QUESTIONS = "false";
    try {
      await askRoute.POST(post("/api/ask", { query: "do not persist me" }));
    } finally {
      delete process.env.PERSIST_ASK_QUESTIONS;
    }
    const rows = await db.sql<{ question: string }[]>`SELECT question FROM answers ORDER BY created_at`;
    assert.deepEqual(rows.map((r) => r.question), ["persist me"]);
  });

  test("Ask body above 16 KiB and wrong content type are refused", async () => {
    const big = await askRoute.POST(post("/api/ask", JSON.stringify({ query: "ok", pad: "z".repeat(17 * 1024) })));
    assert.equal(big.status, 413);
    const wrong = await askRoute.POST(new NextRequest("http://localhost/api/ask", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }));
    assert.equal(wrong.status, 415);
    assert.equal(fake.calls.embeddings, 0);
  });
});
