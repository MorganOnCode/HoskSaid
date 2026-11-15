/** Discovery honesty: empty facets hidden, full timeline, transcript keyword search. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SKIP_DB, createTestDb, randomUnit, seedVideo, type TestDb } from "./helpers/db";

describe("browse data", { skip: SKIP_DB }, () => {
  let db: TestDb;
  let browse: typeof import("../src/lib/browse");
  let cache: typeof import("../src/lib/cache");

  before(async () => {
    db = await createTestDb();
    process.env.PUBLIC_DATA_CACHE_SECONDS = "0";
    for (let i = 0; i < 450; i++) {
      await seedVideo(db.sql, {
        youtube_id: `tl${String(i).padStart(9, "0")}`,
        published_at: new Date(Date.UTC(2015, 0, 1) + i * 86_400_000 * 9).toISOString(),
        cleaned_text: i === 3 ? "Charles explained the Leios throughput roadmap in detail." : "General remarks about the community.",
        chunks: i < 5 ? [{ content: "chunk", start: 0, embedding: randomUnit(i + 1) }] : [],
      });
    }
    browse = await import("../src/lib/browse");
    cache = await import("../src/lib/cache");
  });
  after(async () => db?.drop());

  test("topics with no assigned videos are excluded (empty until assignment runs)", async () => {
    assert.deepEqual([...(await browse.getTopicsWithCounts())], []);
    const [v] = await db.sql<{ id: string }[]>`SELECT id FROM videos WHERE youtube_id = 'tl000000003'`;
    await db.sql`INSERT INTO video_topics (video_id, topic_id) SELECT ${v.id}, id FROM topics WHERE slug = 'leios'`;
    cache.clearPublicCache();
    const topics = await browse.getTopicsWithCounts();
    assert.deepEqual(topics.map((t) => [t.slug, t.video_count]), [["leios", 1]]);
  });

  test("type facets list only types that have videos", async () => {
    assert.deepEqual([...(await browse.getVideoTypeCounts())], []);
    await db.sql`UPDATE videos SET video_type = 'AMA' WHERE youtube_id IN ('tl000000001', 'tl000000002')`;
    cache.clearPublicCache();
    assert.deepEqual((await browse.getVideoTypeCounts()).map((r) => ({ ...r })), [{ type: "AMA", count: 2 }]);
  });

  test("timeline is no longer truncated at 400", async () => {
    const { videos, total } = await browse.getTimelineVideos();
    assert.equal(total, 450);
    assert.equal(videos.length, 450);
  });

  test("library keyword search reaches transcripts of videos without chunks, with an excerpt", async () => {
    const { rows, total } = await browse.getLibraryVideos({ q: "throughput roadmap" });
    assert.equal(total, 1);
    assert.equal(rows[0].youtube_id, "tl000000003");
    assert.equal(rows[0].matched_in, "transcript");
    assert.match(rows[0].snippet ?? "", /\u0001throughput\u0002/i);
    // LIKE metacharacters are matched literally.
    assert.equal((await browse.getLibraryVideos({ q: "%" })).total, 0);
  });

  test("search vector is maintained by trigger on new and updated transcripts", async () => {
    await seedVideo(db.sql, { youtube_id: "newvideo001", cleaned_text: "A brand new mention of Mithril certificates." });
    assert.equal((await browse.getLibraryVideos({ q: "mithril" })).total, 1);
    await db.sql`UPDATE transcripts SET cleaned_text = 'Now about Hydra heads' WHERE video_id = (SELECT id FROM videos WHERE youtube_id = 'newvideo001')`;
    assert.equal((await browse.getLibraryVideos({ q: "mithril" })).total, 0);
    assert.equal((await browse.getLibraryVideos({ q: "hydra heads" })).total, 1);
  });

  test("most-cited needs enough answers, otherwise it is labelled most-viewed", async () => {
    const few = await browse.getMostCitedVideos(3);
    assert.equal(few.basis, "views");
    for (let i = 0; i < 5; i++) {
      await db.sql`INSERT INTO answers (question, answer, sources) VALUES ('q', 'a', ${db.sql.json([{ video_id: "tl000000004" }])})`;
    }
    cache.clearPublicCache();
    const many = await browse.getMostCitedVideos(3);
    assert.equal(many.basis, "answers");
    assert.equal(many.items[0].youtube_id, "tl000000004");
  });

  test("archive stats report how many videos Ask can reach", async () => {
    const s = await browse.getArchiveStats();
    assert.equal(s.videos, 451);
    assert.equal(s.searchable_videos, 5);
  });
});
