/**
 * Retrieval-only access for client-owned models: keyword search (no model, no
 * embedding), MCP search_segments (one embedding, never an answer) and the
 * backward-compatible server-answer tool search_archive. A fake site OpenAI
 * counts every call; no real provider is contacted.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, mock, test } from "node:test";
import { NextRequest } from "next/server";
import { SKIP_DB, createTestDb, near, randomUnit, seedVideo, type TestDb } from "./helpers/db";
import { startFakeOpenAI, type FakeOpenAI } from "./helpers/fake-openai";

const q = randomUnit(7373);
let now = Date.now();

describe("retrieval-only access", { skip: SKIP_DB }, () => {
  let db: TestDb;
  let fake: FakeOpenAI;
  let mcpRoute: typeof import("../src/app/mcp/route");
  let keywordRoute: typeof import("../src/app/api/search/keyword/route");
  let retrieval: typeof import("../src/lib/retrieval");
  let ratelimit: typeof import("../src/lib/ratelimit");

  before(async () => {
    db = await createTestDb();
    await seedVideo(db.sql, {
      youtube_id: "KWvidEmbed01",
      title: "Fixture keynote on Hydra",
      published_at: "2026-05-01T12:00:00Z",
      cleaned_text: "In this keynote we talk about Hydra heads and the glacier distribution in detail.",
      chunks: Array.from({ length: 4 }, (_x, c) => ({ content: `Keynote segment ${c} on hydra heads.`, start: c * 90, embedding: near(q, 0.02, 700 + c) })),
    });
    // No chunks at all: invisible to semantic search, reachable by keyword.
    await seedVideo(db.sql, {
      youtube_id: "KWvidNoChunk",
      title: "Fixture fireside from 2019",
      published_at: "2019-02-01T12:00:00Z",
      cleaned_text: "An old fireside where the glacier idea first came up among friends.",
    });
    fake = await startFakeOpenAI({ embeddingFor: () => q });
    mcpRoute = await import("../src/app/mcp/route");
    keywordRoute = await import("../src/app/api/search/keyword/route");
    retrieval = await import("../src/lib/retrieval");
    ratelimit = await import("../src/lib/ratelimit");
  });

  after(async () => {
    mock.restoreAll();
    await fake?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    now += 10 * 60_000;
    mock.method(Date, "now", () => now);
    retrieval.clearEmbeddingCache();
    ratelimit.cacheClearForTests();
    fake.calls.embeddings = 0;
    fake.calls.chat = 0;
    delete process.env.SITE_DAILY_EMBEDDING_CAP;
    delete process.env.SITE_DAILY_ANSWER_CAP;
    await db.sql`DELETE FROM site_usage_daily`;
    await db.sql`DELETE FROM client_usage_daily`;
    await db.sql`DELETE FROM answers`;
  });

  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await mcpRoute.POST(
      new NextRequest("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      })
    );
    const body = await res.json();
    return { isError: body.result.isError as boolean, data: body.result.isError ? body.result.content[0].text : JSON.parse(body.result.content[0].text) };
  };
  const keyword = (qs: string) => keywordRoute.GET(new NextRequest(`http://localhost/api/search/keyword?${qs}`));

  test("keyword search finds videos without semantic segments, with excerpts and links, and spends nothing", async () => {
    process.env.SITE_DAILY_EMBEDDING_CAP = "0";
    process.env.SITE_DAILY_ANSWER_CAP = "0";
    const res = await keyword("q=glacier");
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.mode, "keyword");
    assert.equal(out.model_calls, 0);
    const ids = out.items.map((i: { video_id: string }) => i.video_id).sort();
    assert.deepEqual(ids, ["KWvidEmbed01", "KWvidNoChunk"]);
    const old = out.items.find((i: { video_id: string }) => i.video_id === "KWvidNoChunk");
    assert.equal(old.semantic_search_available, false);
    assert.match(old.snippet, /glacier/);
    assert.match(old.url, /\/video\/KWvidNoChunk\?q=glacier$/);
    assert.equal(fake.calls.embeddings + fake.calls.chat, 0, "works with every paid allowance at zero");
  });

  test("keyword search honours video and date filters", async () => {
    const byDate = await (await keyword("q=glacier&date_to=2020-01-01")).json();
    assert.deepEqual(byDate.items.map((i: { video_id: string }) => i.video_id), ["KWvidNoChunk"]);
    const byVideo = await (await keyword("q=glacier&video_id=KWvidEmbed01")).json();
    assert.deepEqual(byVideo.items.map((i: { video_id: string }) => i.video_id), ["KWvidEmbed01"]);
    assert.equal((await keyword(`q=${"z".repeat(201)}`)).status, 400);
    assert.equal((await keyword("q=glacier&video_id=bad id")).status, 400);
    assert.equal((await keyword("q=glacier&date_from=2026-13-01")).status, 400);
  });

  test("MCP search_keyword never generates an answer or spends an embedding", async () => {
    const r = await tool("search_keyword", { query: "glacier", date_from: "2019-01-01", date_to: "2019-12-31" });
    assert.equal(r.isError, false);
    assert.deepEqual(r.data.items.map((i: { video_id: string }) => i.video_id), ["KWvidNoChunk"]);
    assert.equal(r.data.answer, undefined);
    assert.equal(fake.calls.embeddings + fake.calls.chat, 0);
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM answers`)[0].n, 0);
  });

  test("MCP search_segments returns bounded passages with citations for a client-owned model, never an answer", async () => {
    const r = await tool("search_segments", { query: "hydra heads", limit: 3, video_ids: ["KWvidEmbed01"] });
    assert.equal(r.isError, false);
    assert.equal(r.data.length, 3);
    for (const s of r.data) {
      assert.equal(s.video_id, "KWvidEmbed01");
      assert.equal(s.published_at, "2026-05-01");
      assert.match(s.citation, /^"Fixture keynote on Hydra" \(2026-05-01\) at \d+:\d{2}, https?:\/\/.+\/video\/KWvidEmbed01\?t=\d+$/);
      assert.ok(s.text.length > 0);
    }
    assert.equal(fake.calls.embeddings, 1, "exactly one site-funded embedding");
    assert.equal(fake.calls.chat, 0, "no answer model call");
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM answers`)[0].n, 0, "nothing stored");
  });

  test("MCP retrieval respects the embedding cap and points to keyword search", async () => {
    process.env.SITE_DAILY_EMBEDDING_CAP = "0";
    const r = await tool("search_segments", { query: "hydra heads" });
    assert.equal(r.isError, true);
    const body = JSON.parse(r.data);
    assert.equal(body.error, "site_budget_exhausted");
    assert.equal(body.budget, "embedding");
    assert.match(body.message, /keyword search still works/i);
    assert.equal(fake.calls.chat, 0);
  });

  test("search_archive stays a site-funded answer tool, backward compatible", async () => {
    const r = await tool("search_archive", { query: "hydra heads" });
    assert.equal(r.isError, false);
    assert.equal(typeof r.data.answer, "string");
    assert.ok(Array.isArray(r.data.sources));
    assert.equal(fake.calls.chat, 1, "this tool is the one that spends a site-funded answer");
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM answers`)[0].n, 1, "and stores the question, as documented");
  });

  test("the MCP manifest says who pays and never asks for a provider key", async () => {
    const res = await mcpRoute.POST(
      new NextRequest("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
    );
    const tools = (await res.json()).result.tools as { name: string; description: string; inputSchema: { properties: Record<string, unknown> } }[];
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.match(byName.search_archive.description, /THIS SITE'S model/);
    assert.match(byName.search_segments.description, /Retrieval only, no answer generated/);
    assert.match(byName.search_keyword.description, /no model call and no embedding/);
    for (const t of tools) {
      assert.ok(!Object.keys(t.inputSchema.properties ?? {}).some((k) => /key|token|secret|provider/i.test(k)), `${t.name} takes no credential argument`);
    }
  });
});
