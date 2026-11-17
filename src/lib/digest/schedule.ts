/**
 * Opt-in schedule for monthly drafts (server-only).
 *
 * The `monthly-drafts` compose service runs `posts schedule run`, which checks
 * every MONTHLY_SCHEDULE_CHECK_MINUTES whether a closed month is due. A month
 * is due once its scheduled time has passed: day MONTHLY_SCHEDULE_DAY of the
 * following month at MONTHLY_SCHEDULE_HOUR, local to MONTHLY_DRAFT_TIMEZONE.
 * The last MONTHLY_SCHEDULE_CATCHUP_MONTHS closed months are considered, so a
 * scheduler that was down on the day catches up when it next runs. A month
 * checked within MONTHLY_SCHEDULE_RECHECK_HOURS is skipped; otherwise the
 * generator runs again, which is a no-op for unchanged, published or withdrawn
 * posts and picks up late-ingested videos in a draft.
 *
 * Disabled unless MONTHLY_DRAFTS_SCHEDULE_ENABLED=true. It only drafts: it
 * never publishes and never sends email.
 */
import { sql } from "../db";
import { addMonths, monthOf, monthlyTimezone, parseMonth, zonedInstant } from "./period";
import { generateMonthlyDraft, type MonthlyResult } from "./monthly";
import type { DraftLimits, DraftModel } from "./model";

export interface ScheduleConfig {
  enabled: boolean;
  timezone: string;
  timezoneSource: "env" | "default";
  day: number;
  hour: number;
  catchupMonths: number;
  recheckHours: number;
  checkMinutes: number;
}

export type ScheduleConfigResult = { ok: true; config: ScheduleConfig } | { ok: false; invalid: string[] };

function intEnv(env: Record<string, string | undefined>, name: string, def: number, min: number, max: number, invalid: string[]): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    invalid.push(`${name} (integer ${min}-${max})`);
    return def;
  }
  return Number(raw);
}

export function scheduleConfig(env: Record<string, string | undefined> = process.env): ScheduleConfigResult {
  const invalid: string[] = [];
  const flag = env.MONTHLY_DRAFTS_SCHEDULE_ENABLED?.trim().toLowerCase();
  if (flag && !["true", "false"].includes(flag)) invalid.push("MONTHLY_DRAFTS_SCHEDULE_ENABLED (true or false)");
  let tz: { timezone: string; source: "env" | "default" } = { timezone: "UTC", source: "default" };
  try {
    tz = monthlyTimezone(env);
  } catch {
    invalid.push("MONTHLY_DRAFT_TIMEZONE (IANA zone such as UTC or Asia/Bangkok)");
  }
  const config: ScheduleConfig = {
    enabled: flag === "true",
    timezone: tz.timezone,
    timezoneSource: tz.source,
    // Day 1-28 so the scheduled day exists in every month.
    day: intEnv(env, "MONTHLY_SCHEDULE_DAY", 1, 1, 28, invalid),
    hour: intEnv(env, "MONTHLY_SCHEDULE_HOUR", 6, 0, 23, invalid),
    catchupMonths: intEnv(env, "MONTHLY_SCHEDULE_CATCHUP_MONTHS", 2, 1, 12, invalid),
    recheckHours: intEnv(env, "MONTHLY_SCHEDULE_RECHECK_HOURS", 24, 1, 720, invalid),
    checkMinutes: intEnv(env, "MONTHLY_SCHEDULE_CHECK_MINUTES", 60, 5, 1440, invalid),
  };
  return invalid.length ? { ok: false, invalid } : { ok: true, config };
}

/** When `period` becomes due: day/hour of the following month, local time. */
export function scheduledAt(period: string, cfg: Pick<ScheduleConfig, "timezone" | "day" | "hour">): Date {
  const { y, m } = parseMonth(addMonths(period, 1));
  return zonedInstant(y, m, cfg.day, cfg.hour, 0, cfg.timezone);
}

