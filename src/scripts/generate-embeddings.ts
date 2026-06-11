#!/usr/bin/env npx tsx
/**
 * Generate pgvector embeddings for any videos that don't yet have
 * transcript_chunks rows.
 *
 * Prefers the TIMED caption cues stored in transcripts.segments — grouping them
 * into ~CHUNK_SIZE windows that carry a start/end (seconds) so every chunk can
 * deep-link to its moment in the video. Falls back to char-windowing the cleaned
 * text (untimed) for videos ingested before segments were captured.
 */

import { config } from 'dotenv';
config(); // reads .env

import { sql, toVectorLiteral } from '../lib/db';
import { generateEmbedding } from '../lib/llm';

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 100;

function getArg(name: string): string | null {
    const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : null;
}

interface Chunk {
    text: string;
    start: number | null; // seconds
    end: number | null; // seconds
}

interface TimedSegment {
    text: string;
    offset: number; // ms
    duration: number; // ms
}

/** Char-window the text when no timed segments exist (untimed fallback). */
function splitText(text: string): Chunk[] {
    const chunks: Chunk[] = [];
    if (!text) return chunks;
    const normalized = text.replace(/\s+/g, ' ').trim();

    let start = 0;
    while (start < normalized.length) {
        let end = start + CHUNK_SIZE;
        if (end < normalized.length) {
            const boundary = normalized.slice(start, end + 50).lastIndexOf('.');
            if (boundary > CHUNK_SIZE * 0.8) end = start + boundary + 1;
        }
        chunks.push({ text: normalized.slice(start, end).trim(), start: null, end: null });
        start = end - CHUNK_OVERLAP;
    }
    return chunks;
}

/**
 * Coerce the stored `transcripts.segments` value into a timed-segment array.
 * Accepts a real jsonb array (correct, current writes) and also recovers from a
 * legacy jsonb *string* (double-encoded by an old `${JSON.stringify(x)}::jsonb`
 * pattern). Returns null when there are no usable timed segments.
 */
function normalizeSegments(value: TimedSegment[] | string | null | undefined): TimedSegment[] | null {
    let segs: unknown = value;
    if (typeof segs === 'string') {
        try { segs = JSON.parse(segs); } catch { return null; }
    }
    return Array.isArray(segs) && segs.length ? (segs as TimedSegment[]) : null;
}

/** Group timed caption cues into ~CHUNK_SIZE windows, carrying start/end seconds. */
function chunkSegments(segments: TimedSegment[]): Chunk[] {
    const out: Chunk[] = [];
    let text = '';
    let start: number | null = null;
    let end = 0;
    for (const seg of segments) {
        const t = (seg.text || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        if (start === null) start = Math.floor((seg.offset || 0) / 1000);
        text += (text ? ' ' : '') + t;
        end = Math.ceil(((seg.offset || 0) + (seg.duration || 0)) / 1000);
        if (text.length >= CHUNK_SIZE) {
            out.push({ text, start, end });
            text = '';
            start = null;
        }
    }
    if (text.trim() && start !== null) out.push({ text, start, end });
    return out;
}

async function generateEmbeddings() {
    const limit = parseInt(getArg('limit') || '10', 10);
    const videoIdArg = getArg('video');

    console.log(`🧠 Generating Semantic Embeddings (Limit: ${limit})...`);

    // Completed videos that have a transcript but no chunks yet.
    const videos = await sql<{
        id: string;
        title: string;
        cleaned_text: string | null;
        raw_text: string | null;
    }[]>`
        SELECT v.id, v.title, t.cleaned_text, t.raw_text
        FROM videos v
        JOIN transcripts t ON t.video_id = v.id
        WHERE v.status = 'completed'
          ${videoIdArg ? sql`AND v.id = ${videoIdArg}` : sql``}
          AND NOT EXISTS (SELECT 1 FROM transcript_chunks tc WHERE tc.video_id = v.id)
        ORDER BY v.published_at DESC NULLS LAST
        LIMIT ${limit}
    `;

    console.log(`Found ${videos.length} videos to check/process.`);
    let processedCount = 0;

    for (const video of videos) {
        // Prefer timed caption cues (gives each chunk a start/end for deep-links);
        // fall back to char-windowing the cleaned text. The segments fetch is
        // defensive so it works before the `segments` column migration is applied.
        let segments: TimedSegment[] | null = null;
        try {
            const [row] = await sql<{ segments: TimedSegment[] | string | null }[]>`
                SELECT segments FROM transcripts WHERE video_id = ${video.id}
            `;
            segments = normalizeSegments(row?.segments);
        } catch {
            segments = null; // column not present yet
        }

        let chunks: Chunk[];
        if (segments) {
            chunks = chunkSegments(segments);
        } else {
            const textToChunk = video.cleaned_text || video.raw_text;
            if (!textToChunk) {
                console.log(`   ⚠️  No text found for video: ${video.title}`);
                continue;
            }
            chunks = splitText(textToChunk);
        }

        console.log(
            `   🎬 Processing: ${video.title} (${chunks.length} chunks${segments ? ', timed' : ''})`
        );

        let inserted = 0;
        for (const chunk of chunks) {
            try {
                const embedding = await generateEmbedding(chunk.text);
                if (!embedding.length) continue;
                await sql`
                    INSERT INTO transcript_chunks (video_id, content, start_time, end_time, embedding)
                    VALUES (${video.id}, ${chunk.text}, ${chunk.start}, ${chunk.end}, ${toVectorLiteral(embedding)}::vector)
                `;
                inserted++;
            } catch (e) {
                console.error('      Embedding failed:', e);
            }
        }

        if (inserted > 0) {
            processedCount++;
            console.log(`      ✅ ${inserted} chunks saved${segments ? ' (timed)' : ''}.`);
        }
    }

    console.log(`\n✅ Finished embedding generation. New videos processed: ${processedCount}`);
    await sql.end({ timeout: 5 });
}

generateEmbeddings().catch(async (e) => {
    console.error('Fatal error:', e);
    await sql.end({ timeout: 5 });
    process.exit(1);
});
