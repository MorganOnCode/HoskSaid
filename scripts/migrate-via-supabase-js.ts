#!/usr/bin/env tsx
/**
 * One-shot data migration: Supabase → local Postgres, talking to PostgREST
 * directly via the built-in fetch (no @supabase/supabase-js install).
 *
 * Why this path:
 *  - The VPS has no working outbound IPv6, and Supabase's direct DB
 *    endpoint is IPv6-only on the free plan.
 *  - The Transaction-mode pooler is the only IPv4 option, and pg_dump
 *    can't talk to a transaction-pooled connection.
 *  - PostgREST over HTTPS works fine over IPv4. The service-role key we
 *    already have grants full read access. fetch + Range header gives us
 *    paged exports with zero deps.
 *
 * Idempotent: local tables are TRUNCATEd before insert.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { sql, toVectorLiteral } from '../src/lib/db';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
}

const REST = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const HEADERS: Record<string, string> = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Accept-Profile': 'public',
};

const PAGE_SIZE = 500;          // PostgREST hard caps at 1000; 500 is safe
const CHUNK_PAGE_SIZE = 50;     // transcript_chunks rows are big (1536-dim vectors)

/** Fetch every row of a public.<table>, paged via the Range header. */
async function fetchAll<T = Record<string, unknown>>(
    table: string,
    pageSize = PAGE_SIZE
): Promise<T[]> {
    const out: T[] = [];
    let from = 0;
    while (true) {
        const url = `${REST}/${table}?select=*`;
        const res = await fetch(url, {
            headers: {
                ...HEADERS,
                Range: `${from}-${from + pageSize - 1}`,
                Prefer: 'count=exact',
            },
        });
        if (!res.ok) {
            throw new Error(`fetch ${table} [${from}..]: ${res.status} ${await res.text()}`);
        }
        const page = (await res.json()) as T[];
        out.push(...page);
        process.stdout.write(`  ${table}: ${out.length}\r`);
        if (page.length < pageSize) break;
        from += pageSize;
    }
    process.stdout.write(`  ${table}: ${out.length}\n`);
    return out;
}

