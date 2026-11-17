/**
 * Server-only reads behind /analytics and /api/analytics*.
 *
 * Live queries (coverage, sources, subjects) read only public catalogue tables
 * (videos, transcripts, transcript_chunks) in a READ ONLY transaction with a
 * statement timeout, and results are memoised per normalised query. They never
 * read visitor questions/answers and never call a model or embedding API.
 *
 * Matching: a video matches a query when its transcript (the cleaned text the
 * Library searches, via transcripts.search_tsv) or its title matches the same
 * websearch_to_tsquery('english', q). YouTube tags are deliberately excluded:
 * they are uploader SEO, not speech.
 */
import type postgres from "postgres";
import { sql } from "../db";
import { cachedPublic, createPublicCache, forgetPublic, publicDataTtlMs } from "../cache";
import { clampInt } from "../limits";
import { markTerms, snippetTerms } from "../browse";
import { METHOD, STOPWORDS, type RankingList, type YearCount } from "./method";
import { SOURCES_PAGE_SIZE } from "./params";
import { SUBJECTS } from "./subjects";

type Tx = postgres.TransactionSql<Record<string, never>>;

/** A live analytics query exceeded ANALYTICS_STATEMENT_TIMEOUT_MS. */
export class AnalyticsTimeoutError extends Error {
  constructor() {
    super("analytics query timed out");
    this.name = "AnalyticsTimeoutError";
  }
}

export function statementTimeoutMs(): number {
  return clampInt(process.env.ANALYTICS_STATEMENT_TIMEOUT_MS, 3000, 50, 30_000);
}

const LIVE_TTL = () => publicDataTtlMs(600_000);
const SNAPSHOT_TTL = () => publicDataTtlMs(120_000);
const queryCache = createPublicCache(200);

/** Run `fn` in a read-only transaction whose statements are bounded by the analytics timeout. */
export async function withAnalyticsTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return (await sql.begin("read only", async (tx) => {
      await tx`SELECT set_config('statement_timeout', ${String(statementTimeoutMs())}, true)`;
      return fn(tx as unknown as Tx);
    })) as T;
  } catch (e) {
    if ((e as { code?: string })?.code === "57014") throw new AnalyticsTimeoutError();
    throw e;
  }
}

const key = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
const yearStart = (y: number) => new Date(Date.UTC(y, 0, 1));

// ---------------------------------------------------------------------------
// Archive years (coverage denominators)
// ---------------------------------------------------------------------------

export interface ArchiveYears {
  /** Completed, dated videos per publication year (UTC), ascending. */
  years: YearCount[];
  /** Completed videos with no publication date (not plotted). */
  undated: number;
}

export async function getArchiveYears(): Promise<ArchiveYears> {
  return cachedPublic("an:years", LIVE_TTL(), () =>
    withAnalyticsTx(async (tx) => {
      const rows = await tx<{ year: number | null; videos: number }[]>`
        SELECT extract(year FROM published_at AT TIME ZONE 'UTC')::int AS year, count(*)::int AS videos
        FROM videos WHERE status = 'completed'
        GROUP BY 1 ORDER BY 1
      `;
      return {
        years: rows.filter((r) => r.year !== null).map((r) => ({ year: r.year as number, videos: r.videos })),
        undated: rows.find((r) => r.year === null)?.videos ?? 0,
      };
    })
  );
}

// ---------------------------------------------------------------------------
// Term validity
// ---------------------------------------------------------------------------

/** ok, or why the query cannot be counted: only stopwords, or only exclusions. */
export type TermStatus = "ok" | "empty" | "negative_only";

