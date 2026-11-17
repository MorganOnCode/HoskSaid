/**
 * Site-funded model-call accounting (server-only).
 *
 * Three guards sit in front of every embedding or completion paid for with the
 * site's OPENAI_API_KEY:
 *   1. A process-wide concurrency gate (bounded queue + wait timeout).
 *   2. A per-client daily allowance (client_usage_daily), keyed by an HMAC of
 *      the UTC day and the limiter identity, so one visitor cannot spend the
 *      shared budget. The raw IP or API key is never stored.
 *   3. A site-wide daily call cap (site_usage_daily).
 * The client and site reservations run in one transaction with conditional
 * upserts, so concurrent requests and multiple processes can never exceed
 * either bound, and a request refused by its client allowance never touches
 * the site budget.
 *
 * These are application call bounds. They are not a billing guarantee: the
 * provider-side project budget/alerts remain the only hard spend ceiling.
 * When the cap env vars are absent the conservative defaults below apply;
 * there is deliberately no "unlimited" setting.
 */
import { createHmac, randomBytes } from "node:crypto";
import { sql } from "./db";

export type SiteCallKind = "answer" | "embedding";

export const DEFAULT_DAILY_CAPS: Record<SiteCallKind, number> = {
  answer: 200,
  embedding: 2000,
};

export const DEFAULT_CLIENT_DAILY_CAPS: Record<SiteCallKind, number> = {
  answer: 20,
  embedding: 200,
};

const CAP_ENV: Record<SiteCallKind, string> = {
  answer: "SITE_DAILY_ANSWER_CAP",
  embedding: "SITE_DAILY_EMBEDDING_CAP",
};

const CLIENT_CAP_ENV: Record<SiteCallKind, string> = {
  answer: "CLIENT_DAILY_ANSWER_CAP",
  embedding: "CLIENT_DAILY_EMBEDDING_CAP",
};

function capFromEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  if (!/^\d+$/.test(raw.trim())) {
    console.warn(`[usage] ${name} is not a non-negative integer; using default ${def}`);
    return def;
  }
  return parseInt(raw, 10);
}

/** Site-wide daily cap for a kind. 0 disables site-funded calls of that kind. */
export function dailyCap(kind: SiteCallKind): number {
  return capFromEnv(CAP_ENV[kind], DEFAULT_DAILY_CAPS[kind]);
}

/** Per-client daily allowance for a kind. 0 disables site-funded calls of that kind. */
export function clientDailyCap(kind: SiteCallKind): number {
  return capFromEnv(CLIENT_CAP_ENV[kind], DEFAULT_CLIENT_DAILY_CAPS[kind]);
}

export type BudgetScope = "site" | "client";

