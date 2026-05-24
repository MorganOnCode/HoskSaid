import { NextRequest, NextResponse } from 'next/server';
import { getVideoByYoutubeId } from '@/lib/db';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
    const { id } = await params;

    try {
        const video = await getVideoByYoutubeId(id);

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
