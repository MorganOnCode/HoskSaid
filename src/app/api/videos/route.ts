import { NextRequest, NextResponse } from 'next/server';
import { createBrowserClient, getVideos } from '@/lib/supabase';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const channelId = searchParams.get('channel') || undefined;

    try {
        const supabase = createBrowserClient();
        const videos = await getVideos(supabase, { limit, offset, channelId });

        return NextResponse.json({
            videos,
            pagination: {
                limit,
                offset,
                hasMore: videos.length === limit,
            },
        });
    } catch (error) {
        console.error('API error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch videos' },
            { status: 500 }
        );
    }
}