/** Closed months within the catch-up window whose scheduled time has passed, oldest first. */
export function duePeriods(now: Date, cfg: Pick<ScheduleConfig, "timezone" | "day" | "hour" | "catchupMonths">): string[] {
  const current = monthOf(now, cfg.timezone);
  const out: string[] = [];
  for (let k = cfg.catchupMonths; k >= 1; k--) {
    const p = addMonths(current, -k);
    if (now >= scheduledAt(p, cfg)) out.push(p);
  }
  return out;
}

/** The next scheduled time strictly after `now`. */
export function nextScheduledAt(now: Date, cfg: Pick<ScheduleConfig, "timezone" | "day" | "hour">): { period: string; at: Date } {
  const prev = addMonths(monthOf(now, cfg.timezone), -1);
  for (const p of [prev, addMonths(prev, 1)]) {
    const at = scheduledAt(p, cfg);
    if (at > now) return { period: p, at };
  }
  const p = addMonths(prev, 2);
  return { period: p, at: scheduledAt(p, cfg) };
}

export interface TickEntry {
  period: string;
  action: "generated" | "skipped_recent" | "dry_run";
  outcome?: MonthlyResult["status"];
  detail?: string;
  last_checked?: string;
}

async function lastScheduledCheck(period: string): Promise<Date | null> {
  const [row] = await sql<{ at: Date | null }[]>`
    SELECT max(started_at) AS at FROM post_generation_runs
    WHERE kind = 'monthly' AND period = ${period} AND trigger = 'schedule' AND outcome IS DISTINCT FROM 'busy'
  `;
  return row?.at ? new Date(row.at) : null;
}

function summarise(r: MonthlyResult): string {
  switch (r.status) {
    case "created":
    case "updated":
      return `draft revision ${r.post.revision}, ${r.calls} call(s), ${r.post.coverage.complete ? "complete" : `INCOMPLETE: ${r.post.coverage.missing.length} video(s) missing`}`;
    case "kept":
      return `${r.reason}${r.new_videos.length ? `; ${r.new_videos.length} video(s) published since are not in it` : ""}`;
    case "unchanged":
      return `inputs unchanged (revision ${r.post.revision}${r.calls ? `, ${r.calls} retry call(s)` : ""})`;
    case "dry_run":
      return "dry run";
    default:
      return r.reason;
  }
}

/**
 * One scheduler pass. `dryRun` reports what would run without generating or
 * recording anything. Generation results (including refusals) are recorded in
 * post_generation_runs by the generator itself.
 */
export async function runScheduleTick(opts: {
  now: Date;
  config: ScheduleConfig;
  model?: DraftModel;
  callBudget?: number;
  limits?: Partial<DraftLimits>;
  dryRun?: boolean;
}): Promise<TickEntry[]> {
  const out: TickEntry[] = [];
  for (const period of duePeriods(opts.now, opts.config)) {
    const last = await lastScheduledCheck(period);
    if (last && opts.now.getTime() - last.getTime() < opts.config.recheckHours * 3600_000) {
      out.push({ period, action: "skipped_recent", last_checked: last.toISOString() });
      continue;
    }
    if (opts.dryRun) {
      out.push({ period, action: "dry_run", ...(last ? { last_checked: last.toISOString() } : {}) });
      continue;
    }
    if (!opts.model || !opts.callBudget) throw new Error("schedule run needs a model and an explicit call budget");
    const r = await generateMonthlyDraft({
      period,
      timezone: opts.config.timezone,
      model: opts.model,
      callBudget: opts.callBudget,
      limits: opts.limits,
      now: opts.now,
      trigger: "schedule",
    });
    out.push({ period, action: "generated", outcome: r.status, detail: summarise(r) });
  }
  return out;
}

export async function recentRuns(limit = 10): Promise<{ period: string; trigger: string; started_at: string; outcome: string | null; calls: number }[]> {
  return await sql`
    SELECT period, trigger, started_at, outcome, calls FROM post_generation_runs
    WHERE kind = 'monthly' ORDER BY started_at DESC, id DESC LIMIT ${limit}
  `;
}
