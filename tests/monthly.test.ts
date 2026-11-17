/**
 * Monthly drafts against an isolated fixture database with a fake model:
 * month windows, source selection, citation/evidence checks, coverage of busy
 * months, budgets, failures and retries, concurrency, strict edits, explicit
 * publication and public isolation. Nothing calls a provider.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { SKIP_DB, createTestDb, seedVideo, type TestDb } from "./helpers/db";
import { fakeDraftModel } from "./helpers/fake-draft-model";
import { addMonths, monthWindow } from "../src/lib/digest/period";
import type { Post } from "../src/lib/posts";

const NOW = new Date("2026-11-15T00:00:00Z");
const BUDGET = 100;

describe("monthly drafts", { skip: SKIP_DB }, () => {
  let db: TestDb;
  let monthly: typeof import("../src/lib/digest/monthly");
  let posts: typeof import("../src/lib/posts");

  const gen = (o: Partial<Parameters<typeof monthly.generateMonthlyDraft>[0]> = {}) =>
    monthly.generateMonthlyDraft({ period: "2026-10", timezone: "UTC", model: fakeDraftModel(), callBudget: BUDGET, now: NOW, ...o });
  const count = async (table: string) => (await db.sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0].n as number;

  before(async () => {
    db = await createTestDb();
    // October 2026. Bangkok (UTC+7) window: 2026-09-30T17:00Z .. 2026-10-31T17:00Z.
    await seedVideo(db.sql, {
      youtube_id: "OCTvideo001",
      title: "Treasury &amp;#39;reform&amp;#39;",
      published_at: "2026-10-05T10:00:00Z",
      summary: "• Charles argued for treasury reform and <b>bold</b> budget changes.",
      chunks: [
        { content: "We need to reform how the treasury works so the community can fund development.", start: 125 },
        { content: "The second point is that budgets should be approved every 90 days by delegates.", start: 410 },
        { content: "This chunk has a timing beyond the video's end and must never be linked.", start: 9000 },
      ],
    });
    await seedVideo(db.sql, { youtube_id: "OCTvideo002", title: "Hydra update", published_at: "2026-10-20T10:00:00Z", summary: "• Hydra heads are now processing thousands of transactions in tests." });
    // 23:30Z on Oct 31 is November in Bangkok, October in UTC.
    await seedVideo(db.sql, { youtube_id: "EDGEvideo01", title: "Edge of month", published_at: "2026-10-31T23:30:00Z", summary: "• Late night thoughts on governance." });
    // Exactly at the exclusive end: belongs to November.
    await seedVideo(db.sql, { youtube_id: "NOVvideo001", title: "November", published_at: "2026-11-01T00:00:00Z", summary: "• November topic." });
    // In the window but with nothing to cite.
    await seedVideo(db.sql, { youtube_id: "EMPTYvid001", title: "No text", published_at: "2026-10-10T10:00:00Z" });
    // Not yet processed.
    await seedVideo(db.sql, { youtube_id: "PENDvideo01", title: "Pending", published_at: "2026-10-11T10:00:00Z", status: "processing" });
    // Untimed transcript only.
    await seedVideo(db.sql, { youtube_id: "UNTIMEDvid1", title: "Untimed", published_at: "2026-10-12T10:00:00Z", cleaned_text: "Charles explained why formal methods matter for smart contract security and audits." });
    // Visitor questions exist but must never be read.
    await db.sql`INSERT INTO answers (question, answer) VALUES ('PRIVATE VISITOR QUESTION', 'PRIVATE ANSWER')`;
    monthly = await import("../src/lib/digest/monthly");
    posts = await import("../src/lib/posts");
  });
  after(async () => db?.drop());
  beforeEach(async () => {
    await db.sql`DELETE FROM posts`;
    await db.sql`DELETE FROM post_video_notes`;
    await db.sql`DELETE FROM post_generation_runs`;
    await db.sql`DELETE FROM post_generation_budget`;
  });

  test("month windows match Postgres AT TIME ZONE across zones, DST, leap years and rollover", async () => {
    for (const tz of ["UTC", "Asia/Bangkok", "America/New_York", "Europe/London", "Australia/Sydney", "America/Santiago", "Pacific/Chatham"]) {
      let p = "2027-11";
      for (let i = 0; i < 16; i++) {
        const w = monthWindow(p, tz);
        const [row] = await db.sql<{ s: Date }[]>`SELECT ((${p} || '-01')::date::timestamp AT TIME ZONE ${tz}) AS s`;
        assert.equal(w.start.toISOString(), new Date(row.s).toISOString(), `${tz} ${p}`);
        p = addMonths(p, 1);
      }
    }
  });

  test("source selection follows the zone's half-open window and never reads visitor questions", async () => {
    const utc = await gen({ dryRun: true });
    const bkk = await gen({ dryRun: true, timezone: "Asia/Bangkok" });
    assert.ok(utc.status === "dry_run" && bkk.status === "dry_run");
    if (utc.status !== "dry_run" || bkk.status !== "dry_run") return;
    const ids = (r: typeof utc) => (r.status === "dry_run" ? r.report.eligible.map((v) => v.video_id) : []);
    assert.deepEqual(ids(utc), ["OCTvideo001", "UNTIMEDvid1", "OCTvideo002", "EDGEvideo01"]);
    assert.ok(!ids(bkk).includes("EDGEvideo01"));
    assert.ok(!ids(utc).includes("NOVvideo001"), "the exclusive end belongs to the next month");
    assert.equal(bkk.report.window.start, "2026-09-30T17:00:00.000Z");
    assert.deepEqual(utc.report.missing, [
      { video_id: "EMPTYvid001", title: "No text", reason: "no_text" },
      { video_id: "PENDvideo01", title: "Pending", reason: "not_processed" },
    ]);
    assert.equal(utc.report.videos_in_period, 6);
    assert.equal(utc.report.plan.total_calls_max, 5, "4 notes + 1 final");
    assert.equal(await count("posts"), 0, "dry run writes nothing");
    assert.equal(await count("post_generation_runs"), 0);

    const model = fakeDraftModel();
    await gen({ model });
    const all = model.calls.map((c) => c.user).join("\n");
    assert.ok(!all.includes("PRIVATE VISITOR"));
    assert.ok(!all.includes("November topic"));
  });

  test("open months are refused; empty months write nothing and call nothing", async () => {
    const open = await gen({ period: "2026-11" });
    assert.equal(open.status, "month_not_closed");
    const model = fakeDraftModel();
    const empty = await gen({ period: "2026-08", model });
    assert.equal(empty.status, "insufficient_content");
    assert.equal(model.calls.length, 0);
    assert.equal(await count("posts"), 0);
    // A month whose only videos are unprocessed is also insufficient, and says why.
    const r = await gen({ minVideos: 5, model });
    assert.equal(r.status, "insufficient_content");
    assert.match((r as { reason: string }).reason, /4 video\(s\).*need at least 5/);
  });

  test("draft: citations resolve, ungrounded or unknown-cite statements are rejected, every video is covered", async () => {
    const model = fakeDraftModel({
      finalVideos: 2,
      reply: (stage, _user, def) => {
        if (stage !== "final") return def;
        const d = def as { sections: { heading: string; paragraphs: unknown[] }[] };
        d.sections.push({
          heading: "Claims",
          paragraphs: [
            { text: "Charles announced a 500% increase in treasury budgets.", cites: ["S1"] }, // number not in source
            { text: "Charles reviewed treasury reform with Vitalik.", cites: ["S1"] }, // name not in source
            { text: "Charles argued for treasury reform.", cites: ["S99"] }, // unknown id
            { text: "Charles argued for treasury reform.", cites: [] }, // no citation
          ],
        });
        return d;
      },
    });
    const r = await gen({ model });
    assert.equal(r.status, "created");
    if (r.status !== "created") return;
    const p = r.post;
    assert.equal(p.status, "draft");
    assert.equal(p.revision, 1);
    assert.equal(p.slug, "2026-10");
    assert.equal(r.calls, 5);
    // Rejections are recorded with reasons, not silently dropped.
    const reasons = p.generation.rejected.filter((x) => x.stage === "final").map((x) => x.reason);
    assert.ok(reasons.some((x) => /number not in cited source: 500/.test(x)), reasons.join("|"));
    assert.ok(reasons.some((x) => /name not in cited source: vitalik/.test(x)));
    assert.ok(reasons.some((x) => /unknown source id S99/.test(x)));
    assert.ok(reasons.some((x) => /missing citation/.test(x)));
    assert.ok(!JSON.stringify(p.body).includes("500%"));
    // Coverage-preserving: the synthesis cited only 2 videos; the other 2 appear under "Also this month".
    const cited = posts.citedVideoIds(p.body);
    assert.equal(cited.size, 4);
    const also = p.body.sections.find((s) => s.heading === monthly.ALSO_HEADING);
    assert.equal(also?.paragraphs.length, 2);
    assert.equal(p.generation.deterministic_section, true);
    // Coverage is honest about what is missing.
    assert.equal(p.coverage.videos_in_period, 6);
    assert.equal(p.coverage.videos_covered, 4);
    assert.equal(p.coverage.complete, false);
    assert.deepEqual(p.coverage.missing.map((m) => m.reason), ["no_text", "not_processed"]);
    // Sources: decoded titles, DB timings only (the out-of-range chunk is never a moment).
    const s1 = p.sources.find((s) => s.video_id === "OCTvideo001")!;
    assert.equal(s1.title, "Treasury 'reform'");
    assert.deepEqual(s1.moments.map((m) => m.start_seconds), [125, 410]);
    const untimed = p.sources.find((s) => s.video_id === "UNTIMEDvid1")!;
    assert.equal(untimed.moments.length, 0);
    // Every surviving paragraph passes the evidence check against its cited text.
    for (const para of posts.allParagraphs(p.body)) assert.ok(para.cites.length > 0);
    assert.deepEqual(posts.evidenceWarnings(p.body, p.sources), []);
    // The draft round-trips through strict edit validation.
    assert.ok(posts.validateEdit({ revision: p.revision, title: p.title, dek: p.dek, body: p.body }, p.sources).ok);
    // Provenance.
    const ev = await posts.postEvents(p.id);
    assert.deepEqual(ev.map((e) => [e.action, e.actor]), [["generated", "generator:cli"]]);
    const [run] = await db.sql`SELECT outcome, calls, trigger FROM post_generation_runs`;
    assert.deepEqual({ ...run }, { outcome: "created", calls: 5, trigger: "cli" });
  });

  test("busy month: reduce keeps every video, plans are bounded, over-budget plans call nothing", async () => {
    await db.sql`DELETE FROM videos WHERE published_at >= '2026-07-01' AND published_at < '2026-08-01'`;
    for (let i = 0; i < 40; i++) {
      await seedVideo(db.sql, {
        youtube_id: `JULvideo${String(i).padStart(3, "0")}`,
        title: `July talk ${i}`,
        published_at: new Date(Date.UTC(2026, 6, 1 + (i % 30), 8, i)).toISOString(),
        summary: `• Charles discussed topic number ${i} about decentralised governance and community funding.`,
        chunks: [{ content: `In part ${i} Charles explained staking pool decentralisation and why delegation matters.`, start: 30 + i }],
      });
    }
    // Small synthesis input so 40 videos' notes cannot fit one call.
    const limits = { synthesisInputChars: 3_000, maxReduceLevels: 2, notesPerVideo: 1, noteChars: 150, reducePoints: 2 };
    // Too small a budget: refused before any call, nothing written.
    const poor = fakeDraftModel();
    const refused = await gen({ period: "2026-07", model: poor, callBudget: 30, limits });
    assert.equal(refused.status, "over_budget");
    assert.equal(poor.calls.length, 0);
    assert.equal(await count("posts"), 0);
    // Per-run call limit is also enforced up front.
    const capped = await gen({ period: "2026-07", model: poor, limits: { ...limits, maxCallsPerRun: 35 } });
    assert.equal(capped.status, "over_budget");
    assert.match((capped as { reason: string }).reason, /per-run limit is 35/);
    // A plan that cannot fit the reduce levels is refused too, never truncated.
    const tooDeep = await gen({ period: "2026-07", model: poor, limits: { ...limits, maxReduceLevels: 0 } });
    assert.equal(tooDeep.status, "over_budget");
    assert.match((tooDeep as { reason: string }).reason, /exceed 0 reduce level/);
    assert.equal(poor.calls.length, 0);

    const model = fakeDraftModel({ finalVideos: 5 });
    const r = await gen({ period: "2026-07", model, limits });
    assert.equal(r.status, "created");
    if (r.status !== "created") return;
    assert.equal(model.byStage("notes"), 40);
    assert.ok(model.byStage("reduce") >= 2, "notes did not fit one synthesis call");
    assert.equal(model.byStage("final"), 1);
    // Every reduce/final input stays within the limit (no silent truncation needed).
    for (const c of model.calls.filter((x) => x.stage !== "notes")) assert.ok(c.user.length <= limits.synthesisInputChars + 200, `${c.stage} ${c.user.length}`);
    assert.equal(r.post.coverage.videos_covered, 40);
    assert.equal(r.post.coverage.complete, true);
    assert.equal(posts.citedVideoIds(r.post.body).size, 40, "every video is cited somewhere in the post");
    const dry = await gen({ period: "2026-07", dryRun: true, limits });
    assert.ok(dry.status === "dry_run" && r.calls <= BUDGET);
    if (dry.status === "dry_run") assert.equal(dry.report.plan.cached_videos, 40);
    const [{ calls }] = await db.sql`SELECT calls FROM post_generation_budget WHERE period = '2026-07'`;
    assert.equal(calls, r.calls, "every call was charged to the month's budget");
  });

  test("model failures: partial work is visible, cached, and retried without repaying", async () => {
    const flaky = fakeDraftModel({ fail: (stage, user) => stage === "notes" && user.includes("Hydra update") });
    const r = await gen({ model: flaky });
    assert.equal(r.status, "created");
    if (r.status !== "created") return;
    assert.equal(r.post.coverage.complete, false);
    assert.ok(r.post.coverage.missing.some((m) => m.video_id === "OCTvideo002" && m.reason === "model_failed"));
    const stored = JSON.stringify(r.post) + JSON.stringify(await db.sql`SELECT detail FROM post_generation_runs`);
    assert.ok(!stored.includes("sk-test-SECRET"), "provider error text is never stored");
    assert.ok(stored.includes("HTTP 401"));

    // Retry once the provider recovers: only the failed video's notes are requested.
    const ok = fakeDraftModel();
    const again = await gen({ model: ok });
    assert.equal(again.status, "updated");
    assert.equal(ok.byStage("notes"), 1);
    assert.equal(ok.byStage("final"), 1);
    if (again.status === "updated") {
      assert.equal(again.post.revision, 2);
      assert.ok(!again.post.coverage.missing.some((m) => m.reason === "model_failed"));
    }
    assert.equal(await count("posts"), 1);
  });

  test("unusable synthesis writes nothing; notes are kept for the retry", async () => {
    const garbage = fakeDraftModel({ reply: (stage, _u, def) => (stage === "final" ? "not json at all" : def) });
    const r = await gen({ model: garbage });
    assert.equal(r.status, "synthesis_failed");
    assert.equal(await count("posts"), 0);
    const ungrounded = fakeDraftModel({
      reply: (stage, _u, def) => (stage === "final" ? { title: "x", intro: [{ text: "Charles endorsed Solana and a 1000x rally.", cites: ["S1"] }], sections: [] } : def),
    });
    const r2 = await gen({ model: ungrounded });
    assert.equal(r2.status, "synthesis_failed");
    assert.equal(ungrounded.byStage("notes"), 0, "cached notes reused");
    assert.equal(await count("posts"), 0);
    const allNotesFail = fakeDraftModel({ fail: (s) => s === "notes" });
    await db.sql`DELETE FROM post_video_notes`;
    const r3 = await gen({ model: allNotesFail });
    assert.equal(r3.status, "insufficient_content");
    assert.equal(await count("posts"), 0);
  });

  test("retries are idempotent; edited, published and withdrawn posts are never overwritten", async () => {
    const model = fakeDraftModel();
    assert.equal((await gen({ model })).status, "created");
    const again = await gen({ model });
    assert.equal(again.status, "unchanged");
    assert.equal(model.calls.length, 5, "unchanged inputs skip every model call");

    // Late ingestion changes the inputs: an unedited draft is regenerated in place.
    await seedVideo(db.sql, { youtube_id: "LATEvideo01", title: "Late", published_at: "2026-10-28T10:00:00Z", summary: "• Late thoughts on Midnight privacy." });
    const regen = await gen({ model });
    assert.equal(regen.status, "updated");
    assert.equal(model.byStage("notes"), 5, "only the new video's notes were requested");
    assert.equal(await count("posts"), 1);

    // Operator edit: generation keeps it and reports what arrived since.
    const current = (await posts.getPostByPeriod("2026-10"))!;
    const edit = await posts.applyEdit("2026-10", { revision: current.revision, title: "Edited by hand", dek: current.dek, body: current.body }, "tester");
    assert.ok(edit.ok);
    await seedVideo(db.sql, { youtube_id: "LATEvideo02", title: "Later", published_at: "2026-10-29T10:00:00Z", summary: "• Later." });
    const kept = await gen({ model });
    assert.equal(kept.status, "kept");
    if (kept.status === "kept") assert.deepEqual(kept.new_videos, ["LATEvideo02"]);
    assert.equal((await posts.getPostByPeriod("2026-10"))?.title, "Edited by hand");

    const p = (await posts.getPostByPeriod("2026-10"))!;
    assert.ok((await posts.publishPost("2026-10", { by: "tester", revision: p.revision, acceptIncomplete: true })).changed);
    assert.equal((await gen({ model })).status, "kept");
    await posts.withdrawPost("2026-10", "tester");
    assert.equal((await gen({ model })).status, "kept");
    assert.equal((await posts.getPostByPeriod("2026-10"))?.title, "Edited by hand");
    await db.sql`DELETE FROM videos WHERE youtube_id IN ('LATEvideo01', 'LATEvideo02')`;
  });

  test("concurrent generations never duplicate posts or exceed the budget", async () => {
    const a = fakeDraftModel({ delayMs: 40 });
    const b = fakeDraftModel({ delayMs: 40 });
    const [ra, rb] = await Promise.all([gen({ model: a }), gen({ model: b })]);
    const statuses = [ra.status, rb.status].sort();
    assert.deepEqual(statuses, ["busy", "created"]);
    assert.equal(await count("posts"), 1);
    assert.equal(a.calls.length + b.calls.length, 5);

    // A concurrent edit during generation wins: the generator does not overwrite it.
    await db.sql`DELETE FROM posts`;
    await db.sql`DELETE FROM post_video_notes`;
    assert.equal((await gen()).status, "created");
    await seedVideo(db.sql, { youtube_id: "RACEvideo01", title: "Race", published_at: "2026-10-27T10:00:00Z", summary: "• Racing condition talk." });
    let edited = false;
    const slow = fakeDraftModel({
      reply: (stage, _u, def) => {
        if (stage === "final" && !edited) edited = true;
        return def;
      },
      delayMs: 30,
    });
    const genP = gen({ model: slow });
    // Edit lands while the generator is calling the model.
    await new Promise((r) => setTimeout(r, 20));
    const cur = (await posts.getPostByPeriod("2026-10"))!;
    const e = await posts.applyEdit("2026-10", { revision: cur.revision, title: "Human title", dek: cur.dek, body: cur.body }, "editor");
    assert.ok(e.ok);
    const res = await genP;
    assert.equal(res.status, "kept");
    assert.equal((await posts.getPostByPeriod("2026-10"))?.title, "Human title");

    // Budget reservations are atomic under parallel callers.
    await db.sql`DELETE FROM videos WHERE youtube_id = 'RACEvideo01'`;
    await db.sql`DELETE FROM posts`;
    await db.sql`DELETE FROM post_video_notes`;
    await db.sql`DELETE FROM post_generation_budget`;
    const results = await Promise.all(
      ["2026-10", "2026-10", "2026-10"].map((period) => gen({ period, callBudget: 5, model: fakeDraftModel({ delayMs: 10 }) }))
    );
    const [{ calls }] = await db.sql`SELECT calls FROM post_generation_budget WHERE period = '2026-10'`;
    assert.ok(calls <= 5, `charged ${calls}`);
    assert.equal(results.filter((x) => x.status === "created").length, 1);
  });

  test("edits: strict rejection, stale revisions refused, nothing silently dropped", async () => {
    const r = await gen();
    assert.equal(r.status, "created");
    const p = (await posts.getPostByPeriod("2026-10"))!;
    const before = JSON.stringify(p.body);
    const doc = { revision: p.revision, title: p.title, dek: p.dek, body: structuredClone(p.body) };

    const long = structuredClone(doc);
    long.body.intro[0].text = "word ".repeat(400).trim();
    const r1 = await posts.applyEdit("2026-10", long, "ed");
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.ok(r1.errors?.some((x) => /exceeds the 1500 limit/.test(x)));

    const tooMany = structuredClone(doc);
    tooMany.body.sections = Array.from({ length: 13 }, () => p.body.sections[0]);
    assert.equal((await posts.applyEdit("2026-10", tooMany, "ed")).ok, false);

    const badCite = structuredClone(doc);
    badCite.body.intro[0].cites = ["S42"];
    assert.equal((await posts.applyEdit("2026-10", badCite, "ed")).ok, false);

    assert.equal(JSON.stringify((await posts.getPostByPeriod("2026-10"))!.body), before, "rejected edits change nothing");

    // A valid edit applies whole, bumps the revision and records provenance.
    const good = structuredClone(doc);
    good.body.intro[0].text = "An editor rewrote this introduction.";
    const ok = await posts.applyEdit("2026-10", good, "editor-1");
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.equal(ok.post.revision, p.revision + 1);
      assert.equal(ok.post.edited_by, "editor-1");
      assert.equal(ok.post.body.intro[0].text, "An editor rewrote this introduction.");
      assert.ok(ok.warnings.some((w) => /body\.intro\[0\]/.test(w)), "edited wording is flagged against the evidence");
    }
    // Re-applying the same (now stale) export is refused rather than overwriting.
    const stale = await posts.applyEdit("2026-10", good, "editor-2");
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.match(stale.error, /revision mismatch/);
  });

  test("publication is explicit, revision-pinned, and drafts stay private", async () => {
    await gen();
    const p = (await posts.getPostByPeriod("2026-10"))!;
    assert.equal(await posts.getPublishedPost("2026-10"), null, "drafts are a 404 publicly");
    assert.equal((await posts.listPublishedPosts()).length, 0);

    assert.equal((await posts.publishPost("2026-10", { by: "ed", revision: p.revision + 1 })).changed, false);
    const inc = await posts.publishPost("2026-10", { by: "ed", revision: p.revision });
    assert.equal(inc.changed, false);
    if (!inc.changed) assert.equal(inc.reason, "incomplete");
    assert.equal((await posts.publishPost("2099-01", { by: "ed", revision: 1 })).changed, false);

    const pub = await posts.publishPost("2026-10", { by: "firstmate", revision: p.revision, acceptIncomplete: true });
    assert.ok(pub.changed);
    if (pub.changed) assert.equal(pub.post.published_by, "firstmate");
    const again = await posts.publishPost("2026-10", { by: "firstmate", revision: p.revision });
    assert.equal(again.changed, false);
    if (!again.changed) assert.equal(again.reason, "already_published");

    const pubPost = await posts.getPublishedPost("2026-10");
    assert.ok(pubPost);
    assert.ok(!("generation" in pubPost!), "private generation metadata is not selected");
    assert.ok(!("input_hash" in pubPost!));
    const listed = await posts.listPublishedPosts();
    assert.ok(listed.every((x) => !("generation" in x)));
    assert.equal(await posts.getPublishedPost("../../etc"), null);

    // Published posts cannot be edited in place.
    const e = await posts.applyEdit("2026-10", { revision: p.revision, title: "x", dek: null, body: p.body }, "ed");
    assert.equal(e.ok, false);

    const w = await posts.withdrawPost("2026-10", "firstmate");
    assert.ok(w.changed);
    assert.equal(await posts.getPublishedPost("2026-10"), null);
    const w2 = await posts.withdrawPost("2026-10", "firstmate");
    assert.ok(!w2.changed && w2.reason === "already_withdrawn");
    const ev = await posts.postEvents(p.id);
    assert.deepEqual(ev.map((x) => `${x.action}:${x.actor}`), ["generated:generator:cli", "published:firstmate", "withdrawn:firstmate"]);
  });

  test("public feed and pages expose only published posts, escaped", async () => {
    await gen({
      model: fakeDraftModel({ reply: (s, _u, d) => (s === "final" ? { ...(d as object), title: "Draft <i>secret</i> title" } : d) }),
    });
    const feed = await import("../src/app/blog/feed.xml/route");
    const draftXml = await (await feed.GET()).text();
    assert.ok(!draftXml.includes("secret"), "draft is not in the feed");
    assert.ok(!draftXml.includes("<item>"));

    const p = (await posts.getPostByPeriod("2026-10"))!;
    await posts.publishPost("2026-10", { by: "ed", revision: p.revision, acceptIncomplete: true });
    const xml = await (await feed.GET()).text();
    assert.match(xml, /<title>Draft &lt;i&gt;secret&lt;\/i&gt; title<\/title>/);
    assert.ok(!xml.includes("<b>bold</b>"), "source markup is escaped in content");
    assert.match(xml, /\/video\/OCTvideo001\?t=125/);
    assert.ok(!xml.includes("t=9000"));
    assert.ok(!/generator|fake-1|prompt_version|input_hash/.test(xml), "no private generation metadata");
    assert.match(xml, /Covers 4 of 6 videos published in October 2026 \(UTC\); 2 not included\./);

    // Route surface: the blog has no mutation handlers.
    const { readdirSync } = await import("node:fs");
    const files = readdirSync("src/app/blog", { recursive: true }).map(String);
    assert.deepEqual(files.filter((f) => /route\.ts$/.test(f)), ["feed.xml/route.ts"]);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((feed as Record<string, unknown>)[m], undefined);
    const apiFiles = readdirSync("src/app/api", { recursive: true }).map(String);
    assert.ok(!apiFiles.some((f) => /post|blog|publish/i.test(f)), "no API route touches posts");
  });

  test("blog pages render published posts with escaped text and accurate links", async () => {
    await gen({
      model: fakeDraftModel({
        reply: (s, _u, d) => (s === "final" ? { ...(d as object), dek: "A dek with <script>alert(1)</script>" } : d),
      }),
    });
    const p = (await posts.getPostByPeriod("2026-10"))!;
    await posts.publishPost("2026-10", { by: "ed", revision: p.revision, acceptIncomplete: true });
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { PostBody } = await import("../src/components/blog/PostBody");
    const html = renderToStaticMarkup(createElement(PostBody, { post: (await posts.getPublishedPost("2026-10"))! }));
    assert.ok(!html.includes("<b>bold</b>"));
    assert.match(html, /href="\/video\/OCTvideo001\?t=125"/);
    assert.match(html, /href="https:\/\/www\.youtube\.com\/watch\?v=OCTvideo001"/);
    assert.match(html, /Not covered in this digest/);
    assert.match(html, /PENDvideo01/);
    assert.ok(!html.includes("t=9000"));
  });
});

export type { Post };
