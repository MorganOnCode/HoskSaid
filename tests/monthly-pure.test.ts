/**
 * Monthly drafts, pure parts: calendar windows, schedule arithmetic, the
 * evidence check, strict edit validation, link building and escaping.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addMonths, monthWindow, previousMonth, zonedInstant, parseMonth } from "../src/lib/digest/period";
import { duePeriods, nextScheduledAt, scheduleConfig, scheduledAt } from "../src/lib/digest/schedule";
import { checkGrounding } from "../src/lib/digest/grounding";
import { monthlyModelConfig, describeModelError } from "../src/lib/digest/model";
import { LIMITS, validateEdit, type PostSource } from "../src/lib/posts";
import { escapeHtml, postFeedHtml, resolveCite, youtubeHref } from "../src/lib/render/post";

const iso = (d: Date) => d.toISOString();

test("month windows are half-open, keyed by month, and follow the zone", () => {
  const utc = monthWindow("2026-10", "UTC");
  assert.equal(iso(utc.start), "2026-10-01T00:00:00.000Z");
  assert.equal(iso(utc.end), "2026-11-01T00:00:00.000Z");
  // Year rollover.
  const dec = monthWindow("2026-12", "UTC");
  assert.equal(iso(dec.end), "2027-01-01T00:00:00.000Z");
  // Leap years: February 2028 has 29 days, 2027 has 28, 2100 is not a leap year.
  assert.equal(iso(monthWindow("2028-02", "UTC").end), "2028-03-01T00:00:00.000Z");
  assert.equal((monthWindow("2028-02", "UTC").end.getTime() - monthWindow("2028-02", "UTC").start.getTime()) / 86_400_000, 29);
  assert.equal((monthWindow("2027-02", "UTC").end.getTime() - monthWindow("2027-02", "UTC").start.getTime()) / 86_400_000, 28);
  assert.equal((monthWindow("2100-02", "UTC").end.getTime() - monthWindow("2100-02", "UTC").start.getTime()) / 86_400_000, 28);
  // Bangkok (UTC+7, no DST).
  const bkk = monthWindow("2026-10", "Asia/Bangkok");
  assert.equal(iso(bkk.start), "2026-09-30T17:00:00.000Z");
  assert.equal(iso(bkk.end), "2026-10-31T17:00:00.000Z");
  // New York: October starts in EDT (-4), November 1 is still EDT (DST ends Nov 1 2026 at 02:00).
  assert.equal(iso(monthWindow("2026-10", "America/New_York").start), "2026-10-01T04:00:00.000Z");
  assert.equal(iso(monthWindow("2026-12", "America/New_York").start), "2026-12-01T05:00:00.000Z");
  // Consecutive windows tile time with no gap or overlap.
  for (const tz of ["UTC", "Asia/Bangkok", "America/New_York", "Europe/London", "Australia/Sydney", "America/Santiago"]) {
    let p = "2026-01";
    for (let i = 0; i < 30; i++) {
      assert.equal(iso(monthWindow(p, tz).end), iso(monthWindow(addMonths(p, 1), tz).start), `${tz} ${p}`);
      p = addMonths(p, 1);
    }
  }
});

test("previous month, month keys and rollover in a zone", () => {
  assert.equal(previousMonth(new Date("2026-10-31T18:30:00Z"), "Asia/Bangkok"), "2026-10"); // already Nov 1 in Bangkok
  assert.equal(previousMonth(new Date("2026-10-31T18:30:00Z"), "UTC"), "2026-09");
  assert.equal(previousMonth(new Date("2027-01-01T03:00:00Z"), "UTC"), "2026-12");
  assert.equal(previousMonth(new Date("2027-01-01T03:00:00Z"), "America/Los_Angeles"), "2026-11"); // still Dec 31 there
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2027-01", -1), "2026-12");
  assert.equal(addMonths("2026-03", -15), "2024-12");
  for (const bad of ["2026-13", "2026-00", "26-10", "2026-1", "2026-10-01", "abcd-ef"]) assert.throws(() => parseMonth(bad), bad);
  assert.throws(() => monthWindow("2026-10", "Mars/Olympus"));
});

test("DST gaps and overlaps resolve like Postgres timestamp AT TIME ZONE", () => {
  // America/Santiago springs forward at 24:00 on 2026-09-05 -> 2026-09-06 has no 00:00.
  assert.equal(iso(zonedInstant(2026, 9, 6, 0, 0, "America/Santiago")), "2026-09-06T04:00:00.000Z");
  // Europe/London 01:30 on 2026-10-25 happens twice; the earlier instant wins.
  assert.equal(iso(zonedInstant(2026, 10, 25, 1, 30, "Europe/London")), "2026-10-25T00:30:00.000Z");
  // America/New_York 02:30 on 2026-03-08 does not exist.
  assert.equal(iso(zonedInstant(2026, 3, 8, 2, 30, "America/New_York")), "2026-03-08T07:30:00.000Z");
});

test("schedule: due periods, scheduled time, catch-up window and next run", () => {
  const cfg = { timezone: "UTC", day: 1, hour: 6, catchupMonths: 2 };
  assert.equal(iso(scheduledAt("2026-10", cfg)), "2026-11-01T06:00:00.000Z");
  // Before the scheduled time on the 1st: October is not due yet; September (previous cycle) is.
  assert.deepEqual(duePeriods(new Date("2026-11-01T05:59:00Z"), cfg), ["2026-09"]);
  assert.deepEqual(duePeriods(new Date("2026-11-01T06:00:00Z"), cfg), ["2026-09", "2026-10"]);
  // Missed run: the scheduler was down until the 20th; October is still due.
  assert.deepEqual(duePeriods(new Date("2026-11-20T12:00:00Z"), cfg), ["2026-09", "2026-10"]);
  // Catch-up 1 only looks at the previous month.
  assert.deepEqual(duePeriods(new Date("2026-11-20T12:00:00Z"), { ...cfg, catchupMonths: 1 }), ["2026-10"]);
  // Year rollover.
  assert.deepEqual(duePeriods(new Date("2027-01-02T00:00:00Z"), cfg), ["2026-11", "2026-12"]);
  // Zone-local schedule: 06:00 Bangkok on Nov 1 is 23:00 UTC Oct 31.
  const bkk = { ...cfg, timezone: "Asia/Bangkok" };
  assert.equal(iso(scheduledAt("2026-10", bkk)), "2026-10-31T23:00:00.000Z");
  assert.deepEqual(duePeriods(new Date("2026-10-31T23:30:00Z"), bkk), ["2026-09", "2026-10"]);
  // Next run.
  assert.deepEqual(
    (({ period, at }) => ({ period, at: iso(at) }))(nextScheduledAt(new Date("2026-11-17T00:00:00Z"), cfg)),
    { period: "2026-11", at: "2026-12-01T06:00:00.000Z" }
  );
  assert.equal(iso(nextScheduledAt(new Date("2026-11-01T05:00:00Z"), cfg).at), "2026-11-01T06:00:00.000Z");
  assert.equal(iso(nextScheduledAt(new Date("2026-12-31T23:00:00Z"), { ...cfg, day: 3 }).at), "2027-01-03T06:00:00.000Z");
});

test("schedule config: disabled by default, explicit UTC default, strict values", () => {
  const def = scheduleConfig({});
  assert.ok(def.ok);
  if (!def.ok) return;
  assert.equal(def.config.enabled, false);
  assert.equal(def.config.timezone, "UTC");
  assert.equal(def.config.timezoneSource, "default");
  const on = scheduleConfig({ MONTHLY_DRAFTS_SCHEDULE_ENABLED: "true", MONTHLY_DRAFT_TIMEZONE: "Asia/Bangkok", MONTHLY_SCHEDULE_DAY: "2" });
  assert.ok(on.ok && on.config.enabled && on.config.timezone === "Asia/Bangkok" && on.config.timezoneSource === "env" && on.config.day === 2);
  const bad = scheduleConfig({ MONTHLY_DRAFTS_SCHEDULE_ENABLED: "yes", MONTHLY_DRAFT_TIMEZONE: "Nowhere/Land", MONTHLY_SCHEDULE_DAY: "31", MONTHLY_SCHEDULE_HOUR: "x" });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.invalid.length, 4);
});

test("model config needs an explicit budget and reports names, never values", () => {
  const none = monthlyModelConfig({});
  assert.deepEqual(none, { ok: false, missing: ["OPENAI_API_KEY", "MONTHLY_DRAFT_CALL_BUDGET"], invalid: [] });
  const bad = monthlyModelConfig({ OPENAI_API_KEY: "sk-test-SECRET", MONTHLY_DRAFT_CALL_BUDGET: "unlimited" });
  assert.equal(bad.ok, false);
  assert.ok(!JSON.stringify(bad).includes("sk-test-SECRET"));
  assert.equal(monthlyModelConfig({ OPENAI_API_KEY: "k", MONTHLY_DRAFT_CALL_BUDGET: "0" }).ok, false);
  assert.equal(monthlyModelConfig({ OPENAI_API_KEY: "k", MONTHLY_DRAFT_CALL_BUDGET: "100000" }).ok, false);
  const ok = monthlyModelConfig({ OPENAI_API_KEY: "k", MONTHLY_DRAFT_CALL_BUDGET: "80" });
  assert.deepEqual(ok, { ok: true, config: { model: "gpt-4o-mini", callBudget: 80 } });
  // Provider errors are reduced to a status, dropping messages that echo keys.
  const err = Object.assign(new Error("Incorrect API key provided: sk-test-SECRET"), { status: 401 });
  assert.equal(describeModelError(err), "HTTP 401");
  assert.equal(describeModelError(new Error("sk-test-SECRET")), "provider error");
});

test("evidence check: a valid citation is not enough", () => {
  const ev = ["We need to reform how the treasury works, and the budget process should take 90 days."];
  assert.ok(checkGrounding("Charles argued the treasury needs reform and the budget process should take 90 days.", ev).ok);
  const num = checkGrounding("Charles argued the treasury budget process should take 30 days.", ev);
  assert.equal(num.ok, false);
  assert.match((num as { reason: string }).reason, /number/);
  const name = checkGrounding("Charles said the treasury works with Ethereum on budget reform.", ev);
  assert.equal(name.ok, false);
  assert.match((name as { reason: string }).reason, /name/);
  const off = checkGrounding("Charles predicted that staking rewards will triple after the hard fork.", ev);
  assert.equal(off.ok, false);
  assert.equal(checkGrounding("Anything at all.", [""]).ok, false);
  // Sentence-initial capitals are not treated as names.
  assert.ok(checkGrounding("Treasury reform matters; the budget process should take 90 days.", ev).ok);
});

const SOURCES: PostSource[] = [
  { id: "S1", video_id: "OCTvideo001", title: "Treasury", published_at: "2026-10-05T10:00:00.000Z", summary: "Treasury reform.", excerpts: [], moments: [{ id: "S1.1", segment_id: "x", start_seconds: 125, excerpt: "reform the treasury" }] },
  { id: "S2", video_id: "OCTvideo002", title: "Hydra", published_at: "2026-10-20T10:00:00.000Z", summary: "Hydra.", excerpts: [], moments: [] },
];
const GOOD_EDIT = { revision: 3, title: "T", dek: null, body: { intro: [{ text: "Intro.", cites: ["S1"] }], sections: [{ heading: "H", paragraphs: [{ text: "P.", cites: ["S1.1", "S2"] }] }] } };

test("operator edits are validated strictly: rejected whole, never trimmed", () => {
  const ok = validateEdit({ ...GOOD_EDIT, _reference: { anything: true } }, SOURCES);
  assert.ok(ok.ok);
  const cases: [string, unknown, RegExp][] = [
    ["not an object", [], /JSON object/],
    ["missing revision", { ...GOOD_EDIT, revision: undefined }, /revision/],
    ["unknown top-level field", { ...GOOD_EDIT, extra: 1 }, /unknown field "extra"/],
    ["oversized paragraph", { ...GOOD_EDIT, body: { intro: [{ text: "x".repeat(LIMITS.paragraph + 1), cites: ["S1"] }], sections: [] } }, /exceeds the 1500 limit/],
    ["oversized title", { ...GOOD_EDIT, title: "t".repeat(LIMITS.title + 1) }, /title: 141 characters/],
    ["too many sections", { ...GOOD_EDIT, body: { intro: [], sections: Array.from({ length: LIMITS.sections + 1 }, () => GOOD_EDIT.body.sections[0]) } }, /sections exceeds/],
    ["too many intro paragraphs", { ...GOOD_EDIT, body: { intro: Array.from({ length: LIMITS.intro + 1 }, () => GOOD_EDIT.body.intro[0]), sections: [] } }, /intro: 5 paragraphs/],
    ["unknown cite", { ...GOOD_EDIT, body: { intro: [{ text: "Made up", cites: ["S9"] }], sections: [] } }, /S9 is not one of this post's sources/],
    ["malformed cite", { ...GOOD_EDIT, body: { intro: [{ text: "x", cites: ["<b>"] }], sections: [] } }, /not a source id/],
    ["no cites", { ...GOOD_EDIT, body: { intro: [{ text: "x", cites: [] }], sections: [] } }, /non-empty array/],
    ["empty paragraph text", { ...GOOD_EDIT, body: { intro: [{ text: "  ", cites: ["S1"] }], sections: [] } }, /must not be empty/],
    ["paragraph extra field", { ...GOOD_EDIT, body: { intro: [{ text: "x", cites: ["S1"], html: "<b>" }], sections: [] } }, /unknown field "html"/],
    ["line break", { ...GOOD_EDIT, title: "a\nb" }, /control characters/],
    ["empty section", { ...GOOD_EDIT, body: { intro: [], sections: [{ heading: "H", paragraphs: [] }] } }, /non-empty array/],
    ["empty body", { ...GOOD_EDIT, body: { intro: [], sections: [] } }, /no paragraphs/],
  ];
  for (const [name, raw, re] of cases) {
    const r = validateEdit(raw, SOURCES);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.ok(r.errors.some((e) => re.test(e)), `${name}: ${r.errors.join(" | ")}`);
  }
  // Several problems are all reported at once.
  const multi = validateEdit({ ...GOOD_EDIT, title: "", body: { intro: [{ text: "x", cites: ["S7"] }], sections: [{ heading: "", paragraphs: [{ text: "y", cites: [] }] }] } }, SOURCES);
  assert.ok(!multi.ok && multi.errors.length >= 4);
});

test("links: timestamps only from real timings; ids validated; text escaped", () => {
  assert.deepEqual(resolveCite("S1.1", SOURCES, "https://x.test"), {
    id: "S1.1",
    label: "1 · 2:05",
    href: "https://x.test/video/OCTvideo001?t=125",
    youtube: "https://www.youtube.com/watch?v=OCTvideo001&t=125s",
    title: "Treasury",
  });
  assert.equal(resolveCite("S2", SOURCES)?.href, "/video/OCTvideo002");
  assert.equal(resolveCite("S2.1", SOURCES), null, "no moment, no timestamp link");
  assert.equal(resolveCite("S3", SOURCES), null);
  const badId = [{ ...SOURCES[0], video_id: "javascript:alert(1)" }];
  assert.equal(resolveCite("S1", badId), null);
  const badTime = [{ ...SOURCES[0], moments: [{ ...SOURCES[0].moments[0], start_seconds: -5 }] }];
  assert.equal(resolveCite("S1.1", badTime), null);
  assert.equal(youtubeHref("OCTvideo001"), "https://www.youtube.com/watch?v=OCTvideo001");
  assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  const html = postFeedHtml(
    {
      id: "1", period: "2026-10", slug: "2026-10", title: "<t>", dek: "<d>", published_at: null, sources: SOURCES,
      coverage: { timezone: "UTC", period_start: "", period_end: "", videos_in_period: 2, videos_covered: 2, missing: [], sampled: [], complete: true },
      body: { intro: [{ text: "<script>alert(1)</script>", cites: ["S1.1"] }], sections: [{ heading: "<h>", paragraphs: [{ text: "ok", cites: ["S2"] }] }] },
    },
    "https://x.test"
  );
  assert.ok(!/<script>|<t>|<h>|<d>/.test(html));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/x\.test\/video\/OCTvideo001\?t=125"/);
  assert.match(html, /Covers all 2 videos published in October 2026 \(UTC\)/);
});
