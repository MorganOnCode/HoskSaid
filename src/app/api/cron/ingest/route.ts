import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getChannelVideos, getVideo, parseDuration } from '@/lib/youtube';
import { fetchTranscript } from '@/lib/transcript';
import { processTranscript } from '@/lib/llm';

/**
 * Cron endpoint for automated video ingestion
 * 
 * Can be triggered by:
 * - Vercel Cron Jobs
 * - n8n/Make.com webhook
 * - Manual API call
 * 
 * Security: Requires CRON_SECRET header or query param
 */

function getSupabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
        throw new Error('Missing Supabase environment variables');
    }

    return createClient(url, key);
}

function verifyCronSecret(request: NextRequest): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret) return true; // No secret configured, allow all (dev mode)

    const headerSecret = request.headers.get('x-cron-secret');
    const querySecret = request.nextUrl.searchParams.get('secret');

    return headerSecret === secret || querySecret === secret;
}

export async function GET(request: NextRequest) {
    // Verify authorization
    if (!verifyCronSecret(request)) {
        return NextResponse.json(
            { error: 'Unauthorized' },
            { status: 401 }
        );
    }

    const channelId = process.env.DEFAULT_CHANNEL_ID || 'UCiJiqEvUZxT6isIaXK7RXTg';
    const supabase = getSupabase();
    const results = { processed: 0, skipped: 0, failed: 0, errors: [] as string[] };

    try {
        console.log(`[Cron] Starting ingestion for channel: ${channelId}`);

        // Get the latest video we have
        const { data: latestVideo } = await supabase
            .from('videos')
            .select('published_at')
            .order('published_at', { ascending: false })
            .limit(1)
            .single();

        const checkSince = latestVideo?.published_at
            ? new Date(latestVideo.published_at)
            : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default: last 7 days

        console.log(`[Cron] Checking for videos since: ${checkSince.toISOString()}`);

        // Fetch recent videos from YouTube (just first page for cron)
        const { videos } = await getChannelVideos(channelId, {
            maxResults: 10,
            publishedAfter: checkSince
        });

        console.log(`[Cron] Found ${videos.length} recent videos`);

        // Ensure channel exists
        const { data: existingChannel } = await supabase
            .from('channels')
            .select('id')
            .eq('youtube_id', channelId)
            .single();

        let channelDbId = existingChannel?.id;

        if (!channelDbId) {
            // Create channel entry
            const { data: newChannel, error } = await supabase
                .from('channels')
                .insert({
                    youtube_id: channelId,
                    name: 'Charles Hoskinson',
                })
                .select()
                .single();

            if (error) throw error;
            channelDbId = newChannel.id;
        }

        // Process each video
        for (const ytVideo of videos) {
            try {
                // Check if already processed
                const { data: existing } = await supabase
                    .from('videos')
                    .select('id, status')
                    .eq('youtube_id', ytVideo.id)
                    .single();

                if (existing?.status === 'completed') {
                    results.skipped++;
                    continue;
                }

                console.log(`[Cron] Processing: ${ytVideo.title.slice(0, 50)}...`);

                // Insert/update video
                let videoDbId: string;
                if (existing) {
                    videoDbId = existing.id;
                    await supabase.from('videos').update({ status: 'processing' }).eq('id', videoDbId);
                } else {
                    const { data: newVideo, error } = await supabase
                        .from('videos')
                        .insert({
                            channel_id: channelDbId,
                            youtube_id: ytVideo.id,
                            title: ytVideo.title,
                            description: ytVideo.description,
                            published_at: ytVideo.publishedAt,
                            duration_seconds: parseDuration(ytVideo.duration),
                            thumbnail_url: ytVideo.thumbnailUrl,
                            view_count: ytVideo.viewCount,
                            status: 'processing',
                        })
                        .select()
                        .single();

                    if (error) throw error;
                    videoDbId = newVideo.id;
                }

                // Fetch transcript
                const transcriptResult = await fetchTranscript(ytVideo.id);

                if (!transcriptResult) {
                    await supabase.from('videos').update({ status: 'failed' }).eq('id', videoDbId);
                    results.failed++;
                    results.errors.push(`No transcript: ${ytVideo.id}`);
                    continue;
                }

                // Process with LLM
                let cleanedText = transcriptResult.text;
                let summary = '';
                let tags: string[] = [];

                try {
                    const processed = await processTranscript(transcriptResult.text);
                    cleanedText = processed.cleanedText;
                    summary = processed.summary;
                    tags = processed.tags;
                } catch (llmError) {
                    console.error(`[Cron] LLM error for ${ytVideo.id}:`, llmError);
                    // Continue with raw transcript
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
                for (const tagName of tags) {
                    const { data: tag } = await supabase
                        .from('tags')
                        .upsert({ name: tagName.toLowerCase() }, { onConflict: 'name' })
                        .select()
                        .single();

                    if (tag) {
                        await supabase.from('video_tags').upsert({
                            video_id: videoDbId,
                            tag_id: tag.id
                        });
                    }
                }

                // Mark complete
                await supabase.from('videos').update({ status: 'completed' }).eq('id', videoDbId);
                results.processed++;

            } catch (videoError) {
                console.error(`[Cron] Error processing ${ytVideo.id}:`, videoError);
                results.failed++;
                results.errors.push(`${ytVideo.id}: ${String(videoError)}`);
            }
        }

        console.log(`[Cron] Complete. Processed: ${results.processed}, Skipped: ${results.skipped}, Failed: ${results.failed}`);

        return NextResponse.json({
            success: true,
            timestamp: new Date().toISOString(),
            results,
        });

    } catch (error) {
        console.error('[Cron] Fatal error:', error);
        return NextResponse.json(
            {
                success: false,
                error: String(error),
                results
            },
            { status: 500 }
        );
    }
}

// Also support POST for webhook compatibility
export async function POST(request: NextRequest) {
    return GET(request);
}
