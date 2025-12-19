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

export async function tagSearch(query: string, limit: number = 20): Promise<VideoWithDetails[]> {
    const client = createBrowserClient();

    // Search for tags that match the query
    const { data: videos, error } = await client
        .from('videos')
        .select(`
            *,
            channel:channels(*),
            transcript:transcripts(summary, cleaned_text),
            tags:video_tags!inner(tag:tags!inner(*))
        `)
        .ilike('tags.tag.name', `%${query}%`)
        .eq('status', 'completed')
        .limit(limit);

    if (error) {
        // Postgrest shallow join filtering can be tricky. 
        // Fallback or simpler query often preferred if deep relation filtering fails.
        // Let's try finding the tag UUID first.
        return fallbackTagSearch(query, limit);
    }

    // Flatten tags
    return (videos || []).map((video: any) => ({
        ...video,
        tags: video.tags?.map((vt: any) => vt.tag) || [],
    }));
}

async function fallbackTagSearch(query: string, limit: number): Promise<VideoWithDetails[]> {
    const client = createBrowserClient();

    // 1. Find Tag IDs
    const { data: foundTags } = await client
        .from('tags')
        .select('id')
        .ilike('name', query) // Exact-ish match preferred for clicking "tags"
        .limit(10);

    if (!foundTags || foundTags.length === 0) return [];
    const tagIds = foundTags.map(t => t.id);

    // 2. Find Videos with those tags
    const { data: videoTags } = await client
        .from('video_tags')
        .select('video_id')
        .in('tag_id', tagIds);

    if (!videoTags || videoTags.length === 0) return [];
    const videoIds = [...new Set(videoTags.map(vt => vt.video_id))];

    // 3. Fetch Details
    const { data: videos } = await client
        .from('videos')
        .select(`
            *,
            channel:channels(*),
            transcript:transcripts(summary, cleaned_text),
            tags:video_tags(tag:tags(*))
        `)
        .in('id', videoIds)
        .eq('status', 'completed')
        .limit(limit);

    return (videos || []).map((video: any) => ({
        ...video,
        tags: video.tags?.map((vt: any) => vt.tag) || [],
    }));
}

export async function hybridSearch(query: string, limit: number = 20): Promise<VideoWithDetails[]> {
    const adminClient = getAdminClient();
    const browserClient = createBrowserClient(); // For standard search

    // Run parallel searches
    const [semanticResults, keywordResults, tagResults] = await Promise.all([
        semanticSearch(query, limit),
        searchVideos(browserClient, query, { limit }),
        tagSearch(query, limit)
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

    // Merge Results: Tag First, then Semantic, then Keyword
    const allVideos = [...tagResults, ...semanticVideos, ...keywordResults];

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
