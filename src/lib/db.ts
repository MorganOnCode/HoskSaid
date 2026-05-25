/**
 * Postgres adapter — replaces @supabase/supabase-js end-to-end.
 *
 * The app talks to a self-hosted Postgres (pgvector image) over the
 * DATABASE_URL connection string. Three reasons to use porsager/postgres
 * over `pg`:
 *  - Tagged-template parameterisation handles JSON / arrays cleanly.
 *  - Single global pool, lazy-connected, no boilerplate.
 *  - Built-in support for jsonb → JS object round-tripping (we lean on
 *    this heavily in getVideos to mimic Supabase's nested-relation
 *    selects without N+1 queries).
 *
 * The exported helpers preserve the *behaviour* of the old supabase.ts
 * helpers (same return shapes, same filtering semantics) but drop the
 * `client` parameter — callers no longer have to construct one.
 */

import postgres from "postgres";
import pgvector from "pgvector/utils";

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

// DATABASE_URL is required at request time, not at module-init time, because
// Next collects route metadata at build time when env isn't populated. We
// proxy the postgres client so the first real query is what triggers the
// connect (and the env check), not `import './db'`.
declare global {
    // eslint-disable-next-line no-var
    var __hosksaidPg: ReturnType<typeof postgres> | undefined;
}

function buildSql(): ReturnType<typeof postgres> {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error(
            "DATABASE_URL is not set. Configure it via docker-compose or .env."
        );
    }
    return postgres(connectionString, {
        max: 10,                    // conservative pool for a small VPS
        idle_timeout: 30,
        connect_timeout: 10,
        prepare: false,             // pgbouncer-friendly + faster cold start
    });
}

function getSql(): ReturnType<typeof postgres> {
    if (!globalThis.__hosksaidPg) {
        globalThis.__hosksaidPg = buildSql();
    }
    return globalThis.__hosksaidPg;
}

// Proxy so callers can use `sql\`...\`` as if it were the postgres tag,
// but the underlying client is constructed lazily on first invocation.
export const sql = new Proxy(
    function () { /* placeholder, never called directly */ } as unknown as ReturnType<typeof postgres>,
    {
        apply(_target, _thisArg, argArray) {
            // tagged template: sql`SELECT ...`
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (getSql() as any).apply(null, argArray);
        },
        get(_target, prop) {
            // method access: sql.end(), sql.json(), sql.begin()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (getSql() as any)[prop];
        },
    }
);

// ---------------------------------------------------------------------------
// Types (mirror the old supabase.ts exports — kept identical so importers
// don't have to change anything but the import path)
// ---------------------------------------------------------------------------

export interface Channel {
    id: string;
    youtube_id: string;
    name: string;
    description?: string;
    thumbnail_url?: string;
    created_at: string;
    updated_at: string;
}

export interface Video {
    id: string;
    channel_id: string;
    youtube_id: string;
    title: string;
    description?: string;
    published_at?: string;
    duration_seconds?: number;
    thumbnail_url?: string;
    view_count?: number;
    status: "pending" | "processing" | "completed" | "failed";
    created_at: string;
    updated_at: string;
}

export interface Transcript {
    id: string;
    video_id: string;
    raw_text?: string;
    cleaned_text?: string;
    summary?: string;
    source?: "youtube_captions" | "extractor" | "whisper";
    processing_status: "pending" | "processing" | "completed" | "failed";
    error_message?: string;
    created_at: string;
    updated_at: string;
}

export interface Tag {
    id: string;
    name: string;
    created_at: string;
}

export interface VideoWithDetails extends Video {
    channel?: Channel;
    transcript?: Partial<Transcript>;
    tags?: Tag[];
}

export interface ErrorReport {
    id: string;
    video_id: string;
    error_type: "typo" | "missing_content" | "wrong_speaker" | "other";
    description: string;
    timestamp_seconds?: number;
    status: "pending" | "reviewed" | "fixed" | "dismissed";
    created_at: string;
}

// ---------------------------------------------------------------------------
// pgvector helpers
// ---------------------------------------------------------------------------

/** Serialise a JS number[] embedding for use in a parameterised SQL value. */
export function toVectorLiteral(arr: number[]): string {
    // pgvector wire format: '[1.0,2.0,...]'. Cast in SQL with ::vector.
    return pgvector.toSql(arr);
}

// ---------------------------------------------------------------------------
// App helpers (used by Next pages + /api routes)
// ---------------------------------------------------------------------------

/**
 * Paginated video list. Mirrors Supabase's nested-select shape:
 *   { ...video, channel, transcript: { summary }, tags: Tag[] }
 *
 * Implemented as a single query with json_agg to avoid the N+1 fan-out
 * Supabase hides behind its PostgREST relation syntax.
 */
