/**
 * Calendar months in an IANA timezone (pure, client-safe).
 *
 * A month is the half-open interval [local midnight on the 1st, local midnight
 * on the 1st of the next month), keyed `YYYY-MM`. Local wall times are turned
 * into instants with the runtime's tz database; tests cross-check the result
 * against Postgres `AT TIME ZONE` across DST changes, leap years and year
 * rollover. UTC is the development default until the production zone is
 * confirmed; it is always reported explicitly, never assumed silently.
 */
export const DEFAULT_MONTHLY_TIMEZONE = "UTC";

export function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`unknown timezone: ${tz}`);
  }
}

/** Configured zone and whether it came from the default. */
export function monthlyTimezone(env: Record<string, string | undefined> = process.env): { timezone: string; source: "env" | "default" } {
  const raw = env.MONTHLY_DRAFT_TIMEZONE?.trim();
  const timezone = raw || DEFAULT_MONTHLY_TIMEZONE;
  assertTimezone(timezone);
  return { timezone, source: raw ? "env" : "default" };
}

const pad = (n: number) => String(n).padStart(2, "0");

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Local wall-clock fields of an instant in a zone. */
export function wallTime(instant: Date, tz: string): Wall {
  const parts = formatter(tz).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute") };
}

function offsetMs(instant: number, tz: string): number {
  const w = wallTime(new Date(instant), tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min);
  return asUtc - Math.floor(instant / 60_000) * 60_000;
}

/**
 * The instant at which local wall time (y, m, d, h, min) occurs in `tz`.
 * Ambiguous times (DST fall-back) resolve to the earlier instant; nonexistent
 * times (spring-forward gap) resolve to the first instant after the gap, which
 * is what Postgres does for `timestamp AT TIME ZONE`.
 */
export function zonedInstant(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const target = guess;
  const candidates = new Set<number>();
  for (const probe of [guess - 36 * 3600_000, guess, guess + 36 * 3600_000]) candidates.add(guess - offsetMs(probe, tz));
  const matches = [...candidates].filter((t) => {
    const w = wallTime(new Date(t), tz);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) === target;
  });
  if (matches.length) return new Date(Math.min(...matches));
  // In a gap: shift by the pre-transition offset (lands just after the gap).
  return new Date(guess - offsetMs(guess - 36 * 3600_000, tz));
}

// ---------------------------------------------------------------- months

export function parseMonth(period: string): { y: number; m: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[1]) < 2000 || Number(match[1]) > 2999) {
    throw new Error(`period must be YYYY-MM (2000-2999), got ${period}`);
  }
  return { y: Number(match[1]), m: Number(match[2]) };
}

export function isMonth(period: string): boolean {
  try {
    parseMonth(period);
    return true;
  } catch {
    return false;
  }
}

/** Month `n` months after (negative: before) `period`. */
export function addMonths(period: string, n: number): string {
  const { y, m } = parseMonth(period);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

/** The month containing `instant` in `tz`. */
export function monthOf(instant: Date, tz: string): string {
  const w = wallTime(instant, tz);
  return `${w.y}-${pad(w.m)}`;
}

/** The calendar month before the one containing `now` in `tz`. */
export function previousMonth(now: Date, tz: string): string {
  return addMonths(monthOf(now, tz), -1);
}

export interface MonthWindow {
  period: string;
  timezone: string;
  /** Inclusive start instant (local midnight on the 1st). */
  start: Date;
  /** Exclusive end instant (local midnight on the 1st of the next month). */
  end: Date;
}

export function monthWindow(period: string, tz: string): MonthWindow {
  assertTimezone(tz);
  const { y, m } = parseMonth(period);
  const next = parseMonth(addMonths(period, 1));
  return { period, timezone: tz, start: zonedInstant(y, m, 1, 0, 0, tz), end: zonedInstant(next.y, next.m, 1, 0, 0, tz) };
}

export function monthLabel(period: string): string {
  const { y, m } = parseMonth(period);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
