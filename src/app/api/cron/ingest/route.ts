import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { getChannelVideos, parseDuration } from '@/lib/youtube';
import { fetchTranscript } from '@/lib/transcript';
import { processTranscript } from '@/lib/llm';

/**
 * Cron endpoint for automated video ingestion.
 *
 * Triggers:
 *  - Manual: GET /api/cron/ingest?secret=<CRON_SECRET>
 *  - Webhook: POST /api/cron/ingest (with x-cron-secret header)
 *  - Systemd timer can call this via curl as an alternative to the
 *    `scheduler` compose service; in practice the timer runs the scripts
 *    directly, so this route is mostly for ad-hoc triggers.
 */

// Force a Node runtime — pg only works in Node, not Edge.
export const runtime = 'nodejs';

function verifyCronSecret(request: NextRequest): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret) return true; // Dev mode: no secret configured.
    const headerSecret = request.headers.get('x-cron-secret');
    const querySecret = request.nextUrl.searchParams.get('secret');
    return headerSecret === secret || querySecret === secret;
}

export async function GET(request: NextRequest) {
    if (!verifyCronSecret(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const channelId = process.env.DEFAULT_CHANNEL_ID || 'UCiJiqEvUZxT6isIaXK7RXTg';
    const results = { processed: 0, skipped: 0, failed: 0, errors: [] as string[] };

    try {
        console.log(`[Cron] Starting ingestion for channel: ${channelId}`);

        const latestVideoRows = await sql<{ published_at: string | null }[]>`
            SELECT published_at FROM videos
            WHERE published_at IS NOT NULL
            ORDER BY published_at DESC
            LIMIT 1
        `;
        const checkSince = latestVideoRows[0]?.published_at
            ? new Date(latestVideoRows[0].published_at)
            : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        console.log(`[Cron] Checking for videos since: ${checkSince.toISOString()}`);

        const { videos } = await getChannelVideos(channelId, {
            maxResults: 10,
            publishedAfter: checkSince,
        });

        console.log(`[Cron] Found ${videos.length} recent videos`);

        // Ensure channel row exists.
        const existingChannelRows = await sql<{ id: string }[]>`
            SELECT id FROM channels WHERE youtube_id = ${channelId} LIMIT 1
        `;
        let channelDbId = existingChannelRows[0]?.id;
        if (!channelDbId) {
            const [newChannel] = await sql<{ id: string }[]>`
                INSERT INTO channels (youtube_id, name)
                VALUES (${channelId}, 'Charles Hoskinson')
                RETURNING id
            `;
            channelDbId = newChannel.id;
        }

        for (const ytVideo of videos) {
            try {
                const existingRows = await sql<{ id: string; status: string }[]>`
                    SELECT id, status FROM videos WHERE youtube_id = ${ytVideo.id} LIMIT 1
                `;
                const existing = existingRows[0];

                if (existing?.status === 'completed') {
                    results.skipped++;
                    continue;
                }

                console.log(`[Cron] Processing: ${ytVideo.title.slice(0, 50)}...`);

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
                            ${channelDbId}, ${ytVideo.id}, ${ytVideo.title},
                            ${ytVideo.description ?? null}, ${ytVideo.publishedAt ?? null},
                            ${parseDuration(ytVideo.duration)}, ${ytVideo.thumbnailUrl ?? null},
                            ${ytVideo.viewCount ?? null}, 'processing'
                        ) RETURNING id
                    `;
                    videoDbId = row.id;
                }

                const transcriptResult = await fetchTranscript(ytVideo.id);
                if (!transcriptResult) {
                    await sql`UPDATE videos SET status = 'failed' WHERE id = ${videoDbId}`;
                    results.failed++;
                    results.errors.push(`No transcript: ${ytVideo.id}`);
                    continue;
                }

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
                }

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

                await sql`UPDATE videos SET status = 'completed' WHERE id = ${videoDbId}`;
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
            { success: false, error: String(error), results },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    return GET(request);
}
