/** Server-only data helpers for the browse surfaces (home, library, topics, timeline). */
import { sql } from "./db";
import { cachedPublic, publicDataTtlMs } from "./cache";

export interface VideoCard {
  youtube_id: string;
  title: string;
  duration_seconds: number | null;
  published_at: string | null;
  view_count: number | null;
  video_type: string | null;
  segment_count: number;
}

export interface TopicCount {
  name: string;
  slug: string;
  video_count: number;
  segment_count: number;
  citation_count: number;
  trend_pct: number;
}

export interface ArchiveStats {
  videos: number;
  hours: number;
  words: number;
  last_sync: string | null;
  /** Completed videos with at least one embedded chunk (reachable by Ask). */
  searchable_videos: number;
}

export const VIDEO_TYPES = ["AMA", "Whiteboard", "Fireside", "Keynote", "Interview"] as const;

/** Catalogue changes at most a few times a day; browse data is cached briefly. */
const BROWSE_TTL = () => publicDataTtlMs(120_000);
const STATS_TTL = () => publicDataTtlMs(600_000);

/** Latest completed videos with their segment (chunk) counts. */
export async function getLatestVideos(limit = 5): Promise<VideoCard[]> {
  return cachedPublic(`latest:${limit}`, BROWSE_TTL(), () => sql<VideoCard[]>`
    SELECT v.youtube_id, v.title, v.duration_seconds, v.published_at, v.view_count, v.video_type,
      (SELECT count(*)::int FROM transcript_chunks tc WHERE tc.video_id = v.id) AS segment_count
    FROM videos v
    WHERE v.status = 'completed'
    ORDER BY v.published_at DESC NULLS LAST
    LIMIT ${limit}
  `);
}

/**
 * Topics that have at least one assigned completed video, with aggregates.
 * citation_count/trend come from the answers log (last 7d vs prior 7d). Topics
 * with no member videos are excluded so the UI never shows empty facets; while
 * topic assignment has not been run this returns [].
 */
export async function getTopicsWithCounts(limit?: number): Promise<TopicCount[]> {
  return cachedPublic(`topics:${limit ?? "all"}`, BROWSE_TTL(), () => sql<TopicCount[]>`
    WITH members AS (
      SELECT vt.topic_id, vt.video_id, v.youtube_id
      FROM video_topics vt JOIN videos v ON v.id = vt.video_id AND v.status = 'completed'
    ),
    chunk_counts AS (
      SELECT tc.video_id, count(*)::int AS n
      FROM transcript_chunks tc WHERE tc.video_id IN (SELECT video_id FROM members)
      GROUP BY tc.video_id
    ),
    cites AS (
      SELECT s->>'video_id' AS youtube_id, a.created_at
      FROM answers a, jsonb_array_elements(a.sources) s
    ),
    topic_cites AS (
      SELECT m.topic_id,
        count(*) FILTER (WHERE c.created_at > now() - interval '7 days')  AS recent,
        count(*) FILTER (WHERE c.created_at > now() - interval '14 days'
                           AND c.created_at <= now() - interval '7 days') AS prior,
        count(*) AS total
      FROM members m JOIN cites c ON c.youtube_id = m.youtube_id
      GROUP BY m.topic_id
    )
    SELECT t.name, t.slug,
      count(DISTINCT m.video_id)::int AS video_count,
      COALESCE(sum(cc.n), 0)::int AS segment_count,
      COALESCE(tc.total, 0)::int AS citation_count,
      CASE WHEN COALESCE(tc.prior,0) = 0 THEN COALESCE(tc.recent,0) * 100
           ELSE round((tc.recent - tc.prior)::numeric / tc.prior * 100)::int END AS trend_pct
    FROM topics t
    JOIN members m ON m.topic_id = t.id
    LEFT JOIN chunk_counts cc ON cc.video_id = m.video_id
    LEFT JOIN topic_cites tc ON tc.topic_id = t.id
    GROUP BY t.id, t.name, t.slug, tc.total, tc.recent, tc.prior
    ORDER BY citation_count DESC, video_count DESC, t.name
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `);
}

