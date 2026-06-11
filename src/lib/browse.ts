/** Server-only data helpers for the browse surfaces (home, library, topics, timeline). */
import { sql } from "./db";

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
}

/** Latest completed videos with their segment (chunk) counts. */
export async function getLatestVideos(limit = 5): Promise<VideoCard[]> {
  return await sql<VideoCard[]>`
    SELECT v.youtube_id, v.title, v.duration_seconds, v.published_at, v.view_count, v.video_type,
      (SELECT count(*)::int FROM transcript_chunks tc WHERE tc.video_id = v.id) AS segment_count
    FROM videos v
    WHERE v.status = 'completed'
    ORDER BY v.published_at DESC NULLS LAST
    LIMIT ${limit}
  `;
}

/**
 * Topics with computed aggregates. citation_count/trend come from the answers log
 * (last 7d vs prior 7d); video_count/segment_count from the catalogue. Topics with
 * no member videos are excluded so the UI never shows empties.
 */
export async function getTopicsWithCounts(limit?: number): Promise<TopicCount[]> {
  const rows = await sql<TopicCount[]>`
    WITH cites AS (
      SELECT s->>'video_id' AS youtube_id, a.created_at
      FROM answers a, jsonb_array_elements(a.sources) s
    ),
    topic_cites AS (
      SELECT vt.topic_id,
        count(*) FILTER (WHERE c.created_at > now() - interval '7 days')  AS recent,
        count(*) FILTER (WHERE c.created_at > now() - interval '14 days'
                           AND c.created_at <= now() - interval '7 days') AS prior,
        count(*) AS total
      FROM video_topics vt
      JOIN videos v ON v.id = vt.video_id
      JOIN cites c ON c.youtube_id = v.youtube_id
      GROUP BY vt.topic_id
    )
    SELECT t.name, t.slug,
      count(DISTINCT vt.video_id)::int AS video_count,
      COALESCE(sum((SELECT count(*) FROM transcript_chunks tc WHERE tc.video_id = vt.video_id)), 0)::int AS segment_count,
      COALESCE(tc.total, 0)::int AS citation_count,
      CASE WHEN COALESCE(tc.prior,0) = 0 THEN COALESCE(tc.recent,0) * 100
           ELSE round((tc.recent - tc.prior)::numeric / tc.prior * 100)::int END AS trend_pct
    FROM topics t
    LEFT JOIN video_topics vt ON vt.topic_id = t.id
    LEFT JOIN topic_cites tc ON tc.topic_id = t.id
    GROUP BY t.id, t.name, t.slug, tc.total, tc.recent, tc.prior
    ORDER BY citation_count DESC, video_count DESC, t.name
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `;
  return rows;
}

/** Most-cited videos over a recent window (from the answers log). Fallback: most viewed. */
export async function getMostCitedVideos(limit = 5): Promise<{ youtube_id: string; title: string; cites: number }[]> {
  const cited = await sql<{ youtube_id: string; title: string; cites: number }[]>`
    SELECT v.youtube_id, v.title, count(*)::int AS cites
    FROM answers a, jsonb_array_elements(a.sources) s
    JOIN videos v ON v.youtube_id = s->>'video_id'
    WHERE a.created_at > now() - interval '7 days'
    GROUP BY v.youtube_id, v.title
    ORDER BY cites DESC
    LIMIT ${limit}
  `;
  if (cited.length) return cited;

  // Fallback before answers accrue: most viewed completed videos.
  return await sql<{ youtube_id: string; title: string; cites: number }[]>`
    SELECT youtube_id, title, COALESCE(view_count, 0)::int AS cites
    FROM videos WHERE status = 'completed'
    ORDER BY view_count DESC NULLS LAST
    LIMIT ${limit}
  `;
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
}

export type LibrarySort = "recent" | "cited" | "viewed" | "longest";

