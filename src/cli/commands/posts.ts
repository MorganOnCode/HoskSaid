import { writeFileSync } from "node:fs";
import { parseArgs, UsageError } from "../args";
import { CliError, emit, emitHelp, RUN, type Command } from "../runtime";
import {
  OPERATOR_RE,
  getPostByPeriod,
  listPosts,
  paragraphCount,
  postEvents,
  publishPost,
  withdrawPost,
  type Post,
  type PostStatus,
} from "../../lib/posts";
import { generateMonthlyDraft, type MonthlyResult } from "../../lib/digest/monthly";
import { monthlyModelConfig, openAIDraftModel, type DraftModel } from "../../lib/digest/model";
import { assertTimezone, isMonth, monthlyTimezone, previousMonth } from "../../lib/digest/period";
import { nextScheduledAt, recentRuns, runScheduleTick, scheduleConfig, duePeriods, type ScheduleConfig } from "../../lib/digest/schedule";
import { coverageSentence, missingReason, postReviewHtml, postText } from "../../lib/render/post";

const BASE = () => process.env.PUBLIC_BASE_URL || "https://thehosksaid.com";
const P = `${RUN} posts`;
/** Exit code for configuration errors (EX_CONFIG), so a supervisor can tell them apart. */
export const EXIT_CONFIG = 78;

const USAGE: Record<string, string> = {
  list: `${P} [list] [--status draft|published|withdrawn]`,
  show: `${P} show <YYYY-MM> [--full]`,
  generate: `${P} generate --month <YYYY-MM|previous> [--timezone <IANA>] [--min-videos <n>] [--dry-run]
  Drafts one closed month from Charles's published videos (never visitor questions).
  Needs OPENAI_API_KEY and MONTHLY_DRAFT_CALL_BUDGET unless --dry-run. Never publishes.
  Re-running replaces only a draft (never a published or withdrawn post); timezone defaults to MONTHLY_DRAFT_TIMEZONE, else UTC.
  examples:
    ${P} generate --month previous --dry-run
    ${P} generate --month 2026-10 --timezone UTC`,
  preview: `${P} preview <YYYY-MM> [--format text|html|json] [--out <file>]
  text: reading copy. html: private review page with cited evidence, coverage and rejected statements.`,
  publish: `${P} publish <YYYY-MM> --by <operator> --revision <n> [--accept-incomplete]
  Publishes exactly the reviewed revision. An incomplete month needs --accept-incomplete.`,
  withdraw: `${P} withdraw <YYYY-MM> --by <operator>   (unpublish; the post is kept)`,
  schedule: `${P} schedule status
${P} schedule run [--once] [--dry-run [--now <ISO instant>]]
  Drafts closed months when due (MONTHLY_SCHEDULE_DAY/HOUR in MONTHLY_DRAFT_TIMEZONE).
  Runs only with MONTHLY_DRAFTS_SCHEDULE_ENABLED=true. Never publishes or emails.`,
};
const ALL_USAGE = Object.values(USAGE).join("\n");

const SPEC: Record<string, Record<string, "boolean" | "string">> = {
  list: { status: "string" },
  show: { full: "boolean" },
  generate: { month: "string", timezone: "string", "min-videos": "string", "dry-run": "boolean" },
  preview: { format: "string", out: "string" },
  publish: { by: "string", revision: "string", "accept-incomplete": "boolean" },
  withdraw: { by: "string" },
  schedule: { once: "boolean", "dry-run": "boolean", now: "string" },
};

function brief(p: Post) {
  return {
    period: p.period,
    status: p.status,
    revision: p.revision,
    title: p.title,
    coverage: `${p.coverage.videos_covered}/${p.coverage.videos_in_period} videos${p.coverage.complete ? " (complete)" : " (INCOMPLETE)"}`,
    paragraphs: paragraphCount(p.body),
    published: p.published_at ? `${p.published_by ?? "?"} ${new Date(p.published_at).toISOString()}` : "no",
  };
}

