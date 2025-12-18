import { NextRequest, NextResponse } from 'next/server';
import { createBrowserClient, searchVideos } from '@/lib/supabase';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q') || '';
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    if (!query.trim()) {
        return NextResponse.json({
            videos: [],
            query: '',
            pagination: { limit, offset, hasMore: false },
        });
    }

    try {
        const supabase = createBrowserClient();
        const videos = await searchVideos(supabase, query, { limit, offset });

        return NextResponse.json({
            videos,
            query,
            pagination: {
                limit,
                offset,
                hasMore: videos.length === limit,
            },
        });
    } catch (error) {
        console.error('Search API error:', error);
        return NextResponse.json(
            { error: 'Search failed' },
            { status: 500 }
        );
    }
}
