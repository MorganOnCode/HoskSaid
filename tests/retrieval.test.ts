/**
 * Retrieval correctness regression tests (audit F1 + F8), against an isolated
 * fixture database. Expected results are computed by brute force in JS (exact
 * cosine), never by the database, so "matches exact search" is a real check.
 *
 * These fixtures are synthetic; passing them shows the SQL ranks exactly and
 * scopes before LIMIT. It says nothing about answer quality on the real archive.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SKIP_DB, createTestDb, cosine, near, randomUnit, seedVideo, vec, type TestDb } from "./helpers/db";
import { startFakeOpenAI, type FakeOpenAI } from "./helpers/fake-openai";

const N_VIDEOS = 40;
const CHUNKS_PER_VIDEO = 50;

describe("scoped exact retrieval", { skip: SKIP_DB }, () => {
  let db: TestDb;
  let fake: FakeOpenAI;
  const all: { id: string; youtube: string; emb: number[] }[] = [];
  const q = randomUnit(999_999);

  before(async () => {
    db = await createTestDb();
    // Background corpus: uniformly random vectors.
    for (let v = 0; v < N_VIDEOS; v++) {
      const yt = `bg${String(v).padStart(4, "0")}xx`;
      const chunks = Array.from({ length: CHUNKS_PER_VIDEO }, (_x, c) => ({
        content: `Background segment ${v}.${c}. Charles talks about many things.`,
        start: c * 30,
        embedding: randomUnit(v * 1000 + c + 1),
      }));
      await seedVideo(db.sql, { youtube_id: yt, published_at: `2025-0${(v % 9) + 1}-15T12:00:00Z`, chunks });
    }
    // "Hot" chunks: very close to q, spread over 6 videos -> they own the global top-30.
    for (let v = 0; v < 6; v++) {
      await seedVideo(db.sql, {
        youtube_id: `hot${v}xxxxxx`,
        published_at: "2024-05-01T12:00:00Z",
        chunks: Array.from({ length: 10 }, (_x, c) => ({ content: `Hot segment ${v}.${c} about the scoped question.`, start: c * 60, embedding: near(q, 0.02, 5000 + v * 10 + c) })),
      });
    }
    // The scoped target: relevant (similarity ~0.6) but never in the global top 30.
    await seedVideo(db.sql, {
      youtube_id: "TARGETvid01",
      title: "Target &amp;#39;video&amp;#39;",
      published_at: "2026-10-31T23:30:00Z",
      topics: ["hydra"],
      chunks: Array.from({ length: 8 }, (_x, c) => ({ content: `Target segment ${c}: what Charles said here.`, start: 100 + c * 45, embedding: near(q, 0.045, 7000 + c) })),
    });
    // A non-completed video close to q must never be returned.
    await seedVideo(db.sql, {
      youtube_id: "PENDINGvid1",
      status: "processing",
      chunks: [{ content: "Pending video segment", start: 0, embedding: near(q, 0.01, 8000) }],
    });
    // An undated video must not match date-scoped queries.
    await seedVideo(db.sql, {
      youtube_id: "UNDATEDvid1",
      published_at: null,
      chunks: [{ content: "Undated segment", start: 0, embedding: near(q, 0.045, 8100) }],
    });

    const rows = await db.sql<{ id: string; youtube_id: string; embedding: string }[]>`
      SELECT tc.id, v.youtube_id, tc.embedding::text AS embedding
      FROM transcript_chunks tc JOIN videos v ON v.id = tc.video_id WHERE v.status = 'completed'
    `;
    for (const r of rows) all.push({ id: r.id, youtube: r.youtube_id, emb: JSON.parse(r.embedding) });

    fake = await startFakeOpenAI({ embeddingFor: () => q });
  });

  after(async () => {
    await fake?.close();
    await db?.drop();
  });

  function exactTop(query: number[], k: number, filter: (r: { youtube: string }) => boolean = () => true) {
    return all
      .filter(filter)
      .map((r) => ({ id: r.id, sim: cosine(query, r.emb) }))
      .sort((a, b) => b.sim - a.sim || (a.id < b.id ? -1 : 1))
      .slice(0, k)
      .map((r) => r.id);
  }

  test("F1 reproduction: ANN at probes=1 misses true neighbours (the masking condition)", async () => {
    // Self-queries over the random corpus, as in the audit's method.
    const sample = all.filter((r) => r.youtube.startsWith("bg")).slice(0, 10);
    let recallSum = 0;
    await db.sql.begin(async (tx) => {
      await tx`SET LOCAL ivfflat.probes = 1`;
      await tx`SET LOCAL enable_seqscan = off`;
      for (const s of sample) {
        const ann = await tx<{ id: string }[]>`
          SELECT id FROM transcript_chunks ORDER BY embedding <=> ${vec(s.emb)}::vector LIMIT 30
        `;
        const exact = new Set(exactTop(s.emb, 30));
        recallSum += ann.filter((r) => exact.has(r.id)).length / 30;
      }
    });
    const recall = recallSum / sample.length;
    // On this fixture the old ANN path recalls well under half the exact top 30.
    assert.ok(recall < 0.5, `expected degraded ANN recall at probes=1, got ${recall.toFixed(2)}`);
  });

  test("F1 fix: match_transcript_chunks_scoped returns the exact top-k even under probes=1", async () => {
    const sample = all.filter((r) => r.youtube.startsWith("bg")).slice(0, 10);
    await db.sql.begin(async (tx) => {
      await tx`SET LOCAL ivfflat.probes = 1`;
      for (const s of sample) {
        const got = await tx<{ id: string }[]>`
          SELECT id FROM match_transcript_chunks_scoped(${vec(s.emb)}::vector, -1, 30)
        `;
        assert.deepEqual(got.map((r) => r.id), exactTop(s.emb, 30));
      }
    });
  });

  test("legacy 3-arg match_transcript_chunks is exact and excludes non-completed videos", async () => {
    const got = await db.sql<{ id: string }[]>`SELECT id FROM match_transcript_chunks(${vec(q)}::vector, 0.3, 30)`;
    assert.deepEqual(got.map((r) => r.id), exactTop(q, 30).slice(0, got.length));
    const pending = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM match_transcript_chunks(${vec(q)}::vector, -1, 200) m
      JOIN transcript_chunks tc ON tc.id = m.id JOIN videos v ON v.id = tc.video_id WHERE v.status <> 'completed'
    `;
    assert.equal(pending[0].n, 0);
  });

  test("F8 reproduction: the target video has no chunk in the archive-wide top 30", () => {
    const top30 = new Set(exactTop(q, 30));
    const targetIds = all.filter((r) => r.youtube === "TARGETvid01").map((r) => r.id);
    assert.equal(targetIds.filter((id) => top30.has(id)).length, 0);
  });

  test("F8 fix: video scope is applied before ranking/LIMIT", async () => {
    const got = await db.sql<{ id: string; youtube_id: string }[]>`
      SELECT id, youtube_id FROM match_transcript_chunks_scoped(${vec(q)}::vector, 0.3, 30, ${["TARGETvid01"]}::text[])
    `;
    assert.equal(got.length, 8);
    assert.ok(got.every((r) => r.youtube_id === "TARGETvid01"));
    assert.deepEqual(got.map((r) => r.id), exactTop(q, 30, (r) => r.youtube === "TARGETvid01"));
  });

  test("date scope is half-open and excludes undated videos; topic scope filters in SQL", async () => {
    const from = new Date("2026-10-31T00:00:00Z");
    const to = new Date("2026-11-01T00:00:00Z");
    const inDay = await db.sql<{ youtube_id: string }[]>`
      SELECT DISTINCT youtube_id FROM match_transcript_chunks_scoped(${vec(q)}::vector, -1, 200, NULL, ${from}, ${to})
    `;
    assert.deepEqual(inDay.map((r) => r.youtube_id), ["TARGETvid01"]);
    const after = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM match_transcript_chunks_scoped(${vec(q)}::vector, -1, 200, NULL, ${to}, NULL)
    `;
    assert.equal(after[0].n, 0, "nothing published on/after 2026-11-01, and the undated video never matches");
    const topic = await db.sql<{ youtube_id: string }[]>`
      SELECT DISTINCT youtube_id FROM match_transcript_chunks_scoped(${vec(q)}::vector, -1, 200, NULL, NULL, NULL, ${["hydra"]}::text[])
    `;
    assert.deepEqual(topic.map((r) => r.youtube_id), ["TARGETvid01"]);
  });

  test("Ask scoped to one video answers from that video (end to end, fake model)", async () => {
    const { askArchive } = await import("../src/lib/retrieval");
    const { validateFilters, validateQuery } = await import("../src/lib/limits");
    const f = validateFilters({ video_ids: ["TARGETvid01"] });
    assert.ok(f.ok);
    const q1 = validateQuery("What did Charles say in this video?");
    assert.ok(q1.ok);
    const res = await askArchive(q1.value, f.value.scope, f.value.filters, { persist: false });
    assert.ok(!("matched" in res), "scoped ask must not fall through to the empty state");
    assert.ok(res.sources.length > 0);
    assert.ok(res.sources.every((s) => s.video_id === "TARGETvid01"));
    // Stored double-escaped entities are decoded for display.
    assert.equal(res.sources[0].title, "Target 'video'");
    // Citations map to real segment ids of that video.
    const ids = new Set(all.filter((r) => r.youtube === "TARGETvid01").map((r) => r.id));
    assert.ok(res.citations.every((c) => ids.has(c.segment_id)));
    assert.deepEqual(res.generated_by, { engine: "site", provider: "openai", model: "gpt-4o-mini" });
  });

  test("date-scoped Ask ('last N days' style) only cites in-window videos", async () => {
    const { askArchive } = await import("../src/lib/retrieval");
    const { validateFilters } = await import("../src/lib/limits");
    const f = validateFilters({ date_from: "2026-01-01" });
    assert.ok(f.ok);
    const res = await askArchive("Recent question", f.value.scope, f.value.filters, { persist: false });
    assert.ok(!("matched" in res));
    assert.ok(res.sources.every((s) => s.video_id === "TARGETvid01"));
  });
});
