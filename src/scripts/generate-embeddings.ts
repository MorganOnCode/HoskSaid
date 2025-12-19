import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { generateEmbedding } from '../lib/llm';

config({ path: '.env.local' });

// Initialize Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.error('❌ Missing Supabase environment variables');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Chunking Configuration
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 100;

function getArg(name: string): string | null {
    const arg = process.argv.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : null;
}

function splitText(text: string): string[] {
    const chunks: string[] = [];
    if (!text) return chunks;

    // Normalize
    const normalized = text.replace(/\s+/g, ' ').trim();

    let start = 0;
    while (start < normalized.length) {
        let end = start + CHUNK_SIZE;

        // Try to find a sentence boundary near the end if possible
        if (end < normalized.length) {
            const boundary = normalized.slice(start, end + 50).lastIndexOf('.');
            if (boundary > CHUNK_SIZE * 0.8) {
                end = start + boundary + 1;
            }
        }

        chunks.push(normalized.slice(start, end).trim());
        start = end - CHUNK_OVERLAP; // Move forward with overlap
    }

    return chunks;
}

async function generateEmbeddings() {
    const limit = parseInt(getArg('limit') || '10', 10);
    const videoIdArg = getArg('video');

    console.log(`🧠 Generating Semantic Embeddings (Limit: ${limit})...`);

    // 1. Get all videos that have transcripts
    let query = supabase
        .from('videos')
        .select(`
            id,
            title,
            transcript:transcripts(id, cleaned_text, raw_text)
        `)
        .eq('status', 'completed');

    if (videoIdArg) {
        query = query.eq('id', videoIdArg);
    }

    // We fetch a batch. Note: Filtering by "transcripts exist" implicitly happens by the join structure if using !inner,
    // but here we just iterate.
    const { data: videos, error } = await query.limit(limit);

    if (error) {
        console.error('❌ Error fetching videos:', error);
        return;
    }

    console.log(`Found ${videos?.length || 0} videos to check/process.`);
    let processedCount = 0;

    for (const video of videos || []) {
        // Check if chunks already exist
        const { count } = await supabase
            .from('transcript_chunks')
            .select('id', { count: 'exact', head: true })
            .eq('video_id', video.id);

        if (count && count > 0) {
            // Already processed
            continue;
        }

        // Needs embeddings
        const transcript = video.transcript;
        // @ts-ignore
        const textToChunk = transcript?.cleaned_text || transcript?.raw_text;

        if (!textToChunk) {
            console.log(`   ⚠️  No text found for video: ${video.title}`);
            continue;
        }

        console.log(`   🎬 Processing: ${video.title} (${textToChunk.length} chars)`);

        const chunks = splitText(textToChunk);
        console.log(`      Generated ${chunks.length} chunks.`);

        const chunkRecords = [];

        for (const chunkContent of chunks) {
            try {
                const embedding = await generateEmbedding(chunkContent);
                chunkRecords.push({
                    video_id: video.id,
                    content: chunkContent,
                    embedding: embedding
                });

                // Rate limit slightly? OpenAI is fast.
            } catch (e) {
                console.error('      Embedding failed:', e);
            }
        }

        if (chunkRecords.length > 0) {
            const { error: insertError } = await supabase
                .from('transcript_chunks')
                .insert(chunkRecords);

            if (insertError) console.error('      Failed to insert chunks:', insertError);
            else {
                processedCount++;
                console.log('      ✅ Chunks saved.');
            }
        }
    }

    console.log(`\n✅ Finished embedding generation. New videos processed: ${processedCount}`);
}

generateEmbeddings();
