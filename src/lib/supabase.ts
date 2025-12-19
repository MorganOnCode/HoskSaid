import { createClient } from '@supabase/supabase-js';

// Types for our database tables
export interface Channel {
  id: string;
  youtube_id: string;
  name: string;
  description?: string;
  thumbnail_url?: string;
  created_at: string;
  updated_at: string;
}

export interface Video {
  id: string;
  channel_id: string;
  youtube_id: string;
  title: string;
  description?: string;
  published_at?: string;
  duration_seconds?: number;
  thumbnail_url?: string;
  view_count?: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: string;
  updated_at: string;
}

export interface Transcript {
  id: string;
  video_id: string;
  raw_text?: string;
  cleaned_text?: string;
  summary?: string;
  source?: 'youtube_captions' | 'extractor' | 'whisper';
  processing_status: 'pending' | 'processing' | 'completed' | 'failed';
  error_message?: string;
  created_at: string;
  updated_at: string;
}

export interface Tag {
  id: string;
  name: string;
  created_at: string;
}

export interface VideoWithDetails extends Video {
  channel?: Channel;
  transcript?: Transcript;
  tags?: Tag[];
}

export interface ErrorReport {
  id: string;
  video_id: string;
  error_type: 'typo' | 'missing_content' | 'wrong_speaker' | 'other';
  description: string;
  timestamp_seconds?: number;
  status: 'pending' | 'reviewed' | 'fixed' | 'dismissed';
  created_at: string;
}

// Client for browser/public access (uses anon key)
export function createBrowserClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(supabaseUrl, supabaseAnonKey);
}

// Client for server/admin access (uses service role key)
export function createServerClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(supabaseUrl, supabaseServiceKey);
}

// Helper functions for common operations

export async function getVideos(
  client: ReturnType<typeof createBrowserClient>,
  options: {
    limit?: number;
    offset?: number;
    channelId?: string;
    tagName?: string;
  } = {}
): Promise<VideoWithDetails[]> {
  const { limit = 20, offset = 0, channelId, tagName } = options;

  let query = client
    .from('videos')
    .select(`
      *,
      channel:channels(*),
      transcript:transcripts(summary),
      tags:video_tags(tag:tags(*))
    `)
    .eq('status', 'completed')
    .order('published_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (channelId) {
    query = query.eq('channel_id', channelId);
  }

  const { data, error } = await query;

  if (error) throw error;

  // Flatten the tags structure
  return (data || []).map((video) => ({
    ...video,
    tags: video.tags?.map((vt: { tag: Tag }) => vt.tag) || [],
  }));
}

export async function getVideoByYoutubeId(
  client: ReturnType<typeof createBrowserClient>,
  youtubeId: string
): Promise<VideoWithDetails | null> {
  const { data, error } = await client
    .from('videos')
    .select(`
      *,
      channel:channels(*),
      transcript:transcripts(*),
      tags:video_tags(tag:tags(*))
    `)
    .eq('youtube_id', youtubeId)
    .eq('status', 'completed')
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    throw error;
  }

  return {
    ...data,
    tags: data.tags?.map((vt: { tag: Tag }) => vt.tag) || [],
  };
}

export async function searchVideos(
  client: ReturnType<typeof createBrowserClient>,
  query: string,
  options: { limit?: number; offset?: number } = {}
): Promise<VideoWithDetails[]> {
  const { limit = 20, offset = 0 } = options;
  const sanitizedQuery = query.trim();

  // Clean up query for websearch style "OR" matching if multiple terms
  const searchTerms = sanitizedQuery.split(/\s+/).filter(t => t.length > 0).join(' | ');

  // 1. Search Video Metadata (Title, Description)
  const videosQuery = client
    .from('videos')
    .select(`
      *,
      channel:channels(*),
      transcript:transcripts!inner(summary, cleaned_text),
      tags:video_tags(tag:tags(*))
    `)
    .eq('status', 'completed')
    .or(`title.ilike.%${sanitizedQuery}%,description.ilike.%${sanitizedQuery}%`)
    .limit(limit);

  // 2. Search Transcripts (Full Text Search)
  // We search the transcripts table directly using the FTS index we created
  const transcriptQuery = client
    .from('transcripts')
    .select(`
      video:videos!inner(
        *,
        channel:channels(*),
        tags:video_tags(tag:tags(*))
      ),
      summary,
      cleaned_text
    `)
    .eq('video.status', 'completed')
    .textSearch('raw_text', searchTerms, { type: 'websearch', config: 'english' })
    .limit(limit);

  // Run in parallel
  const [videoResults, transcriptResults] = await Promise.all([videosQuery, transcriptQuery]);

  if (videoResults.error) console.error('Video search error:', videoResults.error);
  if (transcriptResults.error) console.error('Transcript search error:', transcriptResults.error);

  // Map transcript results to VideoWithDetails structure
  const mappedTranscriptResults: VideoWithDetails[] = (transcriptResults.data || []).map(t => {
    // @ts-ignore - Supabase types are tricky with nested relations
    const video = t.video as any;
    return {
      ...video,
      transcript: {
        summary: t.summary,
        cleaned_text: t.cleaned_text
      },
      tags: video.tags?.map((vt: { tag: Tag }) => vt.tag) || []
    };
  });

  const parsedVideoResults: VideoWithDetails[] = (videoResults.data || []).map(video => ({
    ...video,
    tags: video.tags?.map((vt: { tag: Tag }) => vt.tag) || []
  }));

  // Merge and deduplicate by ID
  const allVideos = [...parsedVideoResults, ...mappedTranscriptResults];
  const uniqueVideos = Array.from(new Map(allVideos.map(v => [v.id, v])).values());

  // Sort by published_at DESC (default) or arguably relevance
  // For now, let's sort by date to pinpoint recent relevant videos
  uniqueVideos.sort((a, b) => {
    return new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime();
  });

  return uniqueVideos.slice(offset, offset + limit);
}

export async function submitErrorReport(
  client: ReturnType<typeof createBrowserClient>,
  report: {
    video_id: string;
    error_type: ErrorReport['error_type'];
    description: string;
    timestamp_seconds?: number;
  }
): Promise<ErrorReport> {
  const { data, error } = await client
    .from('error_reports')
    .insert(report)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getAllTags(
  client: ReturnType<typeof createBrowserClient>
): Promise<Tag[]> {
  const { data, error } = await client
    .from('tags')
    .select('*')
    .order('name');

  if (error) throw error;
  return data || [];
}
