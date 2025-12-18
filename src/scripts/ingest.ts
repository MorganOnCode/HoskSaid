#!/usr/bin/env npx tsx
/**
 * Ingestion Script for HoskSaid
 * 
 * Usage:
 *   npx tsx src/scripts/ingest.ts --channel=UCiJiqEvUZxT6isIaXK7RXTg
 *   npx tsx src/scripts/ingest.ts --video=VIDEO_ID
 *   npx tsx src/scripts/ingest.ts --channel=UCiJiqEvUZxT6isIaXK7RXTg --limit=10
 *   npx tsx src/scripts/ingest.ts --channel=UCiJiqEvUZxT6isIaXK7RXTg --skip-llm
 */

import { createClient } from '@supabase/supabase-js';
import { getChannel, getChannelVideos, getVideo, parseDuration } from '../lib/youtube';
import { fetchTranscript } from '../lib/transcript';
import { transcribeWithWhisper } from '../lib/whisper';
import { processTranscript } from '../lib/llm';

// Load environment variables
import { config } from 'dotenv';
config({ path: '.env.local' });

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
    const arg = args.find((a) => a.startsWith(`--${name}=`));
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

// Initialize Supabase client
function getSupabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
        throw new Error('Missing Supabase environment variables. Check .env.local');
    }

    return createClient(url, key);
}

async function ensureChannel(supabase: ReturnType<typeof getSupabase>, ytChannelId: string) {
    // Check if channel exists
    const { data: existing } = await supabase
        .from('channels')
        .select('*')
        .eq('youtube_id', ytChannelId)
        .single();

    if (existing) {
        console.log(`📺 Using existing channel: ${existing.name}`);
        return existing;
    }

    // Fetch channel info from YouTube
    console.log(`📺 Fetching channel info for ${ytChannelId}...`);
    const channelInfo = await getChannel(ytChannelId);

    if (!channelInfo) {
        throw new Error(`Channel not found: ${ytChannelId}`);
    }

    // Insert channel
    const { data: newChannel, error } = await supabase
        .from('channels')
        .insert({
            youtube_id: channelInfo.id,
            name: channelInfo.title,
            description: channelInfo.description,
            thumbnail_url: channelInfo.thumbnailUrl,
        })
        .select()
        .single();

    if (error) throw error;

    console.log(`✅ Created channel: ${channelInfo.title}`);
    return newChannel;
}

