#!/usr/bin/env npx tsx
/**
 * Enrichment script: re-runs the LLM on transcripts that still lack a
 * summary, generating bullet-point summary + tags and backfilling tags.
 *
 *   npx tsx src/scripts/enrich.ts --limit=10
 *   npx tsx src/scripts/enrich.ts --video=<uuid>
 *   npx tsx src/scripts/enrich.ts --force --limit=5
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { sql } from '../lib/db';
import { processTranscript } from '../lib/llm';

function getArg(name: string): string | null {
    const arg = process.argv.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : null;
}

async function enrichVideos() {
    const limit = parseInt(getArg('limit') || '10', 10);
    const videoIdArg = getArg('video');
    const forceUpdate = process.argv.includes('--force');

    console.log('🧠 HoskSaid Enrichment Script');
    console.log('-----------------------------');

    const transcripts = await sql<{
        video_id: string;
        raw_text: string | null;
        title: string;
    }[]>`
        SELECT t.video_id,
               t.raw_text,
               v.title
        FROM transcripts t
        JOIN videos v ON v.id = t.video_id
        WHERE v.status = 'completed'
          ${videoIdArg ? sql`AND t.video_id = ${videoIdArg}` : sql``}
          ${forceUpdate ? sql`` : sql`AND t.summary IS NULL`}
        ORDER BY v.published_at DESC NULLS LAST
        LIMIT ${limit}
    `;

    if (transcripts.length === 0) {
        console.log('✅ No videos found needing enrichment.');
        await sql.end({ timeout: 5 });
        return;
    }

    console.log(`🔍 Found ${transcripts.length} videos needing summaries.\n`);

    let successCount = 0;
    let failCount = 0;

    for (const t of transcripts) {
        const title = t.title || 'Unknown Title';
        const videoId = t.video_id;

        console.log(`🎬 Enriching: ${title.slice(0, 50)}...`);
        console.log(`   📝 Transcript length: ${t.raw_text?.length || 0} chars`);

        if (!t.raw_text) {
            console.log('   ⚠️  No raw text available, skipping.');
            continue;
        }

        try {
            console.log('   🤖 Processing with LLM...');
            const start = Date.now();
            const processed = await processTranscript(t.raw_text);
            const duration = ((Date.now() - start) / 1000).toFixed(1);
            console.log(`   ✅ Processed in ${duration}s. Summary: ${processed.summary.length} chars. Tags: ${processed.tags.join(', ')}`);

            await sql`
                UPDATE transcripts
                SET cleaned_text = ${processed.cleanedText},
                    summary      = ${processed.summary}
                WHERE video_id = ${videoId}
            `;

            for (const tagName of processed.tags) {
                const [tag] = await sql<{ id: string }[]>`
                    INSERT INTO tags (name) VALUES (${tagName.toLowerCase()})
                    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
                    RETURNING id
                `;
                if (tag) {
                    await sql`
                        INSERT INTO video_tags (video_id, tag_id)
                        VALUES (${videoId}, ${tag.id})
                        ON CONFLICT DO NOTHING
                    `;
                }
            }

            successCount++;
        } catch (err) {
            console.error(`   ❌ Failed:`, err);
            failCount++;
        }
        console.log('-----------------------------');
    }

    console.log(`\n📊 Enrichment Summary:`);
    console.log(`   ✅ Success: ${successCount}`);
    console.log(`   ❌ Failed: ${failCount}`);

    await sql.end({ timeout: 5 });
}

enrichVideos().catch(async (e) => {
    console.error('Fatal error:', e);
    await sql.end({ timeout: 5 });
    process.exit(1);
});