async function termStatuses(tx: Tx, terms: string[]): Promise<TermStatus[]> {
  if (!terms.length) return [];
  const rows = await tx<{ i: number; nodes: number; tree: string }[]>`
    SELECT x.i::int AS i, numnode(q) AS nodes, querytree(q) AS tree
    FROM unnest(${terms}::text[]) WITH ORDINALITY AS x(t, i),
    LATERAL websearch_to_tsquery('english', x.t) AS q
    ORDER BY x.i
  `;
  return rows.map((r) => (r.nodes === 0 ? "empty" : r.tree === "T" ? "negative_only" : "ok"));
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface MatchRef {
  youtube_id: string;
  title: string;
  published_at: string;
}

export interface YearCoverage {
  year: number;
  /** Completed videos published that year (denominator). */
  videos: number;
  /** ...whose transcript or title matches. */
  matched: number;
  /** ...matching in the title only. */
  title_only: number;
}

export interface TermCoverage {
  q: string;
  status: TermStatus;
  matched: number;
  of: number;
  title_only: number;
  first: MatchRef | null;
  latest: MatchRef | null;
  by_year: YearCoverage[];
}

async function coverageForTerm(tx: Tx, term: string, from: number, to: number): Promise<Omit<TermCoverage, "q" | "status">> {
  const [row] = await tx<{ by_year: YearCoverage[]; first: MatchRef | null; latest: MatchRef | null }[]>`
    WITH vids AS MATERIALIZED (
      SELECT v.id, v.youtube_id, v.title, v.published_at,
             extract(year FROM v.published_at AT TIME ZONE 'UTC')::int AS year
      FROM videos v
      WHERE v.status = 'completed' AND v.published_at >= ${yearStart(from)} AND v.published_at < ${yearStart(to + 1)}
    ),
    hit_tx AS (
      SELECT t.video_id FROM transcripts t WHERE t.search_tsv @@ websearch_to_tsquery('english', ${term})
    ),
    m AS MATERIALIZED (
      SELECT vids.*,
             (vids.id IN (SELECT video_id FROM hit_tx)) AS in_tx,
             (to_tsvector('english', vids.title) @@ websearch_to_tsquery('english', ${term})) AS in_title
      FROM vids
    )
    SELECT
      COALESCE((SELECT json_agg(y ORDER BY y.year) FROM (
        SELECT year, count(*)::int AS videos,
               count(*) FILTER (WHERE in_tx OR in_title)::int AS matched,
               count(*) FILTER (WHERE in_title AND NOT in_tx)::int AS title_only
        FROM m GROUP BY year
      ) y), '[]'::json) AS by_year,
      (SELECT json_build_object('youtube_id', youtube_id, 'title', title, 'published_at', published_at)
         FROM m WHERE in_tx OR in_title ORDER BY published_at, youtube_id LIMIT 1) AS first,
      (SELECT json_build_object('youtube_id', youtube_id, 'title', title, 'published_at', published_at)
         FROM m WHERE in_tx OR in_title ORDER BY published_at DESC, youtube_id LIMIT 1) AS latest
  `;
  const by = row.by_year;
  return {
    matched: by.reduce((s, y) => s + y.matched, 0),
    of: by.reduce((s, y) => s + y.videos, 0),
    title_only: by.reduce((s, y) => s + y.title_only, 0),
    first: row.first,
    latest: row.latest,
    by_year: by,
  };
}

const EMPTY_COVERAGE = { matched: 0, of: 0, title_only: 0, first: null, latest: null, by_year: [] };

/** Per-year coverage of up to MAX_TERMS validated terms over [from, to] (inclusive years). */
export async function getCoverage(terms: string[], from: number, to: number): Promise<TermCoverage[]> {
  return Promise.all(
    terms.map((term) =>
      queryCache.cached(`an:cov:${from}:${to}:${key(term)}`, LIVE_TTL(), () =>
        withAnalyticsTx(async (tx) => {
          const [status] = await termStatuses(tx, [term]);
          if (status !== "ok") return { q: term, status, ...EMPTY_COVERAGE };
          return { q: term, status, ...(await coverageForTerm(tx, term, from, to)) };
        })
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface SourceItem {
  youtube_id: string;
  title: string;
  published_at: string | null;
  duration_seconds: number | null;
  matched_in: "transcript" | "title" | "both";
  /** Excerpt around the first phrase (else word) match; \u0001…\u0002 mark hits. */
  excerpt: string | null;
  /** Seconds of the first TIMED transcript segment matching the query, if any. */
  timed_start: number | null;
  /** The video's own page: seeks to the timed match, else filters its transcript to the literal match. */
  href: string;
  link_kind: "timed" | "transcript" | "video";
}

export interface SourcesPage {
  q: string;
  status: TermStatus;
  year: number | null;
  total: number;
  page: number;
  pages: number;
  items: SourceItem[];
}

/** Positive words and quoted phrases of a websearch query (exclusions and OR dropped). */
export function termParts(term: string): { phrases: string[][]; words: string[] } {
  const phrases: string[][] = [];
  const words: string[] = [];
  const split = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu)?.map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean) ?? [];
  for (const m of term.matchAll(/(-?)"([^"]*)"?|(-?)([^\s"]+)/g)) {
    if (m[2] !== undefined) {
      if (m[1]) continue;
      const w = split(m[2]);
      if (w.length > 1) phrases.push(w);
      else if (w.length === 1) words.push(w[0]);
    } else if (m[4] !== undefined) {
      if (m[3] || m[4].toLowerCase() === "or") continue;
      words.push(...split(m[4]));
    }
  }
  return { phrases, words: [...new Set(words.filter((w) => !STOPWORDS.has(w)))] };
}