function requirePeriod(positionals: string[], usage: string): string {
  const period = positionals[1];
  if (!period) throw new UsageError("a period YYYY-MM is required", usage);
  if (!isMonth(period)) throw new UsageError(`period must be YYYY-MM, got ${period}`, usage);
  if (positionals.length > 2) throw new UsageError(`unexpected argument ${positionals[2]}`, usage);
  return period;
}

function requireBy(flags: Record<string, string | boolean>, usage: string): string {
  const by = typeof flags.by === "string" ? flags.by.trim() : "";
  if (!OPERATOR_RE.test(by)) throw new UsageError("--by <operator> is required: who is making this change (letters, digits, . _ @ - space; max 80)", usage);
  return by;
}

async function mustGet(period: string): Promise<Post> {
  const post = await getPostByPeriod(period);
  if (!post) throw new CliError(`no post for ${period}`, `Run \`${P} generate --month ${period} --dry-run\` to see its inputs`);
  return post;
}

function productionModel(): { model: DraftModel; budget: number } {
  const cfg = monthlyModelConfig();
  if (!cfg.ok) {
    const parts = [...cfg.missing.map((m) => `${m} is not set`), ...cfg.invalid.map((m) => `${m} is invalid`)];
    throw new CliError(
      `monthly draft generation is not configured: ${parts.join("; ")}`,
      "Set an explicit MONTHLY_DRAFT_CALL_BUDGET (model calls per month) and OPENAI_API_KEY in .env, or use --dry-run",
      EXIT_CONFIG
    );
  }
  return { model: openAIDraftModel(cfg.config.model), budget: cfg.config.callBudget };
}

/** Stand-in for dry runs: identifies the configured model, never called. */
function plannedModel(): DraftModel {
  return {
    provider: "openai",
    model: process.env.MONTHLY_DRAFT_MODEL?.trim() || "gpt-4o-mini",
    async complete() {
      throw new Error("dry run: no model calls");
    },
  };
}

