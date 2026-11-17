/**
 * Shared, contract-shaped data accessors for the REST API and MCP tools.
 * Server-only. Builds the handoff `video` / `segment` / `topic` atoms.
 */
import { sql } from "./db";
import { formatTimecode, isoDate } from "./format";
import { getTopicsWithCounts } from "./browse";
import { retrieveChunks } from "./retrieval";
import { decodeEntities } from "./text";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, clampInt } from "./limits";

const BASE = process.env.PUBLIC_BASE_URL || "https://thehosksaid.com";

export interface ApiSegment {
  segment_id: string;
  video_id: string; // youtube_id
  video_title: string;
  start: number | null;
  end: number | null;
  timestamp: string;
  text: string;
  similarity: number;
  url: string;
  /** Publication date of the segment's video (YYYY-MM-DD). Search results only. */
  published_at?: string | null;
  /** Ready-to-quote attribution: title, date, timestamp (when known) and link. Search results only. */
  citation?: string;
}

export interface ApiVideo {
  id: string; // youtube_id
  title: string;
  type: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  segment_count: number;
  view_count: number | null;
  cite_count: number;
  topics: string[];
  source_url: string;
  thumbnail_url: string | null;
  chapters: { t_seconds: number; title: string }[];
}

function deepLink(youtubeId: string, start: number | null): string {
  return `${BASE}/video/${youtubeId}${start != null ? `?t=${start}` : ""}`;
}

/**
 * Raw semantic search over segments (GET /api/search, search_segments tool).
 * Scope (video, date window) is applied in SQL before ranking; one site-funded
 * embedding per uncached query.
 */
export async function searchSegments(
  query: string,
  opts: { client: string; limit?: number; videoId?: string; from?: Date | null; to?: Date | null }
): Promise<ApiSegment[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT);
  const chunks = await retrieveChunks(
    query,
    { youtubeIds: opts.videoId ? [opts.videoId] : null, topicSlugs: null, from: opts.from ?? null, to: opts.to ?? null },
    opts.client,
    limit
  );
  return chunks.map((c) => {
    const title = decodeEntities(c.title);
    const date = isoDate(c.published_at);
    const url = deepLink(c.youtube_id, c.start_time);
    return {
      segment_id: c.id,
      video_id: c.youtube_id,
      video_title: title,
      start: c.start_time,
      end: c.end_time,
      timestamp: formatTimecode(c.start_time),
      text: decodeEntities(c.content),
      similarity: Math.round((c.similarity ?? 0) * 100),
      url,
      published_at: date,
      citation: `"${title}" (${date ?? "undated"})${c.start_time != null ? ` at ${formatTimecode(c.start_time)}` : ""}, ${url}`,
    };
  });
}

/** The handoff `video` atom (GET /api/videos/{id}, get_video tool). */
export async function getVideoApi(youtubeId: string): Promise<ApiVideo | null> {
  const [v] = await sql<{
    id: string; youtube_id: string; title: string; video_type: string | null;
    published_at: string | null; duration_seconds: number | null; view_count: number | null;
    thumbnail_url: string | null; chapters: { t_seconds: number; title: string }[] | null;
    segment_count: number; cite_count: number; topics: string[];
  }[]>`
    SELECT v.id, v.youtube_id, v.title, v.video_type, v.published_at, v.duration_seconds,
      v.view_count, v.thumbnail_url, v.chapters,
      (SELECT count(*)::int FROM transcript_chunks tc WHERE tc.video_id = v.id) AS segment_count,
      (SELECT count(*)::int FROM answers a, jsonb_array_elements(a.sources) s WHERE s->>'video_id' = v.youtube_id) AS cite_count,
      COALESCE((SELECT array_agg(t.name) FROM video_topics vt JOIN topics t ON t.id = vt.topic_id WHERE vt.video_id = v.id), '{}') AS topics
    FROM videos v
    WHERE v.youtube_id = ${youtubeId} AND v.status = 'completed'
    LIMIT 1
  `;
  if (!v) return null;
  return {
    id: v.youtube_id,
    title: decodeEntities(v.title),
    type: v.video_type,
    published_at: isoDate(v.published_at),
    duration_seconds: v.duration_seconds,
    segment_count: v.segment_count,
    view_count: v.view_count,
    cite_count: v.cite_count,
    topics: v.topics ?? [],
    source_url: `https://www.youtube.com/watch?v=${v.youtube_id}`,
    thumbnail_url: v.thumbnail_url,
    chapters: Array.isArray(v.chapters) ? v.chapters : [],
  };
}