const reEscape = (s: string) => s.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");

/** Crude suffix strip so "chains" also finds "chain" and "staking" finds "stake". */
function stemBase(w: string): string {
  for (const suf of ["ing", "ed", "es", "s"]) if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  return w;
}

/**
 * Postgres (ARE) regexes, in priority order, that locate an excerpt: each
 * quoted phrase first (words in sequence, any punctuation between), then each
 * positive word. Built only from escaped word characters.
 */
export function excerptPatterns(term: string): string[] {
  const { phrases, words } = termParts(term);
  const w = (x: string) => `${reEscape(stemBase(x))}\\w*`;
  return [
    ...phrases.map((p) => `\\m${p.map(w).join("\\W+")}`),
    ...words.map((x) => `\\m${w(x)}`),
  ].slice(0, 8);
}

/** A literal the video page can filter its transcript by (single-spaced, one line). */
function literalFor(matched: string | null): string | null {
  if (!matched) return null;
  const one = matched.replace(/\s+/g, " ").trim();
  if (one === matched.trim() && one.length <= 80) return one;
  return matched.trim().split(/\s+/)[0] || null;
}

export async function getSources(term: string, from: number, to: number, year: number | null, page: number): Promise<SourcesPage> {
  const lo = year ?? from;
  const hi = year ?? to;
  return queryCache.cached(`an:src:${from}:${to}:${year ?? "all"}:${page}:${key(term)}`, LIVE_TTL(), () =>
    withAnalyticsTx(async (tx) => {
      const [status] = await termStatuses(tx, [term]);
      const base = { q: term, status, year, page, total: 0, pages: 0, items: [] as SourceItem[] };
      if (status !== "ok") return base;
      const rows = await tx<{ id: string; youtube_id: string; title: string; published_at: Date | null; duration_seconds: number | null; in_tx: boolean; in_title: boolean; total: number }[]>`
        WITH vids AS MATERIALIZED (
          SELECT v.id, v.youtube_id, v.title, v.published_at, v.duration_seconds
          FROM videos v
          WHERE v.status = 'completed' AND v.published_at >= ${yearStart(lo)} AND v.published_at < ${yearStart(hi + 1)}
        ),
        hit_tx AS (
          SELECT t.video_id FROM transcripts t WHERE t.search_tsv @@ websearch_to_tsquery('english', ${term})
        ),
        m AS (
          SELECT vids.*,
                 (vids.id IN (SELECT video_id FROM hit_tx)) AS in_tx,
                 (to_tsvector('english', vids.title) @@ websearch_to_tsquery('english', ${term})) AS in_title
          FROM vids
        )
        SELECT id, youtube_id, title, published_at, duration_seconds, in_tx, in_title, count(*) OVER()::int AS total
        FROM m WHERE in_tx OR in_title
        ORDER BY published_at DESC, youtube_id
        LIMIT ${SOURCES_PAGE_SIZE} OFFSET ${(page - 1) * SOURCES_PAGE_SIZE}
      `;
      const total = rows[0]?.total ?? (page > 1 ? (await countMatches(tx, term, lo, hi)) : 0);
      if (!rows.length) return { ...base, total, pages: Math.ceil(total / SOURCES_PAGE_SIZE) };

      const patterns = excerptPatterns(term);
      const detail = await tx<{ id: string; snippet: string | null; clipped: boolean | null; matched: string | null; timed_start: number | null; has_timed: boolean }[]>`
        SELECT v.id,
          CASE WHEN ex.pos IS NOT NULL THEN substr(t.cleaned_text, greatest(1, ex.pos - 110), 260) END AS snippet,
          (ex.pos > 110) AS clipped,
          ex.matched,
          (SELECT min(c.start_time) FROM transcript_chunks c
             WHERE c.video_id = v.id AND c.start_time IS NOT NULL
               AND to_tsvector('english', c.content) @@ websearch_to_tsquery('english', ${term})) AS timed_start,
          EXISTS (SELECT 1 FROM transcript_chunks c WHERE c.video_id = v.id AND c.start_time IS NOT NULL) AS has_timed
        FROM videos v
        LEFT JOIN transcripts t ON t.video_id = v.id
        LEFT JOIN LATERAL (
          SELECT u.pos, regexp_substr(t.cleaned_text, u.pat, 1, 1, 'i') AS matched
          FROM (
            SELECT regexp_instr(t.cleaned_text, x.pat, 1, 1, 0, 'i') AS pos, x.pat, x.ord
            FROM unnest(${patterns}::text[]) WITH ORDINALITY AS x(pat, ord)
          ) u
          WHERE u.pos > 0 ORDER BY u.ord LIMIT 1
        ) ex ON true
        WHERE v.id IN ${tx(rows.map((r) => r.id))}
      `;
      const byId = new Map(detail.map((d) => [d.id, d]));
      const hl = snippetTerms(term);
      const items: SourceItem[] = rows.map((r) => {
        const d = r.in_tx ? byId.get(r.id) : undefined;
        const literal = literalFor(d?.matched ?? null);
        const timed = d?.timed_start ?? null;
        let href = `/video/${r.youtube_id}`;
        let link_kind: SourceItem["link_kind"] = "video";
        if (timed !== null) {
          href += `?t=${Math.max(0, Math.floor(timed))}`;
          link_kind = "timed";
        } else if (d && !d.has_timed && literal) {
          // Untimed transcripts render as paragraphs; ?q= filters them to the literal match.
          href += `?q=${encodeURIComponent(literal)}`;
          link_kind = "transcript";
        }
        return {
          youtube_id: r.youtube_id,
          title: r.title,
          published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
          duration_seconds: r.duration_seconds,
          matched_in: r.in_tx && r.in_title ? "both" : r.in_tx ? "transcript" : "title",
          // Highlight exactly what was found; fall back to the query words.
          excerpt: d?.snippet ? markTerms(d.snippet, literal ? [literal.toLowerCase()] : hl, !!d.clipped) : null,
          timed_start: timed,
          href,
          link_kind,
        };
      });
      return { ...base, total, pages: Math.ceil(total / SOURCES_PAGE_SIZE), items };
    })
  );
}

