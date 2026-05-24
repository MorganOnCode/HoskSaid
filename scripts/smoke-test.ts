#!/usr/bin/env tsx
/**
 * Smoke test the new Postgres adapter against the live container.
 * Seeds a tiny dataset, exercises every helper, prints results.
 * Run with: DATABASE_URL=... npx tsx scripts/smoke-test.ts
 */

import {
    sql,
    getVideos,
    getVideoByYoutubeId,
    searchVideos,
    getAllTags,
    submitErrorReport,
    toVectorLiteral,
} from '../src/lib/db';

async function main() {
    console.log('1. ping ──────────────────────────────────────');
    const [{ now }] = await sql<{ now: Date }[]>`SELECT NOW() AS now`;
    console.log('   db time:', now);

    console.log('\n2. wipe & seed ───────────────────────────────');
    // Wipe in dependency order.
    await sql`TRUNCATE ingestion_logs, error_reports, transcript_chunks,
              video_tags, transcripts, videos, channels, tags RESTART IDENTITY CASCADE`;

    const [ch] = await sql<{ id: string }[]>`
        INSERT INTO channels (youtube_id, name)
        VALUES ('UCTESTCHAN', 'Test Channel') RETURNING id
    `;
    console.log('   channel id:', ch.id);

    const [v1] = await sql<{ id: string }[]>`
        INSERT INTO videos (channel_id, youtube_id, title, description,
                            published_at, duration_seconds, status)
        VALUES (${ch.id}, 'VID00001', 'Cardano Governance Overview',
                'A deep dive into Cardano governance', NOW() - INTERVAL '1 day',
                1200, 'completed') RETURNING id
    `;
    const [v2] = await sql<{ id: string }[]>`
        INSERT INTO videos (channel_id, youtube_id, title, description,
                            published_at, duration_seconds, status)
        VALUES (${ch.id}, 'VID00002', 'Midnight Sidechain Updates',
                'Latest on Midnight', NOW() - INTERVAL '2 days',
                900, 'completed') RETURNING id
    `;
    console.log('   videos:', v1.id, v2.id);

    await sql`
        INSERT INTO transcripts (video_id, raw_text, cleaned_text, summary,
                                 source, processing_status)
        VALUES (${v1.id},
                'ADA governance is built on a layered approach with voting mechanisms.',
                'ADA governance is built on a layered approach with voting mechanisms.',
                '• Layered governance\n• Voting mechanisms',
                'youtube_captions', 'completed')
    `;
    await sql`
        INSERT INTO transcripts (video_id, raw_text, cleaned_text, summary,
                                 source, processing_status)
        VALUES (${v2.id},
                'Midnight is a privacy-preserving sidechain for Cardano.',
                'Midnight is a privacy-preserving sidechain for Cardano.',
                NULL,
                'youtube_captions', 'completed')
    `;
    const [t1] = await sql<{ id: string }[]>`
        INSERT INTO tags (name) VALUES ('governance') RETURNING id
    `;
    const [t2] = await sql<{ id: string }[]>`
        INSERT INTO tags (name) VALUES ('midnight') RETURNING id
    `;
    await sql`INSERT INTO video_tags (video_id, tag_id) VALUES (${v1.id}, ${t1.id})`;
    await sql`INSERT INTO video_tags (video_id, tag_id) VALUES (${v2.id}, ${t2.id})`;

    console.log('\n3. getVideos() ──────────────────────────────');
    const list = await getVideos({ limit: 10 });
    console.log('   count:', list.length);
    console.log('   first.title:', list[0]?.title);
    console.log('   first.channel.name:', list[0]?.channel?.name);
    console.log('   first.tags:', list[0]?.tags?.map(t => t.name));

    console.log('\n4. getVideoByYoutubeId() ────────────────────');
    const one = await getVideoByYoutubeId('VID00001');
    console.log('   title:', one?.title);
    console.log('   transcript.summary:', one?.transcript?.summary?.slice(0, 40));
    console.log('   tags:', one?.tags?.map(t => t.name));

    console.log('\n5. searchVideos("governance") ───────────────');
    const search1 = await searchVideos('governance');
    console.log('   hits:', search1.length, '— titles:', search1.map(v => v.title));

    console.log('\n6. searchVideos("privacy") (transcript FTS) ─');
    const search2 = await searchVideos('privacy');
    console.log('   hits:', search2.length, '— titles:', search2.map(v => v.title));

    console.log('\n7. getAllTags() ─────────────────────────────');
    const tags = await getAllTags();
    console.log('   tags:', tags.map(t => t.name));

    console.log('\n8. submitErrorReport() ──────────────────────');
    const report = await submitErrorReport({
        video_id: v1.id,
        error_type: 'typo',
        description: 'test report',
    });
    console.log('   report id:', report.id, 'status:', report.status);

    console.log('\n9. pgvector smoke (insert + match_transcript_chunks) ─');
    const fakeEmbedding = Array.from({ length: 1536 }, () => Math.random() - 0.5);
    const vecLit = toVectorLiteral(fakeEmbedding);
    await sql`
        INSERT INTO transcript_chunks (video_id, content, embedding)
        VALUES (${v1.id}, 'A test chunk about governance.', ${vecLit}::vector)
    `;
    const matches = await sql<Record<string, unknown>[]>`
        SELECT * FROM match_transcript_chunks(${vecLit}::vector, 0.0::float, 5::int)
    `;
    console.log('   match_transcript_chunks rows:', matches.length);

    console.log('\n10. cleanup ─────────────────────────────────');
    await sql`TRUNCATE ingestion_logs, error_reports, transcript_chunks,
              video_tags, transcripts, videos, channels, tags RESTART IDENTITY CASCADE`;

    console.log('\nALL OK');
    await sql.end({ timeout: 2 });
}

main().catch(async (e) => {
    console.error('FAIL:', e);
    await sql.end({ timeout: 2 });
    process.exit(1);
});