/** Minimum distinct answers in the window before "most cited" is shown (privacy + signal). */
export const MOST_CITED_MIN_ANSWERS = 5;

/**
 * Most-cited videos over the last 7 days from the answers log. With fewer than
 * MOST_CITED_MIN_ANSWERS answers the ranking would mostly reflect one person's
 * questions, so it falls back to most-viewed and says so via `basis`.
 */
export async function getMostCitedVideos(
  limit = 5
): Promise<{ basis: "answers" | "views"; items: { youtube_id: string; title: string; cites: number }[] }> {
  return cachedPublic(`mostcited:${limit}`, BROWSE_TTL(), async () => {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM answers WHERE created_at > now() - interval '7 days'
    `;
    if (n >= MOST_CITED_MIN_ANSWERS) {
      const items = await sql<{ youtube_id: string; title: string; cites: number }[]>`
        SELECT v.youtube_id, v.title, count(*)::int AS cites
        FROM answers a, jsonb_array_elements(a.sources) s
        JOIN videos v ON v.youtube_id = s->>'video_id'
        WHERE a.created_at > now() - interval '7 days'
        GROUP BY v.youtube_id, v.title
        ORDER BY cites DESC, v.title
        LIMIT ${limit}
      `;
      if (items.length) return { basis: "answers" as const, items };
    }
    const items = await sql<{ youtube_id: string; title: string; cites: number }[]>`
      SELECT youtube_id, title, COALESCE(view_count, 0)::int AS cites
      FROM videos WHERE status = 'completed'
      ORDER BY view_count DESC NULLS LAST
      LIMIT ${limit}
    `;
    return { basis: "views" as const, items };
  });
}

/** Timed transcript lines (chunks) for a video, ordered by start. */
export async function getVideoChunks(
  videoInternalId: string
): Promise<{ timed: { start: number; text: string }[]; count: number }> {
  const rows = await sql<{ content: string; start_time: number | null }[]>`
    SELECT content, start_time FROM transcript_chunks
    WHERE video_id = ${videoInternalId}
    ORDER BY start_time ASC NULLS LAST, id
  `;
  const timed = rows
    .filter((r) => r.start_time != null)
    .map((r) => ({ start: r.start_time as number, text: r.content }));
  return { timed, count: rows.length };
}

export interface LibraryCard extends VideoCard {
  cite_count: number;
  tags: string[];
  /** Where a keyword search matched (only set when `q` is given). */
  matched_in: "title" | "tag" | "transcript" | null;
  /** Transcript excerpt around the match; \u0001/\u0002 mark highlighted words. */
  snippet: string | null;
}

export type LibrarySort = "recent" | "cited" | "viewed" | "longest";
export const MAX_LIBRARY_QUERY = 200;

/**
 * Paginated, filterable catalogue for /library and the REST /api/videos.
 * `q` matches titles, tags and the full transcript text (Postgres full-text
 * search over the GIN-indexed cleaned transcript), so it also reaches videos
 * that have no embedded chunks and are invisible to Ask.
 */
export async function getLibraryVideos(opts: {
  type?: string;
  topic?: string; // slug
  q?: string;
  sort?: LibrarySort;
  limit?: number;
  offset?: number;
  /** Restrict to these YouTube ids (keyword search inside a video scope). */
  youtubeIds?: string[] | null;
  /** Published at or after (inclusive). */
  from?: Date | null;
  /** Published before (exclusive). */
  to?: Date | null;
}): Promise<{ rows: LibraryCard[]; total: number }> {
  const { type, topic, sort = "recent", limit = 24, offset = 0 } = opts;
  const ids = opts.youtubeIds?.length ? opts.youtubeIds : null;
  const q = opts.q?.trim().slice(0, MAX_LIBRARY_QUERY) || null;
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const order =
    sort === "cited" ? sql`cite_count DESC, v.published_at DESC NULLS LAST`
    : sort === "viewed" ? sql`v.view_count DESC NULLS LAST`
    : sort === "longest" ? sql`v.duration_seconds DESC NULLS LAST`
    : sql`v.published_at DESC NULLS LAST`;

  const rows = await sql<(Omit<LibraryCard, "snippet"> & { total: number; fts: boolean })[]>`
    WITH cites AS (
      SELECT s->>'video_id' AS youtube_id, count(*)::int AS c
      FROM answers a, jsonb_array_elements(a.sources) s
      GROUP BY 1
    ),
    fts AS (
      SELECT t.video_id FROM transcripts t
      WHERE ${q ? sql`t.search_tsv @@ websearch_to_tsquery('english', ${q})` : sql`false`}
    )
    SELECT v.youtube_id, v.title, v.video_type, v.duration_seconds, v.published_at, v.view_count,
      (SELECT count(*)::int FROM transcript_chunks tc WHERE tc.video_id = v.id) AS segment_count,
      COALESCE(ci.c, 0)::int AS cite_count,
      COALESCE((SELECT array_agg(name) FROM (
         SELECT tg.name FROM video_tags vtx JOIN tags tg ON tg.id = vtx.tag_id
         WHERE vtx.video_id = v.id ORDER BY tg.name LIMIT 3) x), '{}') AS tags,
      ${like
        ? sql`CASE WHEN v.title ILIKE ${like} THEN 'title'
                   WHEN EXISTS (SELECT 1 FROM video_tags vt2 JOIN tags tg2 ON tg2.id = vt2.tag_id WHERE vt2.video_id = v.id AND tg2.name ILIKE ${like}) THEN 'tag'
                   ELSE 'transcript' END`
        : sql`NULL`} AS matched_in,
      (v.id IN (SELECT video_id FROM fts)) AS fts,
      count(*) OVER()::int AS total
    FROM videos v
    LEFT JOIN cites ci ON ci.youtube_id = v.youtube_id
    WHERE v.status = 'completed'
      ${type ? sql`AND v.video_type = ${type}` : sql``}
      ${topic ? sql`AND EXISTS (SELECT 1 FROM video_topics vt JOIN topics t ON t.id = vt.topic_id WHERE vt.video_id = v.id AND t.slug = ${topic})` : sql``}
      ${ids ? sql`AND v.youtube_id IN ${sql(ids)}` : sql``}
      ${opts.from ? sql`AND v.published_at >= ${opts.from}` : sql``}
      ${opts.to ? sql`AND v.published_at < ${opts.to}` : sql``}
      ${like
        ? sql`AND (v.title ILIKE ${like}
                   OR EXISTS (SELECT 1 FROM video_tags vt2 JOIN tags tg2 ON tg2.id = vt2.tag_id WHERE vt2.video_id = v.id AND tg2.name ILIKE ${like})
                   OR v.id IN (SELECT video_id FROM fts))`
        : sql``}
    ORDER BY ${order}
    LIMIT ${limit} OFFSET ${offset}
  `;
  const total = rows[0]?.total ?? 0;

  // Excerpts only for the transcript matches on this page. ts_headline re-parses
  // the whole ~25k-character document per row (seconds for a page of common-word
  // hits), so instead take a bounded window around the first literal occurrence
  // of a query word (or its 5-letter stem-ish prefix) and highlight in JS.
  const snippetIds = q ? rows.filter((r) => r.matched_in === "transcript" && r.fts).map((r) => r.youtube_id) : [];
  const snippets = new Map<string, string>();
  const terms = q ? snippetTerms(q) : [];
  if (snippetIds.length && terms.length) {
    const found = await sql<{ youtube_id: string; snippet: string | null; clipped: boolean }[]>`
      SELECT v.youtube_id, (x.pos > 110) AS clipped,
        CASE WHEN x.pos IS NULL THEN NULL
             ELSE substr(t.cleaned_text, greatest(1, x.pos - 110), 260) END AS snippet
      FROM videos v
      JOIN transcripts t ON t.video_id = v.id
      CROSS JOIN LATERAL (
        SELECT min(nullif(strpos(lower(t.cleaned_text), term), 0)) AS pos
        FROM unnest(${terms}::text[]) AS term
      ) x
      WHERE v.youtube_id IN ${sql(snippetIds)}
    `;
    for (const f of found) if (f.snippet) snippets.set(f.youtube_id, markTerms(f.snippet, terms, f.clipped));
  }

  return {
    rows: rows.map(({ total: _total, fts: _fts, ...r }) => ({ ...r, snippet: snippets.get(r.youtube_id) ?? null })),
    total,
  };
}

/** Number of completed videos per assigned video_type (types with no videos are omitted). */
export async function getVideoTypeCounts(): Promise<{ type: string; count: number }[]> {
  return cachedPublic("typecounts", BROWSE_TTL(), () => sql<{ type: string; count: number }[]>`
    SELECT video_type AS type, count(*)::int AS count
    FROM videos WHERE status = 'completed' AND video_type IS NOT NULL
    GROUP BY video_type ORDER BY count DESC
  `);
}

/** Safety bound for the single-page timeline (the archive holds ~750 videos). */
export const TIMELINE_MAX = 5000;

/** All completed videos newest-first, for the chronological /timeline. */
export async function getTimelineVideos(): Promise<{ videos: VideoCard[]; total: number }> {
  return cachedPublic("timeline", BROWSE_TTL(), async () => {
    const rows = await sql<(VideoCard & { total: number })[]>`
      SELECT v.youtube_id, v.title, v.duration_seconds, v.published_at, v.view_count, v.video_type,
        (SELECT count(*)::int FROM transcript_chunks tc WHERE tc.video_id = v.id) AS segment_count,
        count(*) OVER()::int AS total
      FROM videos v
      WHERE v.status = 'completed'
      ORDER BY v.published_at DESC NULLS LAST
      LIMIT ${TIMELINE_MAX}
    `;
    return { videos: rows.map(({ total: _t, ...r }) => r), total: rows[0]?.total ?? 0 };
  });
}

export async function getArchiveStats(): Promise<ArchiveStats> {
  return cachedPublic("stats", STATS_TTL(), async () => {
    const [row] = await sql<{ videos: number; hours: number; chars: number; last_sync: string | null; searchable: number }[]>`
      SELECT
        (SELECT count(*)::int FROM videos WHERE status = 'completed') AS videos,
        (SELECT COALESCE(round(sum(duration_seconds) / 3600.0), 0)::int FROM videos WHERE status = 'completed') AS hours,
        (SELECT COALESCE(sum(char_length(COALESCE(cleaned_text, raw_text, ''))), 0)::bigint FROM transcripts) AS chars,
        (SELECT max(created_at) FROM videos) AS last_sync,
        (SELECT count(DISTINCT tc.video_id)::int FROM transcript_chunks tc
           JOIN videos v ON v.id = tc.video_id AND v.status = 'completed') AS searchable
    `;
    return {
      videos: row?.videos ?? 0,
      hours: row?.hours ?? 0,
      words: Math.round(Number(row?.chars ?? 0) / 6),
      last_sync: row?.last_sync ?? null,
      searchable_videos: row?.searchable ?? 0,
    };
  });
}

/** Lower-cased words (>= 3 chars) from a websearch query plus 5-letter prefixes, for excerpts. */
export function snippetTerms(q: string): string[] {
  const words = q
    .toLowerCase()
    .replace(/"|\bor\b|(^|\s)-\S+/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3)
    .slice(0, 6);
  const out = new Set<string>();
  for (const w of words) out.add(w);
  for (const w of words) if (w.length > 6) out.add(w.slice(0, 5));
  return [...out];
}

/** Trim an excerpt to word boundaries and wrap term hits in \u0001…\u0002. */
export function markTerms(text: string, terms: string[], clippedStart = true): string {
  const clean = text.replace(/[\u0001\u0002]/g, "").replace(/\s+/g, " ").trim();
  const trimmed = (clippedStart ? clean.replace(/^\S*\s/, "") : clean).replace(/\s\S*$/, "");
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  if (!escaped.length) return trimmed;
  const re = new RegExp(`(${escaped.join("|")})[\\p{L}\\p{N}]*`, "giu");
  return trimmed.replace(re, (m) => `\u0001${m}\u0002`);
}
