/**
 * Monthly drafts against an isolated fixture database with a fake model:
 * month windows, source selection, citation/evidence checks, coverage of busy
 * months, budgets, failures and retries, concurrency, explicit publication
 * and public isolation. Nothing calls a provider.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { SKIP_DB, createTestDb, seedVideo, type TestDb } from "./helpers/db";
import { fakeDraftModel } from "./helpers/fake-draft-model";
import { addMonths, monthWindow } from "../src/lib/digest/period";
import { checkGrounding } from "../src/lib/digest/grounding";
import { postText } from "../src/lib/render/post";
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
    for (const para of posts.allParagraphs(p.body)) assert.ok(checkGrounding(para.text, posts.evidenceFor(para.cites, p.sources)).ok, para.text);
    // The stored draft passes strict content validation.
    assert.ok(posts.validatePostContent({ title: p.title, dek: p.dek, body: p.body }, p.sources).ok);
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

  test("plans bound execution even when every note and point carries maximum-length citations", async () => {
    const VOCAB = "staking pool delegation governance treasury community funding ledger consensus protocol upgrade security".split(" ");
    const fill = (n: number) => {
      let t = "Charles said";
      for (let i = 0; t.length < n; i++) t += ` ${VOCAB[i % VOCAB.length]}`;
      return t.slice(0, n);
    };
    await db.sql`DELETE FROM videos WHERE published_at >= '2026-06-01' AND published_at < '2026-07-01'`;
    for (let i = 1; i <= 10; i++) {
      await seedVideo(db.sql, {
        youtube_id: `JUNvideo${String(i).padStart(3, "0")}`,
        title: `Packing talk ${String(i).padStart(2, "0")}`,
        published_at: new Date(Date.UTC(2026, 5, i, 8)).toISOString(),
        chunks: Array.from({ length: 16 }, (_, k) => ({ content: VOCAB.slice(k % 4).concat(VOCAB).join(" "), start: 10 * (k + 1) })),
      });
    }
    const limits = { synthesisInputChars: 7_000, maxReduceLevels: 2, notesPerVideo: 4, noteChars: 100, reducePoints: 3 };
    const longest = (user: string) =>
      [...new Set([...user.matchAll(/\[([^\]"]+)\]/g)].flatMap((m) => m[1].split(", ")).filter((c) => /^S\d+(\.\d+)?$/.test(c)))]
        .sort((a, b) => b.length - a.length || b.localeCompare(a))
        .slice(0, 12);
    const adversarial = (reduceReply?: () => unknown) =>
      fakeDraftModel({
        reply: (stage, user, def) => {
          if (stage === "notes") return { notes: Array.from({ length: 4 }, () => ({ text: fill(limits.noteChars), cites: Array.from({ length: 12 }, (_, k) => `V.${16 - k}`) })) };
          if (stage === "reduce") return reduceReply ? reduceReply() : { points: Array.from({ length: limits.reducePoints }, () => ({ text: fill(400), cites: longest(user) })) };
          return def;
        },
      });

    const dry = await gen({ period: "2026-06", dryRun: true, limits });
    assert.equal(dry.status, "dry_run");
    if (dry.status !== "dry_run") return;
    const plan = dry.report.plan;
    assert.ok(plan.feasible);
    assert.equal(plan.notes_calls, 10);

    const model = adversarial();
    const r = await gen({ period: "2026-06", model, limits: { ...limits, maxCallsPerRun: plan.total_calls_max } });
    assert.equal(r.status, "created", JSON.stringify(r).slice(0, 300));
    if (r.status !== "created") return;
    assert.ok(model.byStage("reduce") >= 1, "the notes did not fit one synthesis input");
    assert.ok(model.byStage("reduce") <= plan.reduce_calls_max, `reduce ${model.byStage("reduce")} > planned ${plan.reduce_calls_max}`);
    assert.ok(r.calls <= plan.total_calls_max, `calls ${r.calls} > planned ${plan.total_calls_max}`);
    for (const c of model.calls.filter((x) => x.stage === "reduce")) assert.ok(c.user.length <= limits.synthesisInputChars + 10, `reduce input ${c.user.length}`);
    const final = model.calls.find((x) => x.stage === "final")!;
    assert.ok(final.user.split("--- NOTES ---\n\n")[1].length <= limits.synthesisInputChars, "final notes fit the synthesis input");
    assert.equal(r.post.coverage.videos_covered, 10);

    // A reduce that yields nothing usable can never push a run past its plan.
    await db.sql`DELETE FROM posts`;
    const cachedPlan = await gen({ period: "2026-06", dryRun: true, limits });
    assert.ok(cachedPlan.status === "dry_run");
    if (cachedPlan.status !== "dry_run") return;
    const empty = adversarial(() => ({ points: [] }));
    const failed = await gen({ period: "2026-06", model: empty, limits });
    assert.equal(failed.status, "synthesis_failed");
    if (failed.status === "synthesis_failed") {
      assert.ok(failed.calls <= cachedPlan.report.plan.total_calls_max, `calls ${failed.calls} > planned ${cachedPlan.report.plan.total_calls_max}`);
      assert.match(failed.reason, /more calls than planned|reduce levels/);
    }
    assert.equal(await count("posts"), 0);
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

    // The same video fails again on a retry: no resynthesis, the reviewed revision stays valid.
    const stillFlaky = fakeDraftModel({ fail: (stage, user) => stage === "notes" && user.includes("Hydra update") });
    const retry = await gen({ model: stillFlaky });
    assert.equal(retry.status, "unchanged");
    assert.equal(stillFlaky.byStage("notes"), 1, "only the failed video is retried");
    assert.equal(stillFlaky.byStage("final"), 0);
    const kept = (await posts.getPostByPeriod("2026-10"))!;
    assert.equal(kept.revision, 1);
    assert.deepEqual(kept.body, r.post.body);
    const [retryRun] = await db.sql`SELECT outcome, calls, detail FROM post_generation_runs ORDER BY id DESC LIMIT 1`;
    assert.equal(retryRun.outcome, "unchanged");
    assert.equal(retryRun.calls, 1);
    assert.ok(retryRun.detail.missing.some((m: { video_id: string; reason: string }) => m.video_id === "OCTvideo002" && m.reason === "model_failed"));
    assert.ok(JSON.stringify(retryRun.detail.rejected).includes("HTTP 401"));
    // Malformed output for that video is the same outcome.
    const garbled = fakeDraftModel({ reply: (stage, user, def) => (stage === "notes" && user.includes("Hydra update") ? "not json" : def) });
    assert.equal((await gen({ model: garbled })).status, "unchanged");
    assert.equal(garbled.byStage("final"), 0);
    assert.equal((await posts.getPostByPeriod("2026-10"))!.revision, 1);
    const missingReason = (p: Post) => p.coverage.missing.find((m) => m.video_id === "OCTvideo002")?.reason;
    const lastRun = async () => (await db.sql`SELECT outcome, calls, detail FROM post_generation_runs ORDER BY id DESC LIMIT 1`)[0];

    // not_attempted -> model_failed: no resynthesis; only the stored reason (a metadata revision) changes.
    await db.sql`
      UPDATE posts SET coverage = jsonb_set(coverage, '{missing}', (
        SELECT jsonb_agg(CASE WHEN m->>'video_id' = 'OCTvideo002' THEN jsonb_set(m, '{reason}', '"not_attempted"') ELSE m END)
        FROM jsonb_array_elements(coverage->'missing') m))
      WHERE period = '2026-10'`;
    const failsAgain = fakeDraftModel({ fail: (stage, user) => stage === "notes" && user.includes("Hydra update") });
    const reasonOnly = await gen({ model: failsAgain });
    assert.equal(reasonOnly.status, "updated");
    assert.equal(failsAgain.byStage("notes"), 1);
    assert.equal(failsAgain.byStage("final"), 0);
    let post = (await posts.getPostByPeriod("2026-10"))!;
    assert.equal(post.revision, 2);
    assert.equal(missingReason(post), "model_failed");
    assert.deepEqual(post.body, r.post.body);
    assert.deepEqual(post.sources, r.post.sources);
    assert.equal((await lastRun()).outcome, "coverage_updated");

    // Transient failure -> terminal no_grounded_notes: same input, coverage now says why.
    const ungrounded = fakeDraftModel({
      reply: (stage, user, def) => (stage === "notes" && user.includes("Hydra update") ? { notes: [{ text: "Charles endorsed Solana and a 1000x rally.", cites: ["V"] }] } : def),
    });
    assert.equal((await gen({ model: ungrounded })).status, "updated");
    assert.equal(ungrounded.byStage("notes"), 1);
    assert.equal(ungrounded.byStage("final"), 0);
    post = (await posts.getPostByPeriod("2026-10"))!;
    assert.equal(post.revision, 3);
    assert.equal(missingReason(post), "no_grounded_notes");
    assert.deepEqual(post.body, r.post.body);
    assert.deepEqual(post.sources, r.post.sources);
    assert.match(postText(post, ""), /Hydra update \(no statement passed the source check\)/, "displayed coverage matches the post reason");
    const ev = await posts.postEvents(post.id);
    assert.deepEqual(ev.map((e) => [e.action, e.revision]), [["generated", 1], ["regenerated", 2], ["regenerated", 3]]);

    // A later scheduled recheck spends nothing on the unchanged input.
    const recheck = fakeDraftModel();
    const quiet = await gen({ model: recheck, trigger: "schedule", now: new Date(NOW.getTime() + 86_400_000) });
    assert.equal(quiet.status, "unchanged");
    assert.equal(recheck.calls.length, 0);
    assert.equal((await lastRun()).calls, 0);
    assert.equal((await posts.getPostByPeriod("2026-10"))!.revision, 3);

    // Changed source material is new input: that video is noted again and the draft resynthesised.
    await db.sql`UPDATE transcripts SET summary = '• Hydra heads processed thousands of transactions in new tests.' WHERE video_id = (SELECT id FROM videos WHERE youtube_id = 'OCTvideo002')`;
    const ok = fakeDraftModel();
    const again = await gen({ model: ok });
    await db.sql`UPDATE transcripts SET summary = '• Hydra heads are now processing thousands of transactions in tests.' WHERE video_id = (SELECT id FROM videos WHERE youtube_id = 'OCTvideo002')`;
    assert.equal(again.status, "updated");
    assert.equal(ok.byStage("notes"), 1, "only the changed video's notes are requested");
    assert.equal(ok.byStage("final"), 1);
    if (again.status === "updated") {
      assert.equal(again.post.revision, 4);
      assert.equal(missingReason(again.post), undefined);
      assert.ok(again.post.sources.some((x) => x.video_id === "OCTvideo002"));
    }
    assert.equal(await count("posts"), 1);
  });

  test("a publication during a retry wins over the coverage update", async () => {
    const r = await gen({ model: fakeDraftModel({ fail: (stage, user) => stage === "notes" && user.includes("Hydra update") }) });
    assert.equal(r.status, "created");
    if (r.status !== "created") return;
    const base = fakeDraftModel({
      reply: (stage, user, def) => (stage === "notes" && user.includes("Hydra update") ? { notes: [{ text: "Charles endorsed Solana and a 1000x rally.", cites: ["V"] }] } : def),
    });
    const racing = {
      ...base,
      async complete(input: { system: string; user: string; maxTokens: number }) {
        if (input.user.includes("Hydra update")) {
          assert.ok((await posts.publishPost("2026-10", { by: "firstmate", revision: 1, acceptIncomplete: true })).changed);
        }
        return base.complete(input);
      },
    };
    const res = await gen({ model: racing });
    assert.equal(res.status, "kept");
    const p = (await posts.getPostByPeriod("2026-10"))!;
    assert.equal(p.status, "published");
    assert.equal(p.revision, 1);
    assert.deepEqual(p.coverage, r.post.coverage, "published coverage is not mutated");
    assert.deepEqual(p.body, r.post.body);
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

  test("retries are idempotent; published and withdrawn posts are never overwritten", async () => {
    const model = fakeDraftModel();
    assert.equal((await gen({ model })).status, "created");
    const again = await gen({ model });
    assert.equal(again.status, "unchanged");
    assert.equal(model.calls.length, 5, "unchanged inputs skip every model call");

    // Late ingestion changes the inputs: a draft is regenerated in place.
    await seedVideo(db.sql, { youtube_id: "LATEvideo01", title: "Late", published_at: "2026-10-28T10:00:00Z", summary: "• Late thoughts on Midnight privacy." });
    const regen = await gen({ model });
    assert.equal(regen.status, "updated");
    assert.equal(model.byStage("notes"), 5, "only the new video's notes were requested");
    assert.equal(await count("posts"), 1);

    // Published: generation keeps it and reports what arrived since.
    const p = (await posts.getPostByPeriod("2026-10"))!;
    assert.ok((await posts.publishPost("2026-10", { by: "tester", revision: p.revision, acceptIncomplete: true })).changed);
    await seedVideo(db.sql, { youtube_id: "LATEvideo02", title: "Later", published_at: "2026-10-29T10:00:00Z", summary: "• Later." });
    const kept = await gen({ model });
    assert.equal(kept.status, "kept");
    if (kept.status === "kept") assert.deepEqual(kept.new_videos, ["LATEvideo02"]);
    await posts.withdrawPost("2026-10", "tester");
    assert.equal((await gen({ model })).status, "kept");
    const after = (await posts.getPostByPeriod("2026-10"))!;
    assert.equal(after.revision, p.revision);
    assert.deepEqual(after.body, p.body);
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

    // A publication during generation wins: the generator does not overwrite it.
    await db.sql`DELETE FROM posts`;
    await db.sql`DELETE FROM post_video_notes`;
    assert.equal((await gen()).status, "created");
    await seedVideo(db.sql, { youtube_id: "RACEvideo01", title: "Race", published_at: "2026-10-27T10:00:00Z", summary: "• Racing condition talk." });
    const slow = fakeDraftModel({ delayMs: 30 });
    const genP = gen({ model: slow });
    // Publication lands while the generator is calling the model.
    await new Promise((r) => setTimeout(r, 20));
    const cur = (await posts.getPostByPeriod("2026-10"))!;
    assert.ok((await posts.publishPost("2026-10", { by: "firstmate", revision: cur.revision, acceptIncomplete: true })).changed);
    const res = await genP;
    assert.equal(res.status, "kept");
    const published = (await posts.getPostByPeriod("2026-10"))!;
    assert.equal(published.status, "published");
    assert.equal(published.revision, cur.revision);
    assert.deepEqual(published.body, cur.body);

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

    const w = await posts.withdrawPost("2026-10", "firstmate");
    assert.ok(w.changed);
    assert.equal(await posts.getPublishedPost("2026-10"), null);
    const w2 = await posts.withdrawPost("2026-10", "firstmate");
    assert.ok(!w2.changed && w2.reason === "already_withdrawn");
    const ev = await posts.postEvents(p.id);
    assert.deepEqual(ev.map((x) => `${x.action}:${x.actor}`), ["generated:generator:cli", "published:firstmate", "withdrawn:firstmate"]);
  });

  test("public reads expose only published posts", async () => {
    await gen({
      model: fakeDraftModel({ reply: (s, _u, d) => (s === "final" ? { ...(d as object), title: "Draft secret title" } : d) }),
    });
    assert.equal((await posts.listPublishedPosts()).length, 0, "the draft is not listed");
    assert.equal(await posts.getPublishedPost("2026-10"), null);

    const p = (await posts.getPostByPeriod("2026-10"))!;
    await posts.publishPost("2026-10", { by: "ed", revision: p.revision, acceptIncomplete: true });
    const [listed] = await posts.listPublishedPosts();
    assert.equal(listed.title, "Draft secret title");
    assert.ok(!/generator|fake-1|prompt_version|input_hash/.test(JSON.stringify(listed)), "no private generation metadata");

    await posts.withdrawPost("2026-10", "ed");
    assert.equal((await posts.listPublishedPosts()).length, 0, "a withdrawn post is not listed");
    assert.equal(await posts.getPublishedPost("2026-10"), null);
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
