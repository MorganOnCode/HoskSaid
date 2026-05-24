/**
 * Server-side search: semantic (pgvector), tag, and hybrid combinations.
 * All queries go through src/lib/db.ts; no @supabase/supabase-js anywhere.
 */

import { sql, toVectorLiteral, searchVideos, type VideoWithDetails } from './db';
import { generateEmbedding } from './llm';

interface SemanticResult {
    id: string;           // chunk id
    video_id: string;
    content: string;
    similarity: number;
}

/**
 * Vector similarity search via the match_transcript_chunks SQL function.
 * Returns the best matching chunks ordered by cosine similarity.
 */
export async function semanticSearch(
    query: string,
    limit: number = 20
): Promise<SemanticResult[]> {
    try {
        const embedding = await generateEmbedding(query);
        if (embedding.length === 0) return [];

        // The SQL function expects (vector(1536), float, int). We hand the
        // vector as a literal text + ::vector cast because the postgres
        // driver doesn't have a native vector codec.
        const vectorLit = toVectorLiteral(embedding);
        const rows = await sql<SemanticResult[]>`
            SELECT id, video_id, content, start_time, similarity
            FROM match_transcript_chunks(
                ${vectorLit}::vector,
                ${0.5}::float,
                ${limit}::int
            )
        `;
        return rows;
    } catch (e) {
        console.error('Semantic search failed:', e);
        return [];
    }
}

/**
 * Tag search: find videos whose tags contain `query` (substring, case-insensitive).
 * Mirrors the old Supabase fallbackTagSearch logic but in a single query.
 */
export async function tagSearch(
    query: string,
    limit: number = 20
): Promise<VideoWithDetails[]> {
    const like = `%${query}%`;
    return await sql<VideoWithDetails[]>`
        SELECT DISTINCT ON (v.id)
            v.*,
            to_jsonb(c) AS channel,
            CASE WHEN t.video_id IS NULL THEN NULL
                 ELSE jsonb_build_object(
                   'summary', t.summary,
                   'cleaned_text', t.cleaned_text
                 ) END AS transcript,
            COALESCE(
              (SELECT jsonb_agg(to_jsonb(tg2))
                 FROM video_tags vt2
                 JOIN tags tg2 ON tg2.id = vt2.tag_id
                WHERE vt2.video_id = v.id),
              '[]'::jsonb
            ) AS tags
        FROM videos v
        JOIN video_tags vt    ON vt.video_id = v.id
        JOIN tags tg          ON tg.id       = vt.tag_id
        LEFT JOIN channels c    ON c.id       = v.channel_id
        LEFT JOIN transcripts t ON t.video_id = v.id
        WHERE v.status = 'completed'
          AND tg.name ILIKE ${like}
        ORDER BY v.id, v.published_at DESC
        LIMIT ${limit}
    `;
}

/**
 * Combine tag + semantic + keyword search, dedupe by video id.
 * Preserves the old result ordering: tag matches first, then semantic, then keyword.
 */
export async function hybridSearch(
    query: string,
    limit: number = 20
): Promise<VideoWithDetails[]> {
    const [semanticResults, keywordResults, tagResults] = await Promise.all([
        semanticSearch(query, limit),
        searchVideos(query, { limit }),
        tagSearch(query, limit),
    ]);

    // Resolve semantic chunk IDs back to full video records and attach the
    // best matching chunk as the transcript snippet.
    let semanticVideos: VideoWithDetails[] = [];
    const semanticVideoIds = Array.from(new Set(semanticResults.map(r => r.video_id)));

    if (semanticVideoIds.length > 0) {
        const rows = await sql<VideoWithDetails[]>`
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
            FROM videos v
            LEFT JOIN channels c    ON c.id       = v.channel_id
            LEFT JOIN transcripts t ON t.video_id = v.id
            WHERE v.id = ANY(${semanticVideoIds}::uuid[])
              AND v.status = 'completed'
        `;

        semanticVideos = rows.map(video => {
            const bestChunk = semanticResults.find(r => r.video_id === video.id);
            return {
                ...video,
                transcript: {
                    ...(video.transcript || {}),
                    cleaned_text: bestChunk
                        ? bestChunk.content
                        : video.transcript?.cleaned_text,
                },
            };
        });
    }

    // Merge in priority order, dedupe by id.
    const seen = new Set<string>();
    const merged: VideoWithDetails[] = [];
    for (const v of [...tagResults, ...semanticVideos, ...keywordResults]) {
        if (!seen.has(v.id)) {
            seen.add(v.id);
            merged.push(v);
        }
    }
    return merged.slice(0, limit);
}