export class BudgetExceededError extends Error {
  readonly kind: SiteCallKind;
  readonly scope: BudgetScope;
  constructor(kind: SiteCallKind, scope: BudgetScope = "site") {
    super(`daily ${scope === "client" ? "per-client" : "site-funded"} ${kind} cap reached`);
    this.name = "BudgetExceededError";
    this.kind = kind;
    this.scope = scope;
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

declare global {
  var __hosksaidQuotaSecret: string | undefined;
}

function quotaSecret(): string {
  const configured = process.env.CLIENT_QUOTA_SECRET?.trim();
  if (configured) return configured;
  if (!globalThis.__hosksaidQuotaSecret) {
    console.warn("[usage] CLIENT_QUOTA_SECRET is not set; per-client allowances reset when this process restarts");
    globalThis.__hosksaidQuotaSecret = randomBytes(32).toString("hex");
  }
  return globalThis.__hosksaidQuotaSecret;
}

/**
 * Stored identifier for a limiter identity on a UTC day: an HMAC, so the row
 * holds neither the IP nor the API key and is not linkable across days.
 */
export function clientQuotaKey(client: string, day: string): string {
  return createHmac("sha256", quotaSecret()).update(`${day}\n${client}`).digest("base64url");
}

let purgedBefore: string | null = null;

/** Keep only the current UTC day's per-client rows (once per process per day). */
async function purgeOldClientUsage(day: string): Promise<void> {
  if (purgedBefore === day) return;
  await sql`DELETE FROM client_usage_daily WHERE day < ${day}`;
  purgedBefore = day;
}

/**
 * Reserve `n` site-funded calls of `kind` for `client` today, against both the
 * client's allowance and the site cap, atomically. Throws BudgetExceededError
 * (scope "client" or "site") when either would be exceeded; nothing is
 * reserved in that case. Reservations are not refunded when the provider call
 * later fails (conservative).
 */
export async function reserveSiteCalls(kind: SiteCallKind, client: string, n = 1, now = new Date()): Promise<number> {
  const cap = dailyCap(kind);
  const clientCap = clientDailyCap(kind);
  if (n > cap) throw new BudgetExceededError(kind, "site");
  if (n > clientCap) throw new BudgetExceededError(kind, "client");
  const day = utcDay(now);
  await purgeOldClientUsage(day);
  const key = clientQuotaKey(client, day);
  return sql.begin(async (tx) => {
    const mine = await tx<{ calls: number }[]>`
      INSERT INTO client_usage_daily (day, client, kind, calls)
      VALUES (${day}, ${key}, ${kind}, ${n})
      ON CONFLICT (day, client, kind) DO UPDATE
        SET calls = client_usage_daily.calls + EXCLUDED.calls
        WHERE client_usage_daily.calls + EXCLUDED.calls <= ${clientCap}
      RETURNING calls
    `;
    if (!mine.length) throw new BudgetExceededError(kind, "client");
    const site = await tx<{ calls: number }[]>`
      INSERT INTO site_usage_daily (day, kind, calls)
      VALUES (${day}, ${kind}, ${n})
      ON CONFLICT (day, kind) DO UPDATE
        SET calls = site_usage_daily.calls + EXCLUDED.calls, updated_at = now()
        WHERE site_usage_daily.calls + EXCLUDED.calls <= ${cap}
      RETURNING calls
    `;
    if (!site.length) throw new BudgetExceededError(kind, "site");
    return site[0].calls;
  });
}

/** One reserved site-funded call, held until its provider call is attempted. */
export interface SiteReservation {
  /** Hand the call back if it was never attempted; a no-op once used or released. */
  release(): Promise<void>;
  /** Mark the call as attempted, so it can no longer be released. */
  markUsed(): void;
}

/**
 * Reserve one call of `kind` for `client` now (as reserveSiteCalls) and hold
 * it, so a multi-step request can secure its final paid call before paying
 * for earlier steps. Release always decrements the original UTC day's rows,
 * even after midnight, and never below zero.
 */
export async function reserveSiteCall(kind: SiteCallKind, client: string, now = new Date()): Promise<SiteReservation> {
  const day = utcDay(now);
  await reserveSiteCalls(kind, client, 1, now);
  const key = clientQuotaKey(client, day);
  let settled = false;
  return {
    markUsed() {
      settled = true;
    },
    async release() {
      if (settled) return;
      settled = true;
      await sql.begin(async (tx) => {
        await tx`
          UPDATE client_usage_daily SET calls = calls - 1
          WHERE day = ${day} AND client = ${key} AND kind = ${kind} AND calls > 0
        `;
        await tx`
          UPDATE site_usage_daily SET calls = calls - 1, updated_at = now()
          WHERE day = ${day} AND kind = ${kind} AND calls > 0
        `;
      });
    },
  };
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
  var __hosksaidGates: { site: Semaphore } | undefined;
}

/** Process-wide gate (kept on globalThis so dev hot-reload does not multiply it). */
export function gates(): { site: Semaphore } {
  if (!globalThis.__hosksaidGates) {
    globalThis.__hosksaidGates = {
      site: new Semaphore(envInt("SITE_MAX_CONCURRENT_CALLS", 4, 1, 64), 32, 15_000),
    };
  }
  return globalThis.__hosksaidGates;
}

/** Run an already reserved site-funded call: wait for a slot, mark the reservation used, then call. */
export async function withReservedSiteCall<T>(reservation: SiteReservation, fn: () => Promise<T>): Promise<T> {
  const release = await gates().site.acquire();
  try {
    reservation.markUsed();
    return await fn();
  } finally {
    release();
  }
}

/** Run one site-funded call: wait for a slot, reserve today's client and site budget, then call. */
export async function withSiteCall<T>(kind: SiteCallKind, client: string, fn: () => Promise<T>): Promise<T> {
  const release = await gates().site.acquire();
  try {
    await reserveSiteCalls(kind, client, 1);
    return await fn();
  } finally {
    release();
  }
}