async function countMatches(tx: Tx, term: string, lo: number, hi: number): Promise<number> {
  const c = await coverageForTerm(tx, term, lo, hi);
  return c.matched;
}

// ---------------------------------------------------------------------------
// Subjects (live, all years; ranges are summed in JS)
// ---------------------------------------------------------------------------

export interface SubjectYears {
  slug: string;
  /** year -> matching videos */
  by_year: Record<number, number>;
}

export async function getSubjectYears(): Promise<SubjectYears[]> {
  return cachedPublic("an:subjects", LIVE_TTL(), () =>
    withAnalyticsTx(async (tx) => {
      const rows = await tx<{ slug: string; year: number; matched: number }[]>`
        WITH vids AS MATERIALIZED (
          SELECT v.id, extract(year FROM v.published_at AT TIME ZONE 'UTC')::int AS year,
                 to_tsvector('english', v.title) AS ttsv
          FROM videos v WHERE v.status = 'completed' AND v.published_at IS NOT NULL
        ),
        s AS (
          SELECT x.slug, websearch_to_tsquery('english', x.q) AS tsq
          FROM unnest(${SUBJECTS.map((s) => s.slug)}::text[], ${SUBJECTS.map((s) => s.query)}::text[]) AS x(slug, q)
        )
        SELECT s.slug, vids.year, count(*)::int AS matched
        FROM s
        JOIN LATERAL (
          SELECT t.video_id AS id FROM transcripts t WHERE t.search_tsv @@ s.tsq
          UNION
          SELECT vv.id FROM vids vv WHERE vv.ttsv @@ s.tsq
        ) h ON true
        JOIN vids ON vids.id = h.id
        GROUP BY s.slug, vids.year
      `;
      const out = new Map<string, Record<number, number>>(SUBJECTS.map((s) => [s.slug, {}]));
      for (const r of rows) out.get(r.slug)![r.year] = r.matched;
      return SUBJECTS.map((s) => ({ slug: s.slug, by_year: out.get(s.slug)! }));
    })
  );
}