function emitResult(r: MonthlyResult, period: string): number {
  switch (r.status) {
    case "dry_run": {
      const rep = r.report;
      emit({
        dry_run: true,
        period,
        window: `${rep.window.start} .. ${rep.window.end} (exclusive, ${rep.window.timezone})`,
        ingestion_cutoff: rep.ingestion_cutoff ?? "none",
        videos_in_period: rep.videos_in_period,
        eligible: rep.eligible.length ? rep.eligible : "0 videos with stored text",
        missing: rep.missing.length ? rep.missing.map((m) => ({ video_id: m.video_id, reason: m.reason })) : "none",
        plan: `${rep.plan.total_calls_max} calls max (notes ${rep.plan.notes_calls}, reduce ≤${rep.plan.reduce_calls_max}, final 1; ${rep.plan.cached_videos} cached), ≤~${rep.plan.max_input_tokens_est} input / ≤${rep.plan.max_output_tokens} output tokens`,
        feasible: rep.plan.feasible ? "yes" : `no: ${rep.plan.infeasible_reason}`,
        budget: rep.budget.limit === null ? `MONTHLY_DRAFT_CALL_BUDGET not set (${rep.budget.used} used)` : `${rep.budget.used}/${rep.budget.limit} used`,
      });
      return 0;
    }
    case "month_not_closed":
    case "busy":
      emit({ generate: `skipped (${r.status})`, period, reason: r.reason });
      return 0;
    case "insufficient_content":
    case "synthesis_failed":
      emit({ generate: r.status, period, reason: r.reason, calls: r.calls, missing: r.coverage.missing.length });
      return 1;
    case "over_budget":
      emit({ generate: "over_budget", period, reason: r.reason, budget: `${r.budget.used}/${r.budget.limit} used`, plan_calls: r.plan.total_calls_max });
      emitHelp([`Run \`${P} generate --month ${period} --dry-run\` to see the plan`, "Raise MONTHLY_DRAFT_CALL_BUDGET only with an approved budget"]);
      return 1;
    case "kept":
      emit({ generate: "kept (no-op)", period, reason: r.reason, new_videos_since: r.new_videos.length ? r.new_videos : "none", post: brief(r.post) });
      return 0;
    case "unchanged":
      emit({ generate: "unchanged (no-op): the existing draft already reflects these inputs", calls: r.calls, post: brief(r.post) });
      return 0;
    default:
      emit({
        generate: r.status,
        calls: r.calls,
        post: brief(r.post),
        coverage: coverageSentence(r.post.coverage, r.post.period),
        missing: r.post.coverage.missing.length ? r.post.coverage.missing.map((m) => `${m.video_id} ${missingReason(m.reason)}`) : "none",
        rejected_statements: r.post.generation.rejected_total,
      });
      emitHelp([
        `Run \`${P} preview ${period} --format html --out review-${period}.html\` to review with evidence`,
        `Run \`${P} publish ${period} --by <operator> --revision ${r.post.revision}\` once approved`,
      ]);
      return 0;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

async function scheduleCommand(positionals: string[], flags: Record<string, string | boolean>, usage: string): Promise<number> {
  const action = positionals[1];
  if (action !== "status" && action !== "run") throw new UsageError("posts schedule needs `status` or `run`", usage);
  if (positionals.length > 2) throw new UsageError(`unexpected argument ${positionals[2]}`, usage);
  const cfgR = scheduleConfig();
  if (!cfgR.ok) throw new CliError(`invalid schedule configuration: ${cfgR.invalid.join("; ")}`, "Fix the named variables in .env", EXIT_CONFIG);
  const cfg = cfgR.config;
  const describe = (c: ScheduleConfig) => ({
    enabled: c.enabled,
    timezone: `${c.timezone}${c.timezoneSource === "default" ? " (development default; set MONTHLY_DRAFT_TIMEZONE)" : ""}`,
    runs: `day ${c.day} of each month at ${String(c.hour).padStart(2, "0")}:00 local, for the previous month`,
    catchup_months: c.catchupMonths,
    recheck_hours: c.recheckHours,
    check_minutes: c.checkMinutes,
  });

  if (action === "status") {
    if (flags.once || flags["dry-run"] || flags.now) throw new UsageError("schedule status takes no flags", usage);
    const now = new Date();
    const next = nextScheduledAt(now, cfg);
    const model = monthlyModelConfig();
    emit({
      schedule: describe(cfg),
      next_run: `${next.at.toISOString()} for ${next.period}`,
      due_now: duePeriods(now, cfg).join(" ") || "none",
      generation_config: model.ok ? `ready (model ${model.config.model}, budget ${model.config.callBudget} calls/month)` : `missing: ${[...model.missing, ...model.invalid].join(", ")}`,
    });
    const runs = await recentRuns(10);
    emit({ recent_runs: runs.length ? runs.map((r) => ({ period: r.period, trigger: r.trigger, at: new Date(r.started_at).toISOString(), outcome: r.outcome ?? "running", calls: r.calls })) : "0 generation runs recorded" });
    if (!cfg.enabled) emitHelp(["Set MONTHLY_DRAFTS_SCHEDULE_ENABLED=true and start the `monthly-drafts` compose profile to activate"]);
    return 0;
  }

  const dryRun = !!flags["dry-run"];
  if (flags.now && !dryRun) throw new UsageError("--now is only allowed with --dry-run", usage);
  let fixedNow: Date | undefined;
  if (typeof flags.now === "string") {
    fixedNow = new Date(flags.now);
    if (Number.isNaN(fixedNow.getTime())) throw new UsageError(`--now must be an ISO instant, got ${flags.now}`, usage);
  }
  if (!cfg.enabled && !dryRun) {
    emit({ schedule: "disabled (no-op)", reason: "MONTHLY_DRAFTS_SCHEDULE_ENABLED is not true", config: describe(cfg) });
    return 0;
  }
  const prod = dryRun ? null : productionModel();
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    emit({ schedule: dryRun ? "dry run" : "started", config: describe(cfg) });
    for (;;) {
      const now = fixedNow ?? new Date();
      try {
        const entries = await runScheduleTick({ now, config: cfg, model: prod?.model, callBudget: prod?.budget, dryRun });
        emit({ tick: now.toISOString(), due: entries.length ? entries : "0 months due", next_run: nextScheduledAt(now, cfg).at.toISOString() });
      } catch (e) {
        const msg = e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "unknown error";
        emit({ tick: now.toISOString(), error: msg });
        if (flags.once || dryRun) return 1;
      }
      if (flags.once || dryRun || stop.signal.aborted) return 0;
      await sleep(cfg.checkMinutes * 60_000, stop.signal);
      if (stop.signal.aborted) {
        emit({ schedule: "stopped" });
        return 0;
      }
    }
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

export const postsCommand: Command = {
  name: "posts",
  summary: "Monthly blog drafts: generate, review, publish/withdraw (explicit only), schedule",
  usage: ALL_USAGE,
  async run(argv) {
    const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "list";
    if (!SPEC[sub]) throw new UsageError(`unknown posts subcommand ${sub}`, ALL_USAGE);
    const usage = USAGE[sub];
    const { positionals, flags } = parseArgs(sub === argv[0] ? argv : ["list", ...argv], SPEC[sub], usage);
    if (flags.help) {
      emit({ usage });
      return 0;
    }

    switch (sub) {
      case "list": {
        if (positionals.length > 1) throw new UsageError(`unexpected argument ${positionals[1]}`, usage);
        const status = flags.status as PostStatus | undefined;
        if (status && !["draft", "published", "withdrawn"].includes(status)) throw new UsageError("--status must be draft, published or withdrawn", usage);
        const posts = await listPosts(status);
        if (!posts.length) {
          emit({ posts: `0 ${status ? `${status} ` : ""}posts found` });
          emitHelp([`Run \`${P} generate --month previous --dry-run\` to see what last month's draft would use`]);
          return 0;
        }
        emit({
          count: posts.length,
          posts: posts.map((p) => ({ period: p.period, status: p.status, revision: p.revision, coverage: `${p.coverage.videos_covered}/${p.coverage.videos_in_period}${p.coverage.complete ? "" : " incomplete"}` })),
        });
        emitHelp([`Run \`${P} show <YYYY-MM>\` for details`, `Run \`${P} preview <YYYY-MM> --format html --out <file>\` to review a draft`]);
        return 0;
      }
      case "show": {
        const post = await mustGet(requirePeriod(positionals, usage));
        const text = postText(post, BASE());
        const limit = 1200;
        const g = post.generation;
        emit({
          post: {
            ...brief(post),
            dek: post.dek,
            generation: `${g.model} (${g.trigger}) at ${g.generated_at}, prompt ${g.prompt_version}, cutoff ${g.ingestion_cutoff ?? "n/a"}`,
            calls: `notes ${g.calls.notes}, reduce ${g.calls.reduce}, final ${g.calls.final}, cached ${g.calls.cached_videos}`,
            window: `${post.coverage.period_start} .. ${post.coverage.period_end} (${post.coverage.timezone})`,
            missing: post.coverage.missing.length ? post.coverage.missing.map((m) => `${m.video_id} ${missingReason(m.reason)}`) : "none",
            sampled_transcripts: post.coverage.sampled.length,
            rejected_statements: g.rejected_total,
            body: flags.full || text.length <= limit ? text : `${text.slice(0, limit)}… (truncated, ${text.length} chars total)`,
          },
        });
        const events = await postEvents(post.id);
        emit({ events: events.map((ev) => ({ action: ev.action, actor: ev.actor, revision: ev.revision, at: new Date(ev.at).toISOString() })) });
        const help: string[] = [];
        if (!flags.full && text.length > limit) help.push(`Run \`${P} show ${post.period} --full\` for the whole text`);
        if (post.status !== "published") help.push(`Run \`${P} publish ${post.period} --by <operator> --revision ${post.revision}${post.coverage.complete ? "" : " --accept-incomplete"}\` after review`);
        emitHelp(help);
        return 0;
      }
      case "generate": {
        if (positionals.length > 1) throw new UsageError(`unexpected argument ${positionals[1]}`, usage);
        const month = typeof flags.month === "string" ? flags.month : "";
        if (!month) throw new UsageError("--month <YYYY-MM|previous> is required", usage);
        let tz: string;
        try {
          tz = typeof flags.timezone === "string" ? flags.timezone : monthlyTimezone().timezone;
          assertTimezone(tz);
        } catch (e) {
          throw new UsageError(e instanceof Error ? e.message : "invalid timezone", usage);
        }
        const period = month === "previous" ? previousMonth(new Date(), tz) : month;
        if (!isMonth(period)) throw new UsageError(`--month must be YYYY-MM or previous, got ${month}`, usage);
        const minVideos = flags["min-videos"] === undefined ? 1 : Number(flags["min-videos"]);
        if (!Number.isInteger(minVideos) || minVideos < 1) throw new UsageError("--min-videos must be a positive integer", usage);
        const dryRun = !!flags["dry-run"];
        const prod = dryRun ? null : productionModel();
        const budgetCfg = monthlyModelConfig();
        const r = await generateMonthlyDraft({
          period,
          timezone: tz,
          model: prod?.model ?? plannedModel(),
          callBudget: prod?.budget ?? (budgetCfg.ok ? budgetCfg.config.callBudget : undefined),
          minVideos,
          dryRun,
          trigger: "cli",
        });
        return emitResult(r, period);
      }
      case "preview": {
        const post = await mustGet(requirePeriod(positionals, usage));
        const format = (flags.format as string | undefined) ?? "text";
        let out: string;
        if (format === "text") out = postText(post, BASE());
        else if (format === "html") out = postReviewHtml(post, BASE());
        else if (format === "json") out = JSON.stringify(post, null, 2);
        else throw new UsageError("--format must be text, html or json", usage);
        if (typeof flags.out === "string") {
          writeFileSync(flags.out, out);
          emit({ preview: `wrote ${format} to ${flags.out}`, status: post.status, revision: post.revision });
        } else {
          process.stdout.write(out + "\n");
        }
        return 0;
      }
      case "publish": {
        const period = requirePeriod(positionals, usage);
        const by = requireBy(flags, usage);
        const revision = Number(flags.revision);
        if (typeof flags.revision !== "string" || !Number.isInteger(revision) || revision < 1) {
          throw new UsageError("--revision <n> is required: the revision you reviewed (see `posts show`)", usage);
        }
        const r = await publishPost(period, { by, revision, acceptIncomplete: !!flags["accept-incomplete"] });
        if (r.changed) {
          emit({ publish: "done", post: brief(r.post), url: `${BASE()}/blog/${r.post.slug}` });
          return 0;
        }
        if (!r.post) throw new CliError(`no post for ${period}`);
        if (r.reason === "already_published") {
          emit({ publish: "already published (no-op)", post: brief(r.post) });
          return 0;
        }
        if (r.reason === "revision_mismatch") throw new CliError(`post is at revision ${r.post.revision}, not ${revision}; review the current draft first`, `Run \`${P} show ${period}\``);
        if (r.reason === "incomplete") {
          throw new CliError(`${period} is incomplete: ${coverageSentence(r.post.coverage, period)}`, `Review the missing videos, then re-run with --accept-incomplete if publishing anyway`);
        }
        throw new CliError(`cannot publish a post with status ${r.post.status}`);
      }
      case "withdraw": {
        const period = requirePeriod(positionals, usage);
        const by = requireBy(flags, usage);
        const r = await withdrawPost(period, by);
        if (r.changed) {
          emit({ withdraw: "done", post: brief(r.post) });
          return 0;
        }
        if (!r.post) throw new CliError(`no post for ${period}`);
        if (r.reason === "already_withdrawn") {
          emit({ withdraw: "already withdrawn (no-op)", post: brief(r.post) });
          return 0;
        }
        throw new CliError(`only published posts can be withdrawn (status: ${r.post.status})`);
      }
      case "schedule":
        return await scheduleCommand(positionals, flags, usage);
    }
    return 0;
  },
};
