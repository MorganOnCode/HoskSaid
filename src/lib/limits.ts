/**
 * Work bounds and input validation shared by every entry point that can spend
 * model calls: POST /api/ask, POST /api/ask/context, GET /api/search and the MCP
 * tools. Client-safe (no server imports) so the UI can mirror the limits.
 */
import type { AskFilters } from "./ask-types";

export const MAX_QUERY_CHARS = 1000;
export const MAX_ASK_BODY_BYTES = 16 * 1024;
export const MAX_MCP_BODY_BYTES = 64 * 1024;
/** JSON-RPC messages accepted in one MCP POST (each tools/call is charged separately). */
export const MAX_MCP_BATCH = 8;
export const MAX_FILTER_VIDEO_IDS = 20;
export const MAX_FILTER_TOPICS = 10;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 10;

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const TOPIC_RE = /^[\p{L}\p{N} &'_-]{1,60}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string; detail?: string };

export function validateQuery(raw: unknown): Validated<string> {
  if (raw === undefined || raw === null) return { ok: false, error: "query_required" };
  if (typeof raw !== "string") return { ok: false, error: "invalid_query", detail: "query must be a string" };
  const q = raw.trim();
  if (!q) return { ok: false, error: "query_required" };
  if (q.length > MAX_QUERY_CHARS) {
    return { ok: false, error: "query_too_long", detail: `query must be at most ${MAX_QUERY_CHARS} characters` };
  }
  return { ok: true, value: q };
}

export function isYoutubeId(s: unknown): s is string {
  return typeof s === "string" && YOUTUBE_ID_RE.test(s);
}

/** YYYY-MM-DD that is a real calendar date. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function slugifyTopic(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Normalised scope: youtube ids, topic slugs, half-open UTC date window. */
export interface Scope {
  youtubeIds: string[] | null;
  topicSlugs: string[] | null;
  from: Date | null; // inclusive
  to: Date | null; // exclusive (day after date_to)
}

export const EMPTY_SCOPE: Scope = { youtubeIds: null, topicSlugs: null, from: null, to: null };

/** Validate the Ask/MCP `filters` object. date_to is inclusive of that whole UTC day. */
export function validateFilters(raw: unknown): Validated<{ filters: AskFilters | undefined; scope: Scope }> {
  if (raw === undefined || raw === null) return { ok: true, value: { filters: undefined, scope: EMPTY_SCOPE } };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid_filters", detail: "filters must be an object" };
  }
  const f = raw as Record<string, unknown>;
  const known = new Set(["date_from", "date_to", "video_ids", "topics"]);
  for (const k of Object.keys(f)) {
    if (!known.has(k)) return { ok: false, error: "invalid_filters", detail: `unknown filter: ${k}` };
  }
  const out: AskFilters = {};
  const scope: Scope = { youtubeIds: null, topicSlugs: null, from: null, to: null };

  if (f.video_ids !== undefined) {
    if (!Array.isArray(f.video_ids) || f.video_ids.length > MAX_FILTER_VIDEO_IDS || !f.video_ids.every(isYoutubeId)) {
      return { ok: false, error: "invalid_filters", detail: `video_ids must be an array of up to ${MAX_FILTER_VIDEO_IDS} video ids` };
    }
    if (f.video_ids.length) {
      out.video_ids = [...new Set(f.video_ids as string[])];
      scope.youtubeIds = out.video_ids;
    }
  }
  if (f.topics !== undefined) {
    if (
      !Array.isArray(f.topics) ||
      f.topics.length > MAX_FILTER_TOPICS ||
      !f.topics.every((t) => typeof t === "string" && TOPIC_RE.test(t.trim()))
    ) {
      return { ok: false, error: "invalid_filters", detail: `topics must be an array of up to ${MAX_FILTER_TOPICS} topic names or slugs` };
    }
    if (f.topics.length) {
      out.topics = f.topics as string[];
      scope.topicSlugs = [...new Set((f.topics as string[]).map(slugifyTopic))];
    }
  }
  for (const key of ["date_from", "date_to"] as const) {
    const v = f[key];
    if (v === undefined || v === null || v === "") continue;
    if (!isIsoDate(v)) return { ok: false, error: "invalid_filters", detail: `${key} must be YYYY-MM-DD` };
    out[key] = v;
  }
  if (out.date_from) scope.from = new Date(`${out.date_from}T00:00:00Z`);
  if (out.date_to) scope.to = new Date(new Date(`${out.date_to}T00:00:00Z`).getTime() + 86_400_000);
  if (scope.from && scope.to && scope.from >= scope.to) {
    return { ok: false, error: "invalid_filters", detail: "date_from must not be after date_to" };
  }
  return { ok: true, value: { filters: Object.keys(out).length ? out : undefined, scope } };
}

/** Clamp an integer query parameter; non-numeric input falls back to the default. */
export function clampInt(raw: unknown, def: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+$/.test(raw.trim()) ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