// ---------------------------------------------------------------------------
// Ranking snapshot (written by `hosk analytics refresh`)
// ---------------------------------------------------------------------------

export interface SnapshotMeta {
  id: number;
  method: string;
  generated_at: string;
  videos_computed: number;
  words_computed: number;
  years: YearCount[];
  params: Record<string, unknown>;
  source_updated_at: string | null;
}

export type SnapshotStatus =
  | { state: "missing" }
  | { state: "outdated_method"; snapshot: SnapshotMeta }
  | { state: "stale"; snapshot: SnapshotMeta; current_videos: number; reason: string }
  | { state: "current"; snapshot: SnapshotMeta };

/** The published snapshot and whether it still matches the archive. */
export async function getSnapshotStatus(): Promise<SnapshotStatus> {
  return cachedPublic("an:snapshot", SNAPSHOT_TTL(), () =>
    withAnalyticsTx(async (tx) => {
      // Check first: a failed statement would abort the whole read transaction.
      const [{ t }] = await tx<{ t: string | null }[]>`SELECT to_regclass('public.analytics_snapshots')::text AS t`;
      if (!t) return { state: "missing" as const };
      const [snap] = await tx<SnapshotMeta[]>`
        SELECT id::int AS id, method, generated_at, videos_computed, words_computed::float8 AS words_computed,
               years, params, source_updated_at
        FROM analytics_snapshots ORDER BY generated_at DESC, id DESC LIMIT 1
      `;
      if (!snap) return { state: "missing" as const };
      if (snap.method !== METHOD) return { state: "outdated_method" as const, snapshot: snap };
      const [cur] = await tx<{ n: number; updated: string | null }[]>`
        SELECT count(*)::int AS n, max(t.updated_at) AS updated
        FROM videos v JOIN transcripts t ON t.video_id = v.id
        WHERE v.status = 'completed' AND v.published_at IS NOT NULL AND octet_length(t.cleaned_text) > 0
      `;
      if (cur.n !== snap.videos_computed) {
        return { state: "stale" as const, snapshot: snap, current_videos: cur.n, reason: "video_count" };
      }
      if (cur.updated && snap.source_updated_at && new Date(cur.updated) > new Date(snap.source_updated_at)) {
        return { state: "stale" as const, snapshot: snap, current_videos: cur.n, reason: "transcripts_updated" };
      }
      return { state: "current" as const, snapshot: snap };
    })
  );
}

export interface RankingItem {
  rank: number;
  item: string;
  videos: number;
  of_videos: number;
  cmp_videos: number | null;
  cmp_of: number | null;
  lift: number | null;
  edge_share: number | null;
}

export type RankingLists = Record<RankingList, RankingItem[]>;

/** The snapshot's years inside [from, to] (the range a ranking row is keyed by). */
export function snapshotRange(years: YearCount[], from: number, to: number): { from: number; to: number; videos: number } | null {
  const inside = years.filter((y) => y.year >= from && y.year <= to);
  if (!inside.length) return null;
  return { from: inside[0].year, to: inside[inside.length - 1].year, videos: inside.reduce((s, y) => s + y.videos, 0) };
}

class SnapshotGoneError extends Error {}

/** The snapshot's lists for one keyed range, or null when that snapshot has since been replaced. */
export async function getRankingLists(snapshotId: number, from: number, to: number): Promise<RankingLists | null> {
  try {
    return await cachedPublic(`an:rank:${snapshotId}:${from}:${to}`, SNAPSHOT_TTL(), () =>
      withAnalyticsTx(async (tx) => {
        const [exists] = await tx`SELECT 1 FROM analytics_snapshots WHERE id = ${snapshotId}`;
        if (!exists) throw new SnapshotGoneError();
        const rows = await tx<(RankingItem & { list: RankingList })[]>`
          SELECT list, rank, item, videos, of_videos, cmp_videos, cmp_of, lift, edge_share
          FROM analytics_rankings
          WHERE snapshot_id = ${snapshotId} AND year_from = ${from} AND year_to = ${to}
          ORDER BY list, rank
        `;
        const out: RankingLists = { phrases: [], keywords: [], distinctive: [], formulas: [] };
        for (const { list, ...r } of rows) out[list].push(r);
        return out;
      })
    );
  } catch (e) {
    if (!(e instanceof SnapshotGoneError)) throw e;
    forgetPublic("an:snapshot");
    return null;
  }
}
