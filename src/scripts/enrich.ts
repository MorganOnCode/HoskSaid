import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { processTranscript } from '../lib/llm';

// Load environment variables from .env.local
config({ path: '.env.local' });

function getArg(name: string): string | null {
    const arg = process.argv.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : null;
}

// Initialize Supabase (Admin Client)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.error('❌ Missing Supabase environment variables');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function enrichVideos() {
    const limit = parseInt(getArg('limit') || '10', 10);
    const videoIdArg = getArg('video');
    const forceUpdate = process.argv.includes('--force');

    console.log('🧠 HoskSaid Enrichment Script');
    console.log('-----------------------------');

    // Build Query
    let query = supabase
        .from('videos')
        .select(`
            id, 
            title, 
            transcript:transcripts(raw_text, summary, cleaned_text)
        `)
        .eq('status', 'completed');

    if (videoIdArg) {
        query = query.eq('id', videoIdArg);
    } else if (!forceUpdate) {
        // Only get videos where summary is missing/empty
        // Note: Supabase/Postgrest checks related table filters differently, 
        // so we'll fetch a batch and filter in code or use !inner join.
        // For simplicity and to avoid complex inner join syntax issues with missing relations,
        // we will fetch batch and filter in JS.
    }

    // We fetch a larger batch to filter in memory efficiently since we can't easily query "Where transcript.summary IS NULL" 
    // without an explicit foreign key filter or flattening the table structure.
    // Actually, we can use the !inner hint to filter.
    // .not('transcript.summary', 'is', null) would filter KEEPING ones with summary.
    // We want ones WITHOUT summary.
    // Let's just iterate through the library and look for gaps.

    // Better approach: Query transcripts table directly where summary is null
    const { data: transcripts, error } = await supabase
        .from('transcripts')
        .select(`
            video_id,
            raw_text,
            summary,
            video:videos(title)
        `)
        .is('summary', null)
        .limit(limit);

    if (error) {
        console.error('❌ Failed to fetch pending transcripts:', error);
        return;
    }

    if (!transcripts || transcripts.length === 0) {
        console.log('✅ No videos found needing enrichment.');
        return;
    }

    console.log(`🔍 Found ${transcripts.length} videos needing summaries.\n`);

    let successCount = 0;
    let failCount = 0;

    for (const t of transcripts) {
        // @ts-ignore - Supabase join types can be loose
        const title = t.video?.title || 'Unknown Title';
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

            // Update Transcript
            const { error: updateError } = await supabase
                .from('transcripts')
                .update({
                    cleaned_text: processed.cleanedText,
                    summary: processed.summary
                })
                .eq('video_id', videoId);

            if (updateError) throw updateError;

            // Update Tags
            if (processed.tags.length > 0) {
                for (const tagName of processed.tags) {
                    // Get/Create tag
                    const { data: tagData } = await supabase
                        .from('tags')
                        .upsert({ name: tagName.toLowerCase() }, { onConflict: 'name' })
                        .select()
                        .single();

                    if (tagData) {
                        // Link tag to video
                        await supabase
                            .from('video_tags')
                            .upsert({
                                video_id: videoId,
                                tag_id: tagData.id
                            }, { onConflict: 'video_id,tag_id' });
                    }
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
}

enrichVideos();
