#!/usr/bin/env npx tsx
/**
 * Ingestion script for HoskSaid — writes to the self-hosted Postgres
 * (via DATABASE_URL). Same CLI surface as the legacy Supabase version:
 *
 *   npx tsx src/scripts/ingest.ts --channel=UCiJiqEvUZxT6isIaXK7RXTg
 *   npx tsx src/scripts/ingest.ts --video=VIDEO_ID
 *   npx tsx src/scripts/ingest.ts --channel=... --limit=10 --skip-llm
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
// Compose also injects DATABASE_URL via env, so the file is optional.

import { sql } from '../lib/db';
import { getChannel, getChannelVideos, getVideo, parseDuration } from '../lib/youtube';
import { fetchTranscript } from '../lib/transcript';
import { transcribeWithWhisper } from '../lib/whisper';
import { processTranscript } from '../lib/llm';

// --- args ------------------------------------------------------------------

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : undefined;
};
const hasFlag = (name: string): boolean => args.includes(`--${name}`);

const channelId = getArg('channel');
const videoId = getArg('video');
const limit = parseInt(getArg('limit') || '0', 10);
const skipLlm = hasFlag('skip-llm');
const dryRun = hasFlag('dry-run');

if (!channelId && !videoId) {
    console.error('Usage: npx tsx src/scripts/ingest.ts --channel=CHANNEL_ID [--limit=N] [--skip-llm]');
    console.error('       npx tsx src/scripts/ingest.ts --video=VIDEO_ID [--skip-llm]');
    process.exit(1);
}

// --- DB helpers ------------------------------------------------------------

interface ChannelRow { id: string; youtube_id: string; name: string; }

async function ensureChannel(ytChannelId: string): Promise<ChannelRow> {
    const existing = await sql<ChannelRow[]>`
        SELECT id, youtube_id, name FROM channels WHERE youtube_id = ${ytChannelId} LIMIT 1
    `;
    if (existing[0]) {
        console.log(`📺 Using existing channel: ${existing[0].name}`);
        return existing[0];
    }

    console.log(`📺 Fetching channel info for ${ytChannelId}...`);
    const channelInfo = await getChannel(ytChannelId);
    if (!channelInfo) throw new Error(`Channel not found: ${ytChannelId}`);

    const [inserted] = await sql<ChannelRow[]>`
        INSERT INTO channels (youtube_id, name, description, thumbnail_url)
        VALUES (${channelInfo.id}, ${channelInfo.title},
                ${channelInfo.description ?? null}, ${channelInfo.thumbnailUrl ?? null})
        RETURNING id, youtube_id, name
    `;
    console.log(`✅ Created channel: ${channelInfo.title}`);
    return inserted;
}

async function logStep(
    videoDbId: string,
    step: string,
    status: string,
    details?: Record<string, unknown>
) {
    // jsonb cast on a JSON-stringified value sidesteps the driver's strict
    // JSONValue typing for the sql.json() helper.
    const detailsJson = details ? JSON.stringify(details) : null;
    await sql`
        INSERT INTO ingestion_logs (video_id, step, status, details)
        VALUES (${videoDbId}, ${step}, ${status}, ${detailsJson}::jsonb)
    `;
}

// --- per-video ingestion ---------------------------------------------------

async function ingestVideo(
    channelDbId: string,
    ytVideoId: string,
    skipLlmProcessing: boolean
): Promise<{ success?: boolean; skipped?: boolean; failed?: boolean; error?: string }> {
    console.log(`\n🎬 Processing video: ${ytVideoId}`);

    const existingRows = await sql<{ id: string; status: string }[]>`
        SELECT id, status FROM videos WHERE youtube_id = ${ytVideoId} LIMIT 1
    `;
    const existing = existingRows[0];

    if (existing?.status === 'completed') {
        console.log(`   ⏭️  Already processed, skipping`);
        return { skipped: true };
    }

    const videoInfo = await getVideo(ytVideoId);
    if (!videoInfo) {
        console.log(`   ❌ Video not found on YouTube`);
        return { failed: true, error: 'Video not found' };
    }

    console.log(`   📝 Title: ${videoInfo.title.slice(0, 60)}...`);

    let videoDbId: string;
    if (existing) {
        videoDbId = existing.id;
        await sql`UPDATE videos SET status = 'processing' WHERE id = ${videoDbId}`;
    } else {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO videos (
                channel_id, youtube_id, title, description, published_at,
                duration_seconds, thumbnail_url, view_count, status
            ) VALUES (
                ${channelDbId}, ${videoInfo.id}, ${videoInfo.title},
                ${videoInfo.description ?? null}, ${videoInfo.publishedAt ?? null},
                ${parseDuration(videoInfo.duration)}, ${videoInfo.thumbnailUrl ?? null},
                ${videoInfo.viewCount ?? null}, 'processing'
            ) RETURNING id
        `;
        videoDbId = row.id;
    }

    try {
        console.log(`   📄 Fetching transcript...`);
        await logStep(videoDbId, 'fetch_transcript', 'started');

        let transcriptResult = await fetchTranscript(ytVideoId);

        if (!transcriptResult) {
            console.log(`   ⚠️  No standard captions found. Attempting Whisper AI fallback...`);
            transcriptResult = await transcribeWithWhisper(ytVideoId);
        }

        if (!transcriptResult) {
            console.log(`   ❌  No transcript available (Captions missing & Whisper failed)`);
            await logStep(videoDbId, 'fetch_transcript', 'failed', { error: 'No transcript found' });
            await sql`UPDATE videos SET status = 'failed' WHERE id = ${videoDbId}`;
            return { failed: true, error: 'No transcript' };
        }

        console.log(`   ✅ Got transcript (${transcriptResult.text.length} chars) via ${transcriptResult.source}`);
        await logStep(videoDbId, 'fetch_transcript', 'completed', {
            source: transcriptResult.source,
            length: transcriptResult.text.length,
        });

        let cleanedText = transcriptResult.text;
        let summary = '';
        let tags: string[] = [];

        if (!skipLlmProcessing) {
            console.log(`   🤖 Processing with LLM...`);
            await logStep(videoDbId, 'llm_processing', 'started');
            try {
                const processed = await processTranscript(transcriptResult.text);
                cleanedText = processed.cleanedText;
                summary = processed.summary;
                tags = processed.tags;
                console.log(`   ✅ LLM processing complete (${tags.length} tags)`);
                await logStep(videoDbId, 'llm_processing', 'completed', { tags });
            } catch (llmError) {
                console.log(`   ⚠️  LLM processing failed, using raw transcript`);
                await logStep(videoDbId, 'llm_processing', 'failed', { error: String(llmError) });
            }
        } else {
            console.log(`   ⏭️  Skipping LLM processing`);
        }

        // Upsert transcript by unique video_id.
        await sql`
            INSERT INTO transcripts (
                video_id, raw_text, cleaned_text, summary, source, processing_status
            ) VALUES (
                ${videoDbId}, ${transcriptResult.text}, ${cleanedText},
                ${summary || null}, ${transcriptResult.source}, 'completed'
            )
            ON CONFLICT (video_id) DO UPDATE SET
                raw_text          = EXCLUDED.raw_text,
                cleaned_text      = EXCLUDED.cleaned_text,
                summary           = EXCLUDED.summary,
                source            = EXCLUDED.source,
                processing_status = EXCLUDED.processing_status
        `;

        if (tags.length > 0) {
            for (const tagName of tags) {
                const [tag] = await sql<{ id: string }[]>`
                    INSERT INTO tags (name) VALUES (${tagName.toLowerCase()})
                    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
                    RETURNING id
                `;
                if (tag) {
                    await sql`
                        INSERT INTO video_tags (video_id, tag_id)
                        VALUES (${videoDbId}, ${tag.id})
                        ON CONFLICT DO NOTHING
                    `;
                }
            }
        }

        await sql`UPDATE videos SET status = 'completed' WHERE id = ${videoDbId}`;
        console.log(`   ✅ Video processing complete!`);
        return { success: true };

    } catch (error) {
        console.error(`   ❌ Error processing video:`, error);
        await logStep(videoDbId, 'error', 'failed', { error: String(error) });
        await sql`UPDATE videos SET status = 'failed' WHERE id = ${videoDbId}`;
        return { failed: true, error: String(error) };
    }
}

// --- main ------------------------------------------------------------------

async function main() {
    console.log('🚀 HoskSaid Ingestion Script\n');
    if (dryRun) console.log('🔍 DRY RUN MODE - No changes will be made\n');

    const stats = { success: 0, skipped: 0, failed: 0 };

    if (videoId) {
        const video = await getVideo(videoId);
        if (!video) {
            console.error(`Video not found: ${videoId}`);
            process.exit(1);
        }
        const channel = await ensureChannel(video.channelId);
        const result = await ingestVideo(channel.id, videoId, skipLlm);
        if (result.success) stats.success++;
        else if (result.skipped) stats.skipped++;
        else stats.failed++;

    } else if (channelId) {
        const channel = await ensureChannel(channelId);
        console.log(`\n📥 Fetching videos from channel...`);

        let pageToken: string | undefined;
        let processedCount = 0;

        do {
            const result = await getChannelVideos(channelId, {
                maxResults: 50,
                pageToken,
            });

            console.log(`   Found ${result.videos.length} videos in this batch`);

            for (const video of result.videos) {
                if (limit > 0 && processedCount >= limit) {
                    console.log(`\n⏹️  Reached limit of ${limit} videos`);
                    break;
                }

                if (!dryRun) {
                    const ingestResult = await ingestVideo(channel.id, video.id, skipLlm);
                    if (ingestResult.success) stats.success++;
                    else if (ingestResult.skipped) stats.skipped++;
                    else stats.failed++;
                } else {
                    console.log(`   Would process: ${video.title.slice(0, 50)}...`);
                }
                processedCount++;
            }

            pageToken = result.nextPageToken;
            if (limit > 0 && processedCount >= limit) break;
        } while (pageToken);
    }

    console.log('\n📊 Ingestion Summary:');
    console.log(`   ✅ Success: ${stats.success}`);
    console.log(`   ⏭️  Skipped: ${stats.skipped}`);
    console.log(`   ❌ Failed: ${stats.failed}`);
    console.log('\n✨ Done!');

    await sql.end({ timeout: 5 });
}

main().catch(async (error) => {
    console.error('Fatal error:', error);
    await sql.end({ timeout: 5 });
    process.exit(1);
});
