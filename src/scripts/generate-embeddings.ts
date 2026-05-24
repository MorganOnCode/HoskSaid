#!/usr/bin/env npx tsx
/**
 * Generate pgvector embeddings for any videos that don't yet have
 * transcript_chunks rows. Reads transcripts.cleaned_text (falling back
 * to raw_text), splits into ~1000-char chunks with overlap, embeds each
 * chunk via OpenAI, and writes to transcript_chunks.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { sql, toVectorLiteral } from '../lib/db';
import { generateEmbedding } from '../lib/llm';

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 100;

function getArg(name: string): string | null {
    const arg = process.argv.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : null;
}

function splitText(text: string): string[] {
    const chunks: string[] = [];
    if (!text) return chunks;
    const normalized = text.replace(/\s+/g, ' ').trim();

    let start = 0;
    while (start < normalized.length) {
        let end = start + CHUNK_SIZE;
        if (end < normalized.length) {
            const boundary = normalized.slice(start, end + 50).lastIndexOf('.');
            if (boundary > CHUNK_SIZE * 0.8) {
                end = start + boundary + 1;
            }
        }
        chunks.push(normalized.slice(start, end).trim());
        start = end - CHUNK_OVERLAP;
    }
    return chunks;
}

async function generateEmbeddings() {
    const limit = parseInt(getArg('limit') || '10', 10);
    const videoIdArg = getArg('video');

    console.log(`🧠 Generating Semantic Embeddings (Limit: ${limit})...`);

    const videos = await sql<{
        id: string;
        title: string;
        cleaned_text: string | null;
        raw_text: string | null;
    }[]>`
        SELECT v.id,
               v.title,
               t.cleaned_text,
               t.raw_text
        FROM videos v
        JOIN transcripts t ON t.video_id = v.id
        WHERE v.status = 'completed'
          ${videoIdArg ? sql`AND v.id = ${videoIdArg}` : sql``}
          AND NOT EXISTS (
              SELECT 1 FROM transcript_chunks tc WHERE tc.video_id = v.id
          )
        ORDER BY v.published_at DESC NULLS LAST
        LIMIT ${limit}
    `;

    console.log(`Found ${videos.length} videos to check/process.`);
    let processedCount = 0;

    for (const video of videos) {
        const textToChunk = video.cleaned_text || video.raw_text;
        if (!textToChunk) {
            console.log(`   ⚠️  No text found for video: ${video.title}`);
            continue;
        }

        console.log(`   🎬 Processing: ${video.title} (${textToChunk.length} chars)`);
        const chunks = splitText(textToChunk);
        console.log(`      Generated ${chunks.length} chunks.`);

        let chunkSuccess = 0;
        for (const chunkContent of chunks) {
            try {
                const embedding = await generateEmbedding(chunkContent);
                const vectorLit = toVectorLiteral(embedding);
                await sql`
                    INSERT INTO transcript_chunks (video_id, content, embedding)
                    VALUES (${video.id}, ${chunkContent}, ${vectorLit}::vector)
                `;
                chunkSuccess++;
            } catch (e) {
                console.error('      Embedding failed:', e);
            }
        }

        if (chunkSuccess > 0) {
            processedCount++;
            console.log(`      ✅ ${chunkSuccess}/${chunks.length} chunks saved.`);
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
