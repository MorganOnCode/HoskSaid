/**
 * Monthly schedule and operator CLI, executed for real: the compose service's
 * command and environment, disabled/missing configuration, due/missed/catch-up
 * months over simulated time, reruns, and the draft -> review -> publish flow
 * through the CLI. The model is a fake; no provider is called.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { SKIP_DB, createTestDb, seedVideo, type TestDb } from "./helpers/db";
import { fakeDraftModel } from "./helpers/fake-draft-model";
import type { ScheduleConfig } from "../src/lib/digest/schedule";

const COMPOSE = "docker-compose.prod.yml";

function composeService(): { command: string[]; environment: Record<string, string>; profiles: string[]; restart: string } | null {
  const env = { ...process.env, POSTGRES_PASSWORD: "x", OPENAI_API_KEY: "x", YOUTUBE_API_KEY: "x", CRON_SECRET: "x" };
  try {
    const withProfile = JSON.parse(
      execFileSync("docker", ["compose", "-f", COMPOSE, "--env-file", "/dev/null", "--profile", "monthly-drafts", "config", "--format", "json"], { env, stdio: ["ignore", "pipe", "ignore"] }).toString()
    );
    return withProfile.services["monthly-drafts"];
  } catch {
    return null;
  }
}

function hasDockerCompose(): boolean {
  return spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
}

describe("compose scheduler artifact", { skip: hasDockerCompose() ? false : "docker compose not available" }, () => {
  test("is opt-in: excluded from the default stack, disabled by default, draft-only command", () => {
    const env = { ...process.env, POSTGRES_PASSWORD: "x", OPENAI_API_KEY: "x", YOUTUBE_API_KEY: "x", CRON_SECRET: "x" };
    const def = JSON.parse(execFileSync("docker", ["compose", "-f", COMPOSE, "--env-file", "/dev/null", "config", "--format", "json"], { env }).toString());
    assert.ok(!("monthly-drafts" in def.services), "not started by a plain `up`");
    const svc = composeService();
    assert.ok(svc);
    assert.deepEqual(svc!.profiles, ["monthly-drafts"]);
    assert.deepEqual(svc!.command, ["npx", "tsx", "src/cli/hosk.ts", "posts", "schedule", "run"]);
    assert.equal(svc!.environment.MONTHLY_DRAFTS_SCHEDULE_ENABLED, "false");
    assert.equal(svc!.environment.MONTHLY_DRAFT_TIMEZONE, "UTC");
    assert.equal(svc!.environment.MONTHLY_DRAFT_CALL_BUDGET, "", "no invented budget");
    assert.equal(svc!.restart, "on-failure:3");
    assert.deepEqual(
      Object.keys(svc!.environment).filter((k) => /SMTP|EMAIL|MAIL|NEWSLETTER|PUBLISH/i.test(k)),
      [],
      "the service is given no mail, newsletter or publishing configuration"
    );
  });
});

describe("monthly schedule", { skip: SKIP_DB }, () => {
  let db: TestDb;
  let schedule: typeof import("../src/lib/digest/schedule");
  let posts: typeof import("../src/lib/posts");
  let monthly: typeof import("../src/lib/digest/monthly");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "hosk-monthly-"));

  const CFG: ScheduleConfig = { enabled: true, timezone: "UTC", timezoneSource: "default", day: 1, hour: 6, catchupMonths: 2, recheckHours: 24, checkMinutes: 60 };

  /** Run the real CLI entry point exactly as the compose service does (minus npx). */
  function cli(args: string[], env: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli/hosk.ts", ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: db.url, PUBLIC_BASE_URL: "https://example.test", ...env } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  before(async () => {
    db = await createTestDb();
    for (const [id, when, summary] of [
      ["SEPvideo001", "2026-09-10T10:00:00Z", "• Charles discussed September governance votes."],
      ["OCTvideo001", "2026-10-05T10:00:00Z", "• Charles argued for treasury reform and community funding."],
      ["OCTvideo002", "2026-10-20T10:00:00Z", "• Hydra heads are processing transactions in tests."],
      ["NOVvideo001", "2026-11-03T10:00:00Z", "• November talk on Midnight privacy."],
    ]) {
      await seedVideo(db.sql, { youtube_id: id, title: `Talk ${id}`, published_at: when, summary, chunks: [{ content: `${summary.slice(2)} More detail follows here.`, start: 61 }] });
    }
    schedule = await import("../src/lib/digest/schedule");
    posts = await import("../src/lib/posts");
    monthly = await import("../src/lib/digest/monthly");
  });
  after(async () => db?.drop());
  beforeEach(async () => {
    await db.sql`DELETE FROM posts`;
    await db.sql`DELETE FROM post_video_notes`;
    await db.sql`DELETE FROM post_generation_runs`;
    await db.sql`DELETE FROM post_generation_budget`;
  });

  test("ticks over simulated time: not yet due, due, rerun, recheck, missed run and catch-up", async () => {
    const model = fakeDraftModel();
    const tick = (now: string, cfg: Partial<ScheduleConfig> = {}) =>
      schedule.runScheduleTick({ now: new Date(now), config: { ...CFG, ...cfg }, model, callBudget: 50 });

    // Oct 31 (catch-up 1): September, scheduled Oct 1 06:00, is due.
    const early = await tick("2026-10-31T12:00:00Z", { catchupMonths: 1 });
    assert.deepEqual(early.map((e) => e.period), ["2026-09"]);
    assert.equal(early[0].outcome, "created");

    // Nov 1 05:59: October is not due yet.
    const before = await tick("2026-11-01T05:59:00Z", { catchupMonths: 1 });
    assert.deepEqual(before, []);
    assert.equal(await posts.getPostByPeriod("2026-10"), null);

    // Nov 1 06:00: October is due and drafted; September was checked < 24h ago.
    const calls0 = model.calls.length;
    const due = await tick("2026-11-01T06:00:00Z");
    assert.deepEqual(due.map((e) => [e.period, e.action, e.outcome ?? ""]), [["2026-09", "skipped_recent", ""], ["2026-10", "generated", "created"]]);
    assert.equal(model.calls.length - calls0, 3, "2 notes + 1 final");
    assert.equal((await posts.getPostByPeriod("2026-10"))?.status, "draft", "the schedule never publishes");

    // An hour later: both recently checked, nothing runs.
    const rerun = await tick("2026-11-01T07:00:00Z");
    assert.ok(rerun.every((e) => e.action === "skipped_recent"));
    // A day later: rechecked, unchanged, no model call.
    const calls1 = model.calls.length;
    const recheck = await tick("2026-11-02T07:00:00Z");
    assert.deepEqual(recheck.map((e) => e.outcome), ["unchanged", "unchanged"]);
    assert.equal(model.calls.length, calls1);

    // Late ingestion after the run: the draft picks it up on the next recheck.
    await seedVideo(db.sql, { youtube_id: "OCTlate0001", title: "Late", published_at: "2026-10-30T10:00:00Z", summary: "• Late October talk on staking.", chunks: [{ content: "Late October talk on staking and delegation.", start: 5 }] });
    const late = await tick("2026-11-03T08:00:00Z");
    assert.equal(late.find((e) => e.period === "2026-10")?.outcome, "updated");
    assert.equal((await posts.getPostByPeriod("2026-10"))?.revision, 2);
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM posts WHERE period = '2026-10'`)[0].n, 1);

    // After publication, scheduled runs keep the post.
    const p = (await posts.getPostByPeriod("2026-10"))!;
    await posts.publishPost("2026-10", { by: "firstmate", revision: p.revision });
    const afterPub = await tick("2026-11-05T08:00:00Z");
    assert.equal(afterPub.find((e) => e.period === "2026-10")?.outcome, "kept");
    await db.sql`DELETE FROM videos WHERE youtube_id = 'OCTlate0001'`;
  });

  test("missed runs are caught up when the scheduler next starts", async () => {
    const model = fakeDraftModel();
    // Down from Oct 1 to Nov 20: both September and October are still drafted.
    const r = await schedule.runScheduleTick({ now: new Date("2026-11-20T09:00:00Z"), config: CFG, model, callBudget: 50 });
    assert.deepEqual(r.map((e) => [e.period, e.outcome]), [["2026-09", "created"], ["2026-10", "created"]]);
    // Outside the catch-up window, older months are left alone.
    const r2 = await schedule.runScheduleTick({ now: new Date("2027-02-10T09:00:00Z"), config: CFG, model, callBudget: 50 });
    assert.deepEqual(r2.map((e) => e.period), ["2026-12", "2027-01"]);
    assert.ok(r2.every((e) => e.outcome === "insufficient_content"), "empty months produce no draft");
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM posts`)[0].n, 2);
    // Every attempt is recorded with its trigger.
    const runs = await db.sql`SELECT period, trigger, outcome FROM post_generation_runs ORDER BY id`;
    assert.ok(runs.every((x) => x.trigger === "schedule"));
  });

  test("budget is explicit and bounded across scheduled reruns", async () => {
    const model = fakeDraftModel();
    const r = await schedule.runScheduleTick({ now: new Date("2026-11-01T06:00:00Z"), config: { ...CFG, catchupMonths: 1 }, model, callBudget: 2 });
    assert.equal(r[0].outcome, "over_budget");
    assert.equal(model.calls.length, 0);
    await assert.rejects(schedule.runScheduleTick({ now: new Date("2026-11-03T06:00:00Z"), config: CFG }), /explicit call budget/);
  });

  test("executed command: disabled is a no-op, missing config is explicit, dry run shows due months", () => {
    const disabled = cli(["posts", "schedule", "run"], { MONTHLY_DRAFTS_SCHEDULE_ENABLED: "false" });
    assert.equal(disabled.code, 0);
    assert.match(disabled.out, /schedule: disabled \(no-op\)/);

    const secret = "sk-test-DO-NOT-PRINT";
    const missing = cli(["posts", "schedule", "run"], { MONTHLY_DRAFTS_SCHEDULE_ENABLED: "true", OPENAI_API_KEY: secret });
    assert.equal(missing.code, 78);
    assert.match(missing.out, /MONTHLY_DRAFT_CALL_BUDGET is not set/);
    assert.ok(!missing.out.includes(secret) && !missing.err.includes(secret));

    const badTz = cli(["posts", "schedule", "run"], { MONTHLY_DRAFTS_SCHEDULE_ENABLED: "true", MONTHLY_DRAFT_TIMEZONE: "Nowhere/Land" });
    assert.equal(badTz.code, 78);
    assert.match(badTz.out, /MONTHLY_DRAFT_TIMEZONE/);

    const dry = cli(["posts", "schedule", "run", "--once", "--dry-run", "--now", "2026-11-01T06:00:00Z"], { MONTHLY_DRAFT_TIMEZONE: "UTC" });
    assert.equal(dry.code, 0, dry.out + dry.err);
    assert.match(dry.out, /2026-09,dry_run/);
    assert.match(dry.out, /2026-10,dry_run/);
    assert.match(dry.out, /next_run: "?2026-12-01T06:00:00.000Z/);

    const bangkok = cli(["posts", "schedule", "run", "--once", "--dry-run", "--now", "2026-10-31T23:30:00Z"], { MONTHLY_DRAFT_TIMEZONE: "Asia/Bangkok", MONTHLY_SCHEDULE_CATCHUP_MONTHS: "1" });
    assert.match(bangkok.out, /2026-10,dry_run/);

    const status = cli(["posts", "schedule", "status"]);
    assert.equal(status.code, 0);
    assert.match(status.out, /enabled: false/);
    assert.match(status.out, /UTC \(development default/);
    assert.match(status.out, /missing: OPENAI_API_KEY, MONTHLY_DRAFT_CALL_BUDGET/);

    const usage = cli(["posts", "schedule", "run", "--now", "2026-11-01T00:00:00Z"], { MONTHLY_DRAFTS_SCHEDULE_ENABLED: "true" });
    assert.equal(usage.code, 2, "--now is only for dry runs");
    const unknown = cli(["posts", "schedule", "run", "--publish"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.out, /unknown flag --publish/);
  });

  test("operator CLI: dry run, private review, revision-pinned publish, withdraw", async () => {
    const dry = cli(["posts", "generate", "--month", "2026-10", "--dry-run"]);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /videos_in_period: 2/);
    assert.match(dry.out, /MONTHLY_DRAFT_CALL_BUDGET not set/);
    const noBudget = cli(["posts", "generate", "--month", "2026-10"]);
    assert.equal(noBudget.code, 78);
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM posts`)[0].n, 0);

    // Draft with the fake model (the CLI itself only wires the real provider).
    const g = await monthly.generateMonthlyDraft({ period: "2026-10", timezone: "UTC", model: fakeDraftModel(), callBudget: 20, now: new Date("2026-11-02T00:00:00Z") });
    assert.equal(g.status, "created");

    const list = cli(["posts"]);
    assert.match(list.out, /2026-10,draft,1,2\/2/);
    const show = cli(["posts", "show", "2026-10"]);
    assert.match(show.out, /revision: 1/);
    assert.match(show.out, /publish 2026-10 --by <operator> --revision 1/);

    const review = path.join(tmp, "review.html");
    assert.equal(cli(["posts", "preview", "2026-10", "--format", "html", "--out", review]).code, 0);
    const html = readFileSync(review, "utf8");
    assert.match(html, /PRIVATE REVIEW/);
    assert.match(html, /Covers all 2 videos published in October 2026/);
    assert.match(html, /evidence/);

    const json = path.join(tmp, "draft.json");
    assert.equal(cli(["posts", "preview", "2026-10", "--format", "json", "--out", json]).code, 0);
    const draft = JSON.parse(readFileSync(json, "utf8"));
    assert.equal(draft.revision, 1);
    assert.ok(draft.sources.length > 0, "the private preview carries the source evidence");

    for (const sub of ["export", "import"]) assert.equal(cli(["posts", sub, "2026-10"]).code, 2, `posts ${sub} is not a command`);

    assert.equal(cli(["posts", "publish", "2026-10", "--by", "firstmate"]).code, 2, "--revision is required");
    const stale = cli(["posts", "publish", "2026-10", "--by", "firstmate", "--revision", "2"]);
    assert.equal(stale.code, 1);
    assert.match(stale.out, /revision 1, not 2/);
    const pub = cli(["posts", "publish", "2026-10", "--by", "firstmate", "--revision", "1"]);
    assert.equal(pub.code, 0, pub.out);
    assert.match(pub.out, /url: "?https:\/\/example\.test\/blog\/2026-10/);
    assert.match(cli(["posts", "publish", "2026-10", "--by", "firstmate", "--revision", "1"]).out, /already published \(no-op\)/);
    assert.equal((await posts.getPublishedPost("2026-10"))?.title, draft.title);

    const wd = cli(["posts", "withdraw", "2026-10", "--by", "firstmate"]);
    assert.equal(wd.code, 0);
    assert.equal(await posts.getPublishedPost("2026-10"), null);
    assert.match(cli(["posts", "withdraw", "2026-10", "--by", "firstmate"]).out, /already withdrawn/);
    const events = cli(["posts", "show", "2026-10"]).out;
    assert.match(events, /published,firstmate,1/);
    assert.match(events, /withdrawn,firstmate,1/);
  });
});
