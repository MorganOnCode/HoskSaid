/**
 * Site-funded model-call accounting (server-only).
 *
 * Two independent guards sit in front of every embedding or completion paid
 * for with the site's OPENAI_API_KEY:
 *   1. A process-wide concurrency gate (bounded queue + wait timeout).
 *   2. A daily call cap stored in Postgres (site_usage_daily), reserved with a
 *      conditional upsert so concurrent requests and multiple processes can never
 *      exceed it.
 *
 * These are application call bounds. They are not a billing guarantee: the
 * provider-side project budget/alerts remain the only hard spend ceiling.
 * When the cap env vars are absent the conservative defaults below apply;
 * there is deliberately no "unlimited" setting.
 */
import { sql } from "./db";

export type SiteCallKind = "answer" | "embedding";

export const DEFAULT_DAILY_CAPS: Record<SiteCallKind, number> = {
  answer: 200,
  embedding: 2000,
};

const CAP_ENV: Record<SiteCallKind, string> = {
  answer: "SITE_DAILY_ANSWER_CAP",
  embedding: "SITE_DAILY_EMBEDDING_CAP",
};

/** Daily cap for a kind. 0 disables site-funded calls of that kind. */
export function dailyCap(kind: SiteCallKind): number {
  const raw = process.env[CAP_ENV[kind]];
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_CAPS[kind];
  if (!/^\d+$/.test(raw.trim())) {
    console.warn(`[usage] ${CAP_ENV[kind]} is not a non-negative integer; using default ${DEFAULT_DAILY_CAPS[kind]}`);
    return DEFAULT_DAILY_CAPS[kind];
  }
  return parseInt(raw, 10);
}

export class BudgetExceededError extends Error {
  readonly kind: SiteCallKind;
  constructor(kind: SiteCallKind) {
    super(`daily site-funded ${kind} cap reached`);
    this.name = "BudgetExceededError";
    this.kind = kind;
  }
}

export class BusyError extends Error {
  constructor() {
    super("too many concurrent model calls");
    this.name = "BusyError";
  }
}

/** Seconds until the next UTC midnight (when the daily cap resets). */
export function secondsUntilUtcMidnight(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Reserve `n` site-funded calls of `kind` for today. Throws BudgetExceededError
 * when the reservation would exceed the cap. Reservations are not refunded when
 * the provider call later fails (conservative).
 */
export async function reserveSiteCalls(kind: SiteCallKind, n = 1, now = new Date()): Promise<number> {
  const cap = dailyCap(kind);
  if (n > cap) throw new BudgetExceededError(kind);
  const rows = await sql<{ calls: number }[]>`
    INSERT INTO site_usage_daily (day, kind, calls)
    VALUES (${utcDay(now)}, ${kind}, ${n})
    ON CONFLICT (day, kind) DO UPDATE
      SET calls = site_usage_daily.calls + EXCLUDED.calls, updated_at = now()
      WHERE site_usage_daily.calls + EXCLUDED.calls <= ${cap}
    RETURNING calls
  `;
  if (!rows.length) throw new BudgetExceededError(kind);
  return rows[0].calls;
}

export async function usageToday(now = new Date()): Promise<Record<SiteCallKind, { used: number; cap: number }>> {
  const rows = await sql<{ kind: SiteCallKind; calls: number }[]>`
    SELECT kind, calls FROM site_usage_daily WHERE day = ${utcDay(now)}
  `;
  const used = new Map(rows.map((r) => [r.kind, r.calls]));
  return {
    answer: { used: used.get("answer") ?? 0, cap: dailyCap("answer") },
    embedding: { used: used.get("embedding") ?? 0, cap: dailyCap("embedding") },
  };
}

// ---------------------------------------------------------------------------
// Concurrency gate
// ---------------------------------------------------------------------------

export class Semaphore {
  private active = 0;
  private readonly queue: { resolve: () => void; timer: ReturnType<typeof setTimeout> }[] = [];

  constructor(
    readonly max: number,
    readonly maxQueue: number,
    readonly waitMs: number
  ) {}

  get inFlight(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    if (this.queue.length >= this.maxQueue) throw new BusyError();
    await new Promise<void>((resolve, reject) => {
      const entry = {
        resolve,
        timer: setTimeout(() => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new BusyError());
        }, this.waitMs),
      };
      this.queue.push(entry);
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(); // hand the slot straight to the next waiter
      } else {
        this.active--;
      }
    };
  }
}

function envInt(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw)) return def;
  return Math.min(max, Math.max(min, parseInt(raw, 10)));
}

declare global {
  var __hosksaidGates: { site: Semaphore; user: Semaphore } | undefined;
}

/** Process-wide gates (kept on globalThis so dev hot-reload does not multiply them). */
export function gates(): { site: Semaphore; user: Semaphore } {
  if (!globalThis.__hosksaidGates) {
    globalThis.__hosksaidGates = {
      site: new Semaphore(envInt("SITE_MAX_CONCURRENT_CALLS", 4, 1, 64), 32, 15_000),
      user: new Semaphore(envInt("USER_PROVIDER_MAX_CONCURRENT_CALLS", 4, 1, 64), 32, 15_000),
    };
  }
  return globalThis.__hosksaidGates;
}

/** Run one site-funded call: wait for a slot, reserve today's budget, then call. */
export async function withSiteCall<T>(kind: SiteCallKind, fn: () => Promise<T>): Promise<T> {
  const release = await gates().site.acquire();
  try {
    await reserveSiteCalls(kind, 1);
    return await fn();
  } finally {
    release();
  }
}

/** Run one visitor-key/provider call under its own concurrency gate (no site budget). */
export async function withUserProviderCall<T>(fn: () => Promise<T>): Promise<T> {
  const release = await gates().user.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
