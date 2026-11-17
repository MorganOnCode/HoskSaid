/**
 * /analytics against an isolated fixture database: live coverage and sources,
 * the rankings refresh, snapshot staleness, API bounds and zero model spend.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { NextRequest } from "next/server";
import { SKIP_DB, createTestDb, seedVideo, type FixtureVideo, type TestDb } from "./helpers/db";
import { startFakeOpenAI, type FakeOpenAI } from "./helpers/fake-openai";
import { SUBJECTS } from "../src/lib/analytics/subjects";

/** Only stopwords/fillers: never ranked, so the fixture controls every content word. */
const FILLER = "so we are going to think about it and you know that is really what we do".split(" ");
const filler = (n: number) => Array.from({ length: n }, (_, i) => FILLER[i % FILLER.length]).join(" ");

interface Spec extends FixtureVideo {
  year: number | null;
  midnight?: boolean;
}

const YEARS = [2020, 2021, 2022, 2023, 2025];
const PER_YEAR = 22;
/** How many videos per year mention Midnight. */
const MIDNIGHT: Record<number, number> = { 2020: 5, 2021: 3, 2022: 10, 2023: 15, 2025: 22 };

function fixture(): Spec[] {
  const out: Spec[] = [];
  for (const year of YEARS) {
    for (let i = 0; i < PER_YEAR; i++) {
      const id = `an${year}v${String(i).padStart(2, "0")}`;
      const midnight = i < MIDNIGHT[year];
      const mid = [
        midnight ? (year < 2022 ? "it is almost midnight here" : "Midnight protects data on chain") : "",
        year < 2022 ? "the cardinal network" : "the cardano network",
        year === 2025 ? "leios throughput" : "",
        // "partner" appears well before the phrase, so a word-level excerpt would miss it.
        year === 2023 && i < 4 ? `the partner program matters ${filler(60)} we built partner chains for this` : "",
        year === 2023 && i >= 18 ? "hydra heads" : "",
      ].join(` ${filler(8)} `);
      const text = `this is charles hoskinson broadcasting live from warm sunny colorado ${filler(320)} ${mid} ${filler(320)} cheers`;
      const spec: Spec = {
        youtube_id: id,
        year,
        midnight,
        title: year === 2022 && i === 0 ? "Hydra heads explained" : `Update ${year} number ${i}`,
        published_at: new Date(Date.UTC(year, i % 12, 1 + i)).toISOString(),
        cleaned_text: text,
      };
      if (year === 2025 && midnight) {
        // Timed segments: the match is at 6:00, except in video 21 whose timed segments miss it.
        spec.chunks = i === 21
          ? [{ content: "Welcome everyone", start: 0, end: 30 }]
          : [{ content: "Welcome everyone", start: 0, end: 30 }, { content: "Midnight protects data on chain", start: 360, end: 390 }];
      }
      out.push(spec);
    }
  }
  // Title-only match in a thin year (no transcript at all).
  out.push({ youtube_id: "an2024title", year: 2024, title: "Hydra update", published_at: "2024-05-01T12:00:00Z" });
  // Tag-only "mithril": tags are not speech, so this never counts.
  out.push({ youtube_id: "an2023tag01", year: 2023, title: "Weekly update", published_at: "2023-12-30T12:00:00Z", cleaned_text: `hello ${filler(50)}`, tags: ["Mithril"] });
  // Excluded from every count: undated, and not completed.
  out.push({ youtube_id: "anundated01", year: null, published_at: null, cleaned_text: "midnight again" });
  out.push({ youtube_id: "anpending01", year: 2025, status: "processing", published_at: "2025-03-01T12:00:00Z", cleaned_text: "midnight pending" });
  return out;
}

const SPECS = fixture();
const ANSWER_ROWS = 3;