/** Full transcript in segments | text | vtt (get_transcript tool). */
export async function getTranscriptApi(
  youtubeId: string,
  format: "segments" | "text" | "vtt" = "segments"
): Promise<{ video_id: string; format: string; content: unknown } | null> {
  const [v] = await sql<{ id: string }[]>`SELECT id FROM videos WHERE youtube_id = ${youtubeId} AND status='completed' LIMIT 1`;
  if (!v) return null;
  const rows = await sql<{ id: string; content: string; start_time: number | null; end_time: number | null }[]>`
    SELECT id, content, start_time, end_time FROM transcript_chunks WHERE video_id = ${v.id}
    ORDER BY start_time ASC NULLS LAST, id
  `;
  for (const r of rows) r.content = decodeEntities(r.content);
  if (format === "text") {
    return { video_id: youtubeId, format, content: rows.map((r) => r.content).join("\n\n") };
  }
  if (format === "vtt") {
    const cue = (s: number | null) => {
      const x = Math.max(0, Math.floor(s ?? 0));
      return `${String(Math.floor(x / 3600)).padStart(2, "0")}:${String(Math.floor((x % 3600) / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}.000`;
    };
    const body = rows
      .filter((r) => r.start_time != null)
      .map((r, i) => `${i + 1}\n${cue(r.start_time)} --> ${cue(r.end_time ?? (r.start_time ?? 0) + 5)}\n${r.content}`)
      .join("\n\n");
    return { video_id: youtubeId, format, content: `WEBVTT\n\n${body}` };
  }
  return {
    video_id: youtubeId,
    format,
    content: rows.map((r) => ({ segment_id: r.id, start: r.start_time, end: r.end_time, timestamp: formatTimecode(r.start_time), text: r.content })),
  };
}

/** A single segment + its neighbours + deep link (get_segment tool). */
export async function getSegmentApi(segmentId: string): Promise<{
  segment: ApiSegment; prev: ApiSegment | null; next: ApiSegment | null;
} | null> {
  const [c] = await sql<{ id: string; video_id: string; content: string; start_time: number | null; end_time: number | null }[]>`
    SELECT id, video_id, content, start_time, end_time FROM transcript_chunks WHERE id = ${segmentId} LIMIT 1
  `;
  if (!c) return null;
  const [v] = await sql<{ youtube_id: string; title: string }[]>`SELECT youtube_id, title FROM videos WHERE id = ${c.video_id} LIMIT 1`;
  if (!v) return null;

  const neighbours = await sql<{ id: string; content: string; start_time: number | null; end_time: number | null }[]>`
    (SELECT id, content, start_time, end_time FROM transcript_chunks
       WHERE video_id = ${c.video_id} AND start_time < ${c.start_time ?? 0} ORDER BY start_time DESC LIMIT 1)
    UNION ALL
    (SELECT id, content, start_time, end_time FROM transcript_chunks
       WHERE video_id = ${c.video_id} AND start_time > ${c.start_time ?? 0} ORDER BY start_time ASC LIMIT 1)
  `;
  const toSeg = (r: { id: string; content: string; start_time: number | null; end_time: number | null }): ApiSegment => ({
    segment_id: r.id, video_id: v.youtube_id, video_title: decodeEntities(v.title),
    start: r.start_time, end: r.end_time, timestamp: formatTimecode(r.start_time),
    text: decodeEntities(r.content), similarity: 0, url: deepLink(v.youtube_id, r.start_time),
  });
  const prev = neighbours.find((n) => (n.start_time ?? 0) < (c.start_time ?? 0)) ?? null;
  const next = neighbours.find((n) => (n.start_time ?? 0) > (c.start_time ?? 0)) ?? null;
  return { segment: toSeg(c), prev: prev ? toSeg(prev) : null, next: next ? toSeg(next) : null };
}

