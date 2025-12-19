import { createClient } from '@supabase/supabase-js';
import { generateEmbedding } from './llm'; // Server-side only
import { VideoWithDetails, searchVideos, createBrowserClient } from './supabase';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function getAdminClient() {
    return createClient(supabaseUrl, supabaseServiceKey);
}

interface SemanticResult {
    id: string; // chunk id
    video_id: string;
    content: string;
    similarity: number;
}

export async function semanticSearch(query: string, limit: number = 20): Promise<SemanticResult[]> {
    try {
        const embedding = await generateEmbedding(query);
        if (embedding.length === 0) return [];

        const client = getAdminClient();

        const { data, error } = await client.rpc('match_transcript_chunks', {
            query_embedding: embedding,
            match_threshold: 0.5, // Tweak this threshold
            match_count: limit
        });

        if (error) {
            console.error('Semantic search RPC error:', error);
            return [];
        }

        return data as SemanticResult[];
    } catch (e) {
        console.error('Semantic search failed:', e);
        return [];
    }
}

export async function hybridSearch(query: string, limit: number = 20): Promise<VideoWithDetails[]> {
    const adminClient = getAdminClient();
    const browserClient = createBrowserClient(); // For standard search

    // Run parallel searches
    const [semanticResults, keywordResults] = await Promise.all([
        semanticSearch(query, limit),
        searchVideos(browserClient, query, { limit })
    ]);

    // Process Semantic Results to get full video details
    const semanticVideoIds = [...new Set(semanticResults.map(r => r.video_id))];

    let semanticVideos: VideoWithDetails[] = [];
    if (semanticVideoIds.length > 0) {
        const { data } = await adminClient
            .from('videos')
            .select(`
                *,
                channel:channels(*),
                transcript:transcripts(summary, cleaned_text),
                tags:video_tags(tag:tags(*))
            `)
            .in('id', semanticVideoIds)
            .eq('status', 'completed');

        if (data) {
            // Map raw data to VideoWithDetails and Attach the best snippet from chunks
            semanticVideos = data.map((video: any) => {
                // Find best chunk for this video
                const bestChunk = semanticResults.find(r => r.video_id === video.id);

                return {
                    ...video,
                    tags: video.tags?.map((vt: any) => vt.tag) || [],
                    // Override transcript snippet with the exact semantic match
                    transcript: {
                        ...(video.transcript || {}),
                        cleaned_text: bestChunk ? bestChunk.content : video.transcript?.cleaned_text
                    }
                };
            });
        }
    }

    // Merge Results: Score semantic higher? or just deduplicate?
    // We'll put Semantic matches FIRST, then standard results.
    const allVideos = [...semanticVideos, ...keywordResults];

    // Deduplicate by ID
    const seenIds = new Set();
    const uniqueVideos: VideoWithDetails[] = [];

    for (const v of allVideos) {
        if (!seenIds.has(v.id)) {
            seenIds.add(v.id);
            uniqueVideos.push(v);
        }
    }

    return uniqueVideos.slice(0, limit);
}