describe("analytics", { skip: SKIP_DB }, () => {
  let db: TestDb;
  let fake: FakeOpenAI;
  let data: typeof import("../src/lib/analytics/data");
  let views: typeof import("../src/lib/analytics/views");
  let refresh: typeof import("../src/lib/analytics/refresh");
  let cache: typeof import("../src/lib/cache");
  let covRoute: typeof import("../src/app/api/analytics/route");
  let srcRoute: typeof import("../src/app/api/analytics/sources/route");
  let rankRoute: typeof import("../src/app/api/analytics/rankings/route");
  let topicsRoute: typeof import("../src/app/api/topics/route");
  let ip = 0;
  const get = (path: string, fixedIp?: string) =>
    new NextRequest(`http://localhost${path}`, { headers: { "cf-connecting-ip": fixedIp ?? `10.0.${Math.floor(++ip / 250)}.${ip % 250}` } });

  before(async () => {
    db = await createTestDb();
    process.env.PUBLIC_DATA_CACHE_SECONDS = "0";
    process.env.TRUST_CLOUDFLARE_IP = "true";
    fake = await startFakeOpenAI({ embeddingFor: () => [1] });
    for (const s of SPECS) await seedVideo(db.sql, s);
    // Visitor answers exist but must never be read or changed by analytics.
    for (let i = 0; i < ANSWER_ROWS; i++) {
      await db.sql`INSERT INTO answers (question, answer, sources) VALUES ('private question', 'a', ${db.sql.json([{ video_id: "an2025v00" }])})`;
    }
    data = await import("../src/lib/analytics/data");
    views = await import("../src/lib/analytics/views");
    refresh = await import("../src/lib/analytics/refresh");
    cache = await import("../src/lib/cache");
    covRoute = await import("../src/app/api/analytics/route");
    srcRoute = await import("../src/app/api/analytics/sources/route");
    rankRoute = await import("../src/app/api/analytics/rankings/route");
    topicsRoute = await import("../src/app/api/topics/route");
  });

  after(async () => {
    await fake?.close();
    await db?.drop();
  });

  const perYear = (year: number) => SPECS.filter((s) => s.year === year && (s.status ?? "completed") === "completed").length;

  test("coverage counts videos per year with n/N over completed, dated videos", async () => {
    const [c] = await data.getCoverage(["midnight"], 2020, 2025);
    assert.equal(c.status, "ok");
    for (const y of YEARS) {
      const row = c.by_year.find((b) => b.year === y)!;
      assert.deepEqual([row.matched, row.videos], [MIDNIGHT[y], perYear(y)], `year ${y}`);
    }
    // 2024 holds only the title-only Hydra video: a thin year with no Midnight.
    assert.deepEqual(c.by_year.find((b) => b.year === 2024), { year: 2024, videos: 1, matched: 0, title_only: 0 });
    // The undated and the processing video are never counted.
    assert.equal(c.matched, Object.values(MIDNIGHT).reduce((a, b) => a + b, 0));
    assert.equal(c.of, SPECS.filter((s) => s.year !== null && (s.status ?? "completed") === "completed").length);
    assert.equal(c.first?.youtube_id, "an2020v00");
    assert.equal(c.latest?.published_at.slice(0, 4), "2025");
    const archive = await data.getArchiveYears();
    assert.equal(archive.undated, 1);
  });

  test("titles count, tags do not, and stemming matches word forms", async () => {
    const [hydra, mithril, chain] = await data.getCoverage(["hydra", "mithril", '"partner chain"'], 2020, 2025);
    assert.equal(hydra.matched, 4 + 1 + 1); // 4 transcripts (2023) + 2 titles
    assert.equal(hydra.title_only, 2);
    assert.equal(mithril.matched, 0, "a tag-only match is not spoken coverage");
    assert.equal(chain.matched, 4, "the singular phrase matches “partner chains”");
  });

  test("year scoping and unsupported queries", async () => {
    const [c] = await data.getCoverage(["midnight"], 2022, 2023);
    assert.deepEqual(c.by_year.map((b) => b.year), [2022, 2023]);
    assert.equal(c.matched, MIDNIGHT[2022] + MIDNIGHT[2023]);
    const [stop, neg] = await data.getCoverage(["the of", "-midnight"], 2020, 2025);
    assert.equal(stop.status, "empty");
    assert.equal(neg.status, "negative_only");
  });

  test("sources paginate newest first inside the year", async () => {
    const p1 = await data.getSources("midnight", 2020, 2025, 2025, 1);
    assert.deepEqual([p1.total, p1.pages, p1.items.length], [22, 3, 10]);
    const dates = p1.items.map((i) => i.published_at!);
    assert.deepEqual(dates, [...dates].sort().reverse());
    assert.ok(p1.items.every((i) => i.published_at!.startsWith("2025")));
    const p3 = await data.getSources("midnight", 2020, 2025, 2025, 3);
    assert.equal(p3.items.length, 2);
    const ids = new Set([...p1.items, ...(await data.getSources("midnight", 2020, 2025, 2025, 2)).items, ...p3.items].map((i) => i.youtube_id));
    assert.equal(ids.size, 22);
    const beyond = await data.getSources("midnight", 2020, 2025, 2025, 4);
    assert.deepEqual([beyond.items.length, beyond.total], [0, 22]);
  });

  test("phrase-aware excerpts find the phrase even when a word appears earlier", async () => {
    const s = await data.getSources('"partner chains"', 2020, 2025, null, 1);
    assert.equal(s.total, 4);
    for (const it of s.items) assert.match(it.excerpt ?? "", /\u0001partner chains\u0002/i);
  });

  test("timestamps only for genuine timed matches; otherwise transcript or video links", async () => {
    const s2025 = [
      ...(await data.getSources("midnight", 2025, 2025, null, 1)).items,
      ...(await data.getSources("midnight", 2025, 2025, null, 2)).items,
      ...(await data.getSources("midnight", 2025, 2025, null, 3)).items,
    ];
    const timed = s2025.filter((i) => i.link_kind === "timed");
    assert.equal(timed.length, 21);
    assert.ok(timed.every((i) => i.timed_start === 360 && i.href === `/video/${i.youtube_id}?t=360`));
    const miss = s2025.find((i) => i.youtube_id === "an2025v21")!;
    assert.deepEqual([miss.link_kind, miss.href, miss.timed_start], ["video", "/video/an2025v21", null]);
    const untimed = (await data.getSources("midnight", 2023, 2023, null, 1)).items[0];
    assert.equal(untimed.link_kind, "transcript");
    assert.equal(untimed.href, `/video/${untimed.youtube_id}?q=Midnight`);
    const title = (await data.getSources("hydra", 2024, 2024, null, 1)).items[0];
    assert.deepEqual([title.matched_in, title.link_kind, title.excerpt], ["title", "video", null]);
  });

  test("rankings say they are not computed until the refresh runs", async () => {
    const archive = await data.getArchiveYears();
    const panel = await views.getRankingsPanel(archive, { from: 2020, to: 2025 });
    assert.equal(panel.snapshot.state, "missing");
    assert.equal(panel.phrases.ok, false);
    assert.equal(!panel.phrases.ok && panel.phrases.reason, "not_computed");
    // Subjects are live and work without a snapshot.
    const midnight = panel.subjects.find((s) => s.slug === "midnight")!;
    assert.equal(midnight.videos, Object.values(MIDNIGHT).reduce((a, b) => a + b, 0));
    assert.equal(midnight.of_videos, panel.archive_videos);

    // Before migration 010 is applied the page degrades the same way instead of failing.
    await db.sql`ALTER TABLE analytics_rankings RENAME TO analytics_rankings_off`;
    await db.sql`ALTER TABLE analytics_snapshots RENAME TO analytics_snapshots_off`;
    try {
      const noTables = await views.getRankingsPanel(archive, { from: 2020, to: 2025 });
      assert.equal(noTables.snapshot.state, "missing");
      assert.equal(!noTables.formulas.ok && noTables.formulas.reason, "not_computed");
    } finally {
      await db.sql`ALTER TABLE analytics_snapshots_off RENAME TO analytics_snapshots`;
      await db.sql`ALTER TABLE analytics_rankings_off RENAME TO analytics_rankings`;
    }
  });

  test("refresh reads transcripts, writes only its own tables, and publishes one snapshot", async () => {
    const fingerprint = async () => {
      const tables = await db.sql<{ t: string }[]>`
        SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'analytics_%' ORDER BY 1`;
      const counts: Record<string, number> = {};
      for (const { t } of tables) counts[t] = (await db.sql.unsafe(`SELECT count(*)::int AS n FROM "${t}"`))[0].n;
      const [h] = await db.sql<{ h: string }[]>`SELECT md5(string_agg(t.cleaned_text || t.updated_at::text, '|' ORDER BY t.id)) AS h FROM transcripts t`;
      return { counts, h: h.h };
    };
    const beforeFp = await fingerprint();
    const dry = await refresh.refreshAnalytics(db.sql, { dryRun: true, maxRssMb: 2048 });
    assert.equal(dry.published, false);
    assert.equal((await db.sql`SELECT 1 FROM analytics_snapshots`).length, 0, "dry run writes nothing");

    const r1 = await refresh.refreshAnalytics(db.sql, { maxRssMb: 2048 });
    assert.equal(r1.published, true);
    assert.equal(r1.videos, SPECS.filter((s) => s.year !== null && s.cleaned_text && (s.status ?? "completed") === "completed").length);
    assert.ok(r1.measured.peak_rss_mb > 0 && r1.measured.db_read_ms >= 0);
    const rows1 = await db.sql`SELECT year_from, year_to, list, rank, item, videos, of_videos FROM analytics_rankings ORDER BY 1, 2, 3, 4`;
    assert.ok(rows1.length > 0);

    const r2 = await refresh.refreshAnalytics(db.sql, { maxRssMb: 2048 });
    const rows2 = await db.sql`SELECT year_from, year_to, list, rank, item, videos, of_videos FROM analytics_rankings ORDER BY 1, 2, 3, 4`;
    assert.deepEqual(rows2.map((r) => ({ ...r })), rows1.map((r) => ({ ...r })), "same input, same rankings");
    assert.deepEqual((await db.sql`SELECT id::int AS id FROM analytics_snapshots`).map((r) => r.id), [r2.snapshot_id], "previous snapshot replaced");
    assert.deepEqual(await fingerprint(), beforeFp, "no other table or transcript changed");
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM answers`)[0].n, ANSWER_ROWS);
  });

  test("published rankings: denominators, formulas, caption flags and the era guard", async () => {
    cache.clearPublicCache();
    const archive = await data.getArchiveYears();
    const all = await views.getRankingsPanel(archive, { from: 2020, to: 2025 });
    assert.equal(all.snapshot.state, "current");
    assert.ok(all.phrases.ok && all.formulas.ok && all.keywords.ok);
    const ranked = (await data.getSnapshotStatus()) as { snapshot: { years: { year: number; videos: number }[] } };
    const rankable = ranked.snapshot.years.filter((y) => y.year >= 2020 && y.year <= 2025).reduce((s, y) => s + y.videos, 0);
    assert.ok(all.phrases.items.every((i) => i.of_videos === rankable));
    assert.ok(!all.phrases.items.some((i) => /sunny|hoskinson/.test(i.item)), "the greeting never enters the phrase ranking");
    assert.ok(all.formulas.items.some((i) => i.item.includes("warm sunny colorado")));
    const cardinal = all.keywords.items.find((i) => i.item === "cardinal");
    assert.deepEqual(cardinal?.flags, ["Cardano"]);
    assert.equal(!all.distinctive.ok && all.distinctive.reason, "crosses_era");

    const y2025 = await views.getRankingsPanel(archive, { from: 2025, to: 2025 });
    assert.ok(y2025.distinctive.ok);
    assert.equal(y2025.distinctive.items[0].item, "leios");
    assert.match(y2025.distinctive.comparison ?? "", /^2022–2023 \(\d+ transcripts\)$/);

    const thin = await views.getRankingsPanel(archive, { from: 2024, to: 2024 });
    assert.equal(!thin.phrases.ok && thin.phrases.reason, "no_years");
  });

  test("a changed archive marks the snapshot stale; an old method hides it", async () => {
    cache.clearPublicCache();
    await seedVideo(db.sql, { youtube_id: "an2025late1", published_at: "2025-12-31T10:00:00Z", cleaned_text: `midnight ${filler(20)}` });
    const stale = await data.getSnapshotStatus();
    assert.equal(stale.state, "stale");
    await db.sql`UPDATE analytics_snapshots SET method = 'rank-v0'`;
    cache.clearPublicCache();
    const archive = await data.getArchiveYears();
    const panel = await views.getRankingsPanel(archive, { from: 2020, to: 2025 });
    assert.equal(!panel.phrases.ok && panel.phrases.reason, "outdated_method");
    await refresh.refreshAnalytics(db.sql, { maxRssMb: 2048 });
    cache.clearPublicCache();
    assert.equal((await data.getSnapshotStatus()).state, "current");
  });

  test("a refresh published while the status is memoised serves the new snapshot, not empty lists", async () => {
    process.env.PUBLIC_DATA_CACHE_SECONDS = "120";
    cache.clearPublicCache();
    try {
      const archive = await data.getArchiveYears();
      const first = await views.getRankingsPanel(archive, { from: 2025, to: 2025 });
      assert.equal(first.snapshot.state, "current");
      const r = await refresh.refreshAnalytics(db.sql, { maxRssMb: 2048 });
      const later = await views.getRankingsPanel(archive, { from: 2020, to: 2025 });
      assert.ok(later.phrases.ok && later.keywords.ok && later.formulas.ok, "lists come from the published snapshot");
      const status = await data.getSnapshotStatus();
      assert.equal("snapshot" in status && status.snapshot.id, r.snapshot_id);
    } finally {
      process.env.PUBLIC_DATA_CACHE_SECONDS = "0";
      cache.clearPublicCache();
    }
  });

  test("the API refuses invalid or oversized input with 400", async () => {
    const status = async (path: string) => (await (path.startsWith("/api/analytics/sources") ? srcRoute : path.startsWith("/api/analytics/rankings") ? rankRoute : covRoute).GET(get(path))).status;
    assert.equal(await status("/api/analytics?q=a1&q=b1&q=c1&q=d1"), 400);
    assert.equal(await status(`/api/analytics?q=${"x".repeat(201)}`), 400);
    assert.equal(await status("/api/analytics"), 400);
    assert.equal(await status("/api/analytics?q=midnight&from=20x0"), 400);
    assert.equal(await status("/api/analytics?q=midnight&from=2025&to=2020"), 400);
    assert.equal(await status("/api/analytics?q=midnight&sql=select"), 400);
    assert.equal(await status("/api/analytics/sources?q=midnight&page=21"), 400);
    assert.equal(await status("/api/analytics/sources?q=midnight&q=hydra"), 400);
    assert.equal(await status("/api/analytics/sources?q=midnight&from=2022&to=2023&year=2025"), 400);
    const ok = await covRoute.GET(get("/api/analytics?q=midnight&q=%22partner%20chains%22&from=2022&to=2025"));
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body.range, { from: 2022, to: 2025 });
    assert.equal(body.terms[1].matched, 4);
    const src = await (await srcRoute.GET(get("/api/analytics/sources?q=midnight&year=2025&page=3"))).json();
    assert.deepEqual([src.total, src.page, src.pages, src.items.length], [23, 3, 3, 3]);
    const rank = await (await rankRoute.GET(get("/api/analytics/rankings?from=2025&to=2025"))).json();
    assert.equal(rank.method, "rank-v1");
    assert.equal(rank.distinctive.ok, true);
  });

  test("the API is rate-limited per client, charging one unit per query", async () => {
    const one = "10.9.9.9";
    let first429 = 0;
    for (let i = 1; i <= 45; i++) {
      const r = await covRoute.GET(get("/api/analytics?q=midnight&q=hydra&q=leios", one));
      if (r.status === 429) {
        first429 = i;
        assert.ok(r.headers.get("retry-after"));
        break;
      }
    }
    // Anonymous burst is 120 units: 40 three-query requests fit, the 41st does not.
    assert.equal(first429, 41);
  });

  test("a slow query is cut off by the statement timeout and reported as 503", async () => {
    process.env.ANALYTICS_STATEMENT_TIMEOUT_MS = "200";
    const lock = await db.sql.reserve();
    try {
      await lock`BEGIN`;
      await lock`LOCK TABLE transcripts IN ACCESS EXCLUSIVE MODE`;
      const t0 = Date.now();
      const r = await covRoute.GET(get("/api/analytics?q=timeoutprobe"));
      assert.equal(r.status, 503);
      assert.equal((await r.json()).error, "query_timeout");
      assert.ok(Date.now() - t0 < 5000);
      await assert.rejects(data.getCoverage(["timeoutprobe2"], 2020, 2025), data.AnalyticsTimeoutError);
    } finally {
      await lock`ROLLBACK`;
      lock.release();
      delete process.env.ANALYTICS_STATEMENT_TIMEOUT_MS;
    }
  });

  test("analytics never calls a model or embedding API and never spends site budget", async () => {
    await data.getCoverage(["midnight", "hydra"], 2020, 2025);
    await data.getSources("midnight", 2020, 2025, null, 1);
    await views.getRankingsPanel(await data.getArchiveYears(), { from: 2020, to: 2025 });
    await refresh.refreshAnalytics(db.sql, { dryRun: true, maxRssMb: 2048 });
    assert.deepEqual([fake.calls.embeddings, fake.calls.chat], [0, 0]);
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM site_usage_daily`)[0].n, 0);
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM answers`)[0].n, ANSWER_ROWS);
  });

  test("the topics API keeps its response shape", async () => {
    const r = await topicsRoute.GET(get("/api/topics"));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { items: [] });
  });

  test("refresh refuses to run over its memory cap and writes nothing", async () => {
    const before = (await db.sql`SELECT id FROM analytics_snapshots`).map((r) => r.id);
    await assert.rejects(refresh.refreshAnalytics(db.sql, { maxRssMb: 1 }), (e: Error) => e.name === "RefreshError" && /memory cap/.test(e.message));
    assert.deepEqual((await db.sql`SELECT id FROM analytics_snapshots`).map((r) => r.id), before);
  });

  test("operator CLI: strict flags, dry-run measurement and status", async () => {
    const { main } = await import("../src/cli/main");
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const run = async (argv: string[]) => {
      out.length = 0;
      process.stdout.write = ((c: string | Uint8Array) => (out.push(String(c)), true)) as typeof process.stdout.write;
      try {
        return await main(argv);
      } finally {
        process.stdout.write = write;
        globalThis.__hosksaidPg = undefined; // main() closes the app pool
      }
    };
    assert.equal(await run(["analytics", "--bogus"]), 2);
    assert.match(out.join(""), /unknown flag --bogus/);
    assert.equal(await run(["analytics", "status", "--dry-run"]), 2);
    assert.equal(await run(["analytics", "refresh", "--max-rss-mb", "0"]), 2);
    const snapsBefore = (await db.sql`SELECT id FROM analytics_snapshots`).length;
    assert.equal(await run(["analytics", "refresh", "--dry-run", "--max-rss-mb", "2048"]), 0);
    assert.match(out.join(""), /dry run \(nothing written\)/);
    assert.match(out.join(""), /peak_rss_mb: \d+/);
    assert.equal((await db.sql`SELECT id FROM analytics_snapshots`).length, snapsBefore);
    assert.equal(await run(["analytics"]), 0);
    assert.match(out.join(""), /method: rank-v1/);
    assert.match(out.join(""), /stale: no/);
    // A transcript updated after the refresh read it (but before it published) is stale, as on the page.
    await db.sql`UPDATE analytics_snapshots SET source_updated_at = source_updated_at - interval '1 hour'`;
    try {
      assert.equal(await run(["analytics"]), 0);
      assert.match(out.join(""), /stale: transcripts updated since the snapshot/);
    } finally {
      await db.sql`UPDATE analytics_snapshots SET source_updated_at = source_updated_at + interval '1 hour'`;
    }
  });

  test("every subject is a seeded topic", async () => {
    const slugs = (await db.sql<{ slug: string }[]>`SELECT slug FROM topics`).map((r) => r.slug).sort();
    assert.deepEqual(SUBJECTS.map((s) => s.slug).sort(), slugs);
  });

  test("subject aliases count the union of videos, once each", async () => {
    cache.clearPublicCache();
    await seedVideo(db.sql, { youtube_id: "anouro00001", published_at: "2026-02-01T12:00:00Z", cleaned_text: "ouroboros praos" });
    await seedVideo(db.sql, { youtube_id: "anouro00002", published_at: "2026-02-02T12:00:00Z", cleaned_text: "the oroboros protocol" });
    await seedVideo(db.sql, { youtube_id: "anouro00003", published_at: "2026-02-03T12:00:00Z", cleaned_text: "ouroboros and oroboros, both spellings" });
    await seedVideo(db.sql, { youtube_id: "anouro00004", published_at: "2026-02-04T12:00:00Z", title: "Ouroboros Leios", cleaned_text: "ouroboros again" });
    const subjects = await data.getSubjectYears();
    assert.deepEqual(subjects.find((x) => x.slug === "ouroboros")?.by_year, { 2026: 4 });
    const [c] = await data.getCoverage(["ouroboros OR oroboros"], 2026, 2026);
    assert.deepEqual([c.matched, c.of, c.title_only], [4, 4, 0]);
  });
});