async function ingestVideo(
    supabase: ReturnType<typeof getSupabase>,
    channelDbId: string,
    ytVideoId: string,
    skipLlmProcessing: boolean
) {
    console.log(`\n🎬 Processing video: ${ytVideoId}`);

    // Check if video already exists
    const { data: existing } = await supabase
        .from('videos')
        .select('id, status')
        .eq('youtube_id', ytVideoId)
        .single();

    if (existing?.status === 'completed') {
        console.log(`   ⏭️  Already processed, skipping`);
        return { skipped: true };
    }

    // Fetch video metadata from YouTube
    const videoInfo = await getVideo(ytVideoId);
    if (!videoInfo) {
        console.log(`   ❌ Video not found on YouTube`);
        return { failed: true, error: 'Video not found' };
    }

    console.log(`   📝 Title: ${videoInfo.title.slice(0, 60)}...`);

    // Insert or update video
    let videoDbId: string;
    if (existing) {
        videoDbId = existing.id;
        await supabase
            .from('videos')
            .update({ status: 'processing' })
            .eq('id', videoDbId);
    } else {
        const { data: newVideo, error } = await supabase
            .from('videos')
            .insert({
                channel_id: channelDbId,
                youtube_id: videoInfo.id,
                title: videoInfo.title,
                description: videoInfo.description,
                published_at: videoInfo.publishedAt,
                duration_seconds: parseDuration(videoInfo.duration),
                thumbnail_url: videoInfo.thumbnailUrl,
                view_count: videoInfo.viewCount,
                status: 'processing',
            })
            .select()
            .single();

        if (error) throw error;
        videoDbId = newVideo.id;
    }

    // Log ingestion step
    const log = async (step: string, status: string, details?: object) => {
        await supabase.from('ingestion_logs').insert({
            video_id: videoDbId,
            step,
            status,
            details,
        });
    };

    try {
        // Fetch transcript
        console.log(`   📄 Fetching transcript...`);
        await log('fetch_transcript', 'started');

        let transcriptResult = await fetchTranscript(ytVideoId);

        // Fallback to Whisper if not found
        if (!transcriptResult) {
            console.log(`   ⚠️  No standard captions found. Attempting Whisper AI fallback...`);
            transcriptResult = await transcribeWithWhisper(ytVideoId);
        }

        if (!transcriptResult) {
            console.log(`   ❌  No transcript available (Captions missing & Whisper failed)`);
            await log('fetch_transcript', 'failed', { error: 'No transcript found' });

            await supabase
                .from('videos')
                .update({ status: 'failed' })
                .eq('id', videoDbId);

            return { failed: true, error: 'No transcript' };
        }

        console.log(`   ✅ Got transcript (${transcriptResult.text.length} chars) via ${transcriptResult.source}`);
        await log('fetch_transcript', 'completed', {
            source: transcriptResult.source,
            length: transcriptResult.text.length
        });

        // Process with LLM (or skip)
        let cleanedText = transcriptResult.text;
        let summary = '';
        let tags: string[] = [];

        if (!skipLlmProcessing) {
            console.log(`   🤖 Processing with LLM...`);
            await log('llm_processing', 'started');

            try {
                const processed = await processTranscript(transcriptResult.text);
                cleanedText = processed.cleanedText;
                summary = processed.summary;
                tags = processed.tags;

                console.log(`   ✅ LLM processing complete (${tags.length} tags)`);
                await log('llm_processing', 'completed', { tags });
            } catch (llmError) {
                console.log(`   ⚠️  LLM processing failed, using raw transcript`);
                await log('llm_processing', 'failed', { error: String(llmError) });
                // Continue with raw transcript
            }
        } else {
            console.log(`   ⏭️  Skipping LLM processing`);
        }

        // Save transcript
        await supabase.from('transcripts').upsert({
            video_id: videoDbId,
            raw_text: transcriptResult.text,
            cleaned_text: cleanedText,
            summary: summary || null,
            source: transcriptResult.source,
            processing_status: 'completed',
        });

        // Save tags
        if (tags.length > 0) {
            for (const tagName of tags) {
                // Upsert tag
                const { data: tag } = await supabase
                    .from('tags')
                    .upsert({ name: tagName.toLowerCase() }, { onConflict: 'name' })
                    .select()
                    .single();

                if (tag) {
                    // Link tag to video
                    await supabase
                        .from('video_tags')
                        .upsert({ video_id: videoDbId, tag_id: tag.id });
                }
            }
        }

        // Mark video as completed
        await supabase
            .from('videos')
            .update({ status: 'completed' })
            .eq('id', videoDbId);

        console.log(`   ✅ Video processing complete!`);
        return { success: true };

    } catch (error) {
        console.error(`   ❌ Error processing video:`, error);
        await log('error', 'failed', { error: String(error) });

        await supabase
            .from('videos')
            .update({ status: 'failed' })
            .eq('id', videoDbId);

        return { failed: true, error: String(error) };
    }
}

async function main() {
    console.log('🚀 HoskSaid Ingestion Script\n');

    if (dryRun) {
        console.log('🔍 DRY RUN MODE - No changes will be made\n');
    }

    const supabase = getSupabase();

    const stats = { success: 0, skipped: 0, failed: 0 };

    if (videoId) {
        // Single video mode
        const video = await getVideo(videoId);
        if (!video) {
            console.error(`Video not found: ${videoId}`);
            process.exit(1);
        }

        const channel = await ensureChannel(supabase, video.channelId);
        const result = await ingestVideo(supabase, channel.id, videoId, skipLlm);

        if (result.success) stats.success++;
        else if (result.skipped) stats.skipped++;
        else stats.failed++;

    } else if (channelId) {
        // Channel mode - fetch all videos
        const channel = await ensureChannel(supabase, channelId);

        console.log(`\n📥 Fetching videos from channel...`);

        let pageToken: string | undefined;
        let processedCount = 0;

        do {
            const result = await getChannelVideos(channelId, {
                maxResults: 50,
                pageToken
            });

            console.log(`   Found ${result.videos.length} videos in this batch`);

            for (const video of result.videos) {
                if (limit > 0 && processedCount >= limit) {
                    console.log(`\n⏹️  Reached limit of ${limit} videos`);
                    break;
                }

                if (!dryRun) {
                    const ingestResult = await ingestVideo(supabase, channel.id, video.id, skipLlm);
                    if (ingestResult.success) stats.success++;
                    else if (ingestResult.skipped) stats.skipped++;
                    else stats.failed++;
                } else {
                    console.log(`   Would process: ${video.title.slice(0, 50)}...`);
                }

                processedCount++;
            }

            pageToken = result.nextPageToken;

            // Check limit
            if (limit > 0 && processedCount >= limit) break;

        } while (pageToken);
    }

    console.log('\n📊 Ingestion Summary:');
    console.log(`   ✅ Success: ${stats.success}`);
    console.log(`   ⏭️  Skipped: ${stats.skipped}`);
    console.log(`   ❌ Failed: ${stats.failed}`);
    console.log('\n✨ Done!');
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