async function main() {
    console.log('Wiping local tables...');
    await sql`TRUNCATE ingestion_logs, error_reports, transcript_chunks,
              video_tags, transcripts, videos, channels, tags
              RESTART IDENTITY CASCADE`;

    console.log('\nFetching from Supabase:');
    const channels      = await fetchAll('channels');
    const videos        = await fetchAll('videos');
    const transcripts   = await fetchAll('transcripts');
    const tags          = await fetchAll('tags');
    const videoTags     = await fetchAll('video_tags');
    const chunks        = await fetchAll('transcript_chunks', CHUNK_PAGE_SIZE);
    const errorReports  = await fetchAll('error_reports');
    const ingestionLogs = await fetchAll('ingestion_logs');

    console.log('\nInserting into local Postgres:');

    for (const c of channels as Record<string, unknown>[]) {
        await sql`
            INSERT INTO channels (id, youtube_id, name, description, thumbnail_url, created_at, updated_at)
            VALUES (${c.id as string}, ${c.youtube_id as string}, ${c.name as string},
                    ${(c.description as string) ?? null},
                    ${(c.thumbnail_url as string) ?? null},
                    ${(c.created_at as string) ?? null},
                    ${(c.updated_at as string) ?? null})
        `;
    }
    console.log(`  channels:          ${channels.length}`);

    for (const v of videos as Record<string, unknown>[]) {
        await sql`
            INSERT INTO videos (id, channel_id, youtube_id, title, description, published_at,
                                duration_seconds, thumbnail_url, view_count, status,
                                created_at, updated_at)
            VALUES (${v.id as string}, ${(v.channel_id as string) ?? null},
                    ${v.youtube_id as string}, ${v.title as string},
                    ${(v.description as string) ?? null},
                    ${(v.published_at as string) ?? null},
                    ${(v.duration_seconds as number) ?? null},
                    ${(v.thumbnail_url as string) ?? null},
                    ${(v.view_count as number) ?? null},
                    ${(v.status as string) ?? 'pending'},
                    ${(v.created_at as string) ?? null},
                    ${(v.updated_at as string) ?? null})
        `;
    }
    console.log(`  videos:            ${videos.length}`);

    for (const t of tags as Record<string, unknown>[]) {
        await sql`
            INSERT INTO tags (id, name, created_at)
            VALUES (${t.id as string}, ${t.name as string}, ${(t.created_at as string) ?? null})
        `;
    }
    console.log(`  tags:              ${tags.length}`);

    for (const t of transcripts as Record<string, unknown>[]) {
        await sql`
            INSERT INTO transcripts (id, video_id, raw_text, cleaned_text, summary, source,
                                     processing_status, error_message, created_at, updated_at)
            VALUES (${t.id as string}, ${(t.video_id as string) ?? null},
                    ${(t.raw_text as string) ?? null},
                    ${(t.cleaned_text as string) ?? null},
                    ${(t.summary as string) ?? null},
                    ${(t.source as string) ?? null},
                    ${(t.processing_status as string) ?? 'pending'},
                    ${(t.error_message as string) ?? null},
                    ${(t.created_at as string) ?? null},
                    ${(t.updated_at as string) ?? null})
        `;
    }
    console.log(`  transcripts:       ${transcripts.length}`);

    for (const vt of videoTags as Record<string, unknown>[]) {
        await sql`
            INSERT INTO video_tags (video_id, tag_id)
            VALUES (${vt.video_id as string}, ${vt.tag_id as string})
            ON CONFLICT DO NOTHING
        `;
    }
    console.log(`  video_tags:        ${videoTags.length}`);

    // transcript_chunks: PostgREST returns vector columns as either a JSON
    // array of numbers (newer pgvector versions) or as the pgvector text
    // literal '[0.1,0.2,...]'. Handle both; cast to ::vector in SQL.
    for (const c of chunks as Record<string, unknown>[]) {
        let embeddingLit = '[]';
        const e = c.embedding;
        if (Array.isArray(e)) embeddingLit = toVectorLiteral(e as number[]);
        else if (typeof e === 'string') embeddingLit = e;
        await sql`
            INSERT INTO transcript_chunks (id, video_id, content, start_time, end_time, embedding, created_at)
            VALUES (${c.id as string}, ${(c.video_id as string) ?? null},
                    ${c.content as string},
                    ${(c.start_time as number) ?? null},
                    ${(c.end_time as number) ?? null},
                    ${embeddingLit}::vector,
                    ${(c.created_at as string) ?? null})
        `;
    }
    console.log(`  transcript_chunks: ${chunks.length}`);

    for (const r of errorReports as Record<string, unknown>[]) {
        await sql`
            INSERT INTO error_reports (id, video_id, error_type, description, timestamp_seconds, status, created_at)
            VALUES (${r.id as string}, ${(r.video_id as string) ?? null},
                    ${r.error_type as string}, ${r.description as string},
                    ${(r.timestamp_seconds as number) ?? null},
                    ${(r.status as string) ?? 'pending'},
                    ${(r.created_at as string) ?? null})
        `;
    }
    console.log(`  error_reports:     ${errorReports.length}`);

    for (const l of ingestionLogs as Record<string, unknown>[]) {
        const detailsJson = l.details == null ? null : JSON.stringify(l.details);
        await sql`
            INSERT INTO ingestion_logs (id, video_id, step, status, details, created_at)
            VALUES (${l.id as string}, ${(l.video_id as string) ?? null},
                    ${l.step as string}, ${l.status as string},
                    ${detailsJson}::jsonb,
                    ${(l.created_at as string) ?? null})
        `;
    }
    console.log(`  ingestion_logs:    ${ingestionLogs.length}`);

    console.log('\nDone.');
    await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
    console.error('FAIL:', e);
    await sql.end({ timeout: 5 });
    process.exit(1);
});