/** Paginated, filterable catalogue for /library and the REST /api/videos. */
export async function getLibraryVideos(opts: {
  type?: string;
  topic?: string; // slug
  q?: string;
  sort?: LibrarySort;
  limit?: number;
  offset?: number;
}): Promise<{ rows: LibraryCard[]; total: number }> {
  const { type, topic, q, sort = "recent", limit = 24, offset = 0 } = opts;
  const like = q ? `%${q}%` : null;
  const order =
    sort === "cited" ? sql`cite_count DESC, v.published_at DESC NULLS LAST`
    : sort === "viewed" ? sql`v.view_count DESC NULLS LAST`
    : sort === "longest" ? sql`v.duration_seconds DESC NULLS LAST`
    : sql`v.published_at DESC NULLS LAST`;

  const rows = await sql<(LibraryCard & { total: number })[]>`
    WITH cites AS (
      SELECT s->>'video_id' AS youtube_id, count(*)::int AS c
      FROM answers a, jsonb_array_elements(a.sources) s
      GROUP BY 1
    )
    SELECT v.youtube_id, v.title, v.video_type, v.duration_seconds, v.published_at, v.view_count,
      (SELECT count(*)::int FROM transcript_chunks tc WHERE tc.video_id = v.id) AS segment_count,
      COALESCE(ci.c, 0)::int AS cite_count,
      COALESCE((SELECT array_agg(name) FROM (
         SELECT tg.name FROM video_tags vtx JOIN tags tg ON tg.id = vtx.tag_id
         WHERE vtx.video_id = v.id ORDER BY tg.name LIMIT 3) x), '{}') AS tags,
      count(*) OVER()::int AS total
    FROM videos v
    LEFT JOIN cites ci ON ci.youtube_id = v.youtube_id
    WHERE v.status = 'completed'
      ${type ? sql`AND v.video_type = ${type}` : sql``}
      ${topic ? sql`AND EXISTS (SELECT 1 FROM video_topics vt JOIN topics t ON t.id = vt.topic_id WHERE vt.video_id = v.id AND t.slug = ${topic})` : sql``}
      ${like ? sql`AND (v.title ILIKE ${like} OR EXISTS (SELECT 1 FROM video_tags vt2 JOIN tags tg2 ON tg2.id = vt2.tag_id WHERE vt2.video_id = v.id AND tg2.name ILIKE ${like}))` : sql``}
    ORDER BY ${order}
    LIMIT ${limit} OFFSET ${offset}
  `;
  const total = rows[0]?.total ?? 0;
  return { rows: rows.map(({ total: _t, ...r }) => r), total };
}

/** All completed videos newest-first, for the chronological /timeline. */
export async function getTimelineVideos(limit = 400): Promise<VideoCard[]> {
  return await sql<VideoCard[]>`
    SELECT v.youtube_id, v.title, v.duration_seconds, v.published_at, v.view_count, v.video_type,
      (SELECT count(*)::int FROM transcript_chunks tc WHERE tc.video_id = v.id) AS segment_count
    FROM videos v
    WHERE v.status = 'completed'
    ORDER BY v.published_at DESC NULLS LAST
    LIMIT ${limit}
  `;
}

export async function getArchiveStats(): Promise<ArchiveStats> {
  const [row] = await sql<{ videos: number; hours: number; chars: number; last_sync: string | null }[]>`
    SELECT
      (SELECT count(*)::int FROM videos WHERE status = 'completed') AS videos,
      (SELECT COALESCE(round(sum(duration_seconds) / 3600.0), 0)::int FROM videos WHERE status = 'completed') AS hours,
      (SELECT COALESCE(sum(char_length(COALESCE(cleaned_text, raw_text, ''))), 0)::bigint FROM transcripts) AS chars,
      (SELECT max(created_at) FROM videos) AS last_sync
  `;
  return {
    videos: row?.videos ?? 0,
    hours: row?.hours ?? 0,
    words: Math.round((Number(row?.chars ?? 0)) / 6),
    last_sync: row?.last_sync ?? null,
  };
}