/** Paginated catalogue (GET /api/videos, list_videos tool). */
export async function listVideosApi(opts: {
  type?: string; topic?: string; sort?: string; cursor?: string; limit?: number;
}): Promise<{ items: ApiVideo[]; next_cursor: string | null }> {
  const limit = clampInt(opts.limit, 20, 1, 100);
  let offset = 0;
  if (opts.cursor) {
    const decoded = Buffer.from(opts.cursor, "base64").toString();
    offset = /^\d{1,7}$/.test(decoded) ? parseInt(decoded, 10) : 0;
  }
  const sort = (["recent", "cited", "viewed", "longest"] as const).find((x) => x === opts.sort) ?? "recent";
  const { getLibraryVideos } = await import("./browse");
  const { rows, total } = await getLibraryVideos({
    type: opts.type,
    topic: opts.topic,
    sort,
    limit,
    offset,
  });
  const items: ApiVideo[] = rows.map((r) => ({
    id: r.youtube_id,
    title: decodeEntities(r.title),
    type: r.video_type,
    published_at: isoDate(r.published_at),
    duration_seconds: r.duration_seconds,
    segment_count: r.segment_count,
    view_count: r.view_count,
    cite_count: r.cite_count,
    topics: [],
    source_url: `https://www.youtube.com/watch?v=${r.youtube_id}`,
    thumbnail_url: `https://i.ytimg.com/vi/${r.youtube_id}/mqdefault.jpg`,
    chapters: [],
  }));
  const nextOffset = offset + limit;
  return { items, next_cursor: nextOffset < total ? Buffer.from(String(nextOffset)).toString("base64") : null };
}

/** All clustered topics with counts (GET /api/topics, list_topics tool). */
export async function listTopicsApi() {
  const topics = await getTopicsWithCounts();
  return topics.map((t) => ({
    name: t.name,
    slug: t.slug,
    citation_count: t.citation_count,
    video_count: t.video_count,
    segment_count: t.segment_count,
    trend_pct: t.trend_pct,
  }));
}

export interface ApiKeywordHit {
  video_id: string; // youtube_id
  title: string;
  published_at: string | null;
  matched_in: "title" | "tag" | "transcript" | null;
  /** Plain-text transcript excerpt around the first match (transcript matches only). */
  snippet: string | null;
  /** Deep link; transcript matches open the video with its transcript search prefilled. */
  url: string;
  source_url: string;
  segment_count: number;
  /** False when the video has no embedded segments, so only keyword search reaches it. */
  semantic_search_available: boolean;
}

export const MAX_KEYWORD_QUERY = 200;

/**
 * Keyword search over titles, tags and full transcripts (Postgres full-text
 * search; the same query as /library). It makes no model call and spends no
 * embedding, so it works without any provider key or remaining allowance, and
 * it reaches videos that have no semantic segments.
 */
export async function keywordSearchApi(
  query: string,
  opts: { youtubeIds?: string[] | null; from?: Date | null; to?: Date | null; limit?: number; offset?: number }
): Promise<{ items: ApiKeywordHit[]; total: number; mode: "keyword"; model_calls: 0 }> {
  const q = query.trim().slice(0, MAX_KEYWORD_QUERY);
  const { getLibraryVideos } = await import("./browse");
  const { rows, total } = await getLibraryVideos({
    q,
    sort: "recent",
    limit: clampInt(opts.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT),
    offset: clampInt(opts.offset, 0, 0, 1000),
    youtubeIds: opts.youtubeIds ?? null,
    from: opts.from ?? null,
    to: opts.to ?? null,
  });
  return {
    items: rows.map((r) => ({
      video_id: r.youtube_id,
      title: decodeEntities(r.title),
      published_at: isoDate(r.published_at),
      matched_in: r.matched_in,
      snippet: r.snippet ? decodeEntities(r.snippet.replace(/[\u0001\u0002]/g, "")) : null,
      url: `${BASE}/video/${r.youtube_id}${r.matched_in === "transcript" ? `?q=${encodeURIComponent(q)}` : ""}`,
      source_url: `https://www.youtube.com/watch?v=${r.youtube_id}`,
      segment_count: r.segment_count,
      semantic_search_available: r.segment_count > 0,
    })),
    total,
    mode: "keyword",
    model_calls: 0,
  };
}
