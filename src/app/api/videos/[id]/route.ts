import { NextRequest, NextResponse } from 'next/server';
import { createBrowserClient, getVideoByYoutubeId } from '@/lib/supabase';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
    const { id } = await params;

    try {
        const supabase = createBrowserClient();
        const video = await getVideoByYoutubeId(supabase, id);

        if (!video) {
            return NextResponse.json(
                { error: 'Video not found' },
                { status: 404 }
            );
        }

        return NextResponse.json(video);
    } catch (error) {
        console.error('API error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch video' },
            { status: 500 }
        );
    }
}