export async function getVideos(options: {
    limit?: number;
    offset?: number;
    channelId?: string;
} = {}): Promise<VideoWithDetails[]> {
    const { limit = 20, offset = 0, channelId } = options;

    const rows = await sql<VideoWithDetails[]>`
        SELECT
            v.*,
            to_jsonb(c)        AS channel,
            CASE WHEN t.video_id IS NULL THEN NULL
                 ELSE jsonb_build_object('summary', t.summary) END AS transcript,
            COALESCE(
              (SELECT jsonb_agg(to_jsonb(tg))
                 FROM video_tags vt
                 JOIN tags tg ON tg.id = vt.tag_id
                WHERE vt.video_id = v.id),
              '[]'::jsonb
            ) AS tags
        FROM videos v
        LEFT JOIN channels c   ON c.id        = v.channel_id
        LEFT JOIN transcripts t ON t.video_id = v.id
        WHERE v.status = 'completed'
          ${channelId ? sql`AND v.channel_id = ${channelId}` : sql``}
        ORDER BY v.published_at DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
    `;
    return rows;
}

/**
 * Single video by YouTube ID, with full transcript (not just summary) and tags.
 * Returns null if not found or not completed — matches the Supabase
 * PGRST116-handling semantics.
 */
export async function getVideoByYoutubeId(
    youtubeId: string
): Promise<VideoWithDetails | null> {
    const rows = await sql<VideoWithDetails[]>`
        SELECT
            v.*,
            to_jsonb(c) AS channel,
            to_jsonb(t) AS transcript,
            COALESCE(
              (SELECT jsonb_agg(to_jsonb(tg))
                 FROM video_tags vt
                 JOIN tags tg ON tg.id = vt.tag_id
                WHERE vt.video_id = v.id),
              '[]'::jsonb
            ) AS tags
        FROM videos v
        LEFT JOIN channels c    ON c.id       = v.channel_id
        LEFT JOIN transcripts t ON t.video_id = v.id
        WHERE v.youtube_id = ${youtubeId}
          AND v.status     = 'completed'
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Keyword search across video metadata + transcript full-text. Mirrors the
 * Supabase implementation's two-pronged approach (ILIKE on title/description,
 * tsvector match on transcript raw_text), unions the results, dedupes, and
 * orders by published_at DESC. Same limit/offset semantics.
 */
export async function searchVideos(
    query: string,
    options: { limit?: number; offset?: number } = {}
): Promise<VideoWithDetails[]> {
    const { limit = 20, offset = 0 } = options;
    const q = query.trim();
    if (!q) return [];

    // websearch_to_tsquery handles OR/quoting/negation safely. Match the
    // old behaviour of splitting words and OR-ing them by passing the
    // raw user string — websearch operator handles bare words as AND by
    // default, but we accept that as the correct behaviour for "research"
    // queries. (The old code OR-joined with `|` and used Supabase's
    // websearch config; the practical result for most queries is the same.)
    const like = `%${q}%`;

    const rows = await sql<VideoWithDetails[]>`
        WITH metadata_hits AS (
            SELECT v.id
            FROM videos v
            WHERE v.status = 'completed'
              AND (v.title ILIKE ${like} OR v.description ILIKE ${like})
        ),
        transcript_hits AS (
            SELECT t.video_id AS id
            FROM transcripts t
            JOIN videos v ON v.id = t.video_id AND v.status = 'completed'
            WHERE to_tsvector('english', COALESCE(t.raw_text, ''))
                  @@ websearch_to_tsquery('english', ${q})
        ),
        hits AS (
            SELECT id FROM metadata_hits
            UNION
            SELECT id FROM transcript_hits
        )
        SELECT
            v.*,
            to_jsonb(c) AS channel,
            CASE WHEN t.video_id IS NULL THEN NULL
                 ELSE jsonb_build_object(
                   'summary', t.summary,
                   'cleaned_text', t.cleaned_text
                 ) END AS transcript,
            COALESCE(
              (SELECT jsonb_agg(to_jsonb(tg))
                 FROM video_tags vt
                 JOIN tags tg ON tg.id = vt.tag_id
                WHERE vt.video_id = v.id),
              '[]'::jsonb
            ) AS tags
        FROM hits
        JOIN videos v          ON v.id        = hits.id
        LEFT JOIN channels c    ON c.id       = v.channel_id
        LEFT JOIN transcripts t ON t.video_id = v.id
        ORDER BY v.published_at DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
    `;
    return rows;
}

/** Insert a user error report; returns the inserted row. */
export async function submitErrorReport(report: {
    video_id: string;
    error_type: ErrorReport["error_type"];
    description: string;
    timestamp_seconds?: number;
}): Promise<ErrorReport> {
    const [row] = await sql<ErrorReport[]>`
        INSERT INTO error_reports
            (video_id, error_type, description, timestamp_seconds)
        VALUES
            (${report.video_id},
             ${report.error_type},
             ${report.description},
             ${report.timestamp_seconds ?? null})
        RETURNING *
    `;
    return row;
}

/** All tags, alphabetical. */
export async function getAllTags(): Promise<Tag[]> {
    return await sql<Tag[]>`SELECT * FROM tags ORDER BY name`;
}
