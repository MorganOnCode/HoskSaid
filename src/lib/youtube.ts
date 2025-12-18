// YouTube Data API v3 wrapper

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

export interface YouTubeVideo {
    id: string;
    title: string;
    description: string;
    publishedAt: string;
    thumbnailUrl: string;
    duration: string; // ISO 8601 duration
    viewCount: number;
    channelId: string;
    channelTitle: string;
}

export interface YouTubeChannel {
    id: string;
    title: string;
    description: string;
    thumbnailUrl: string;
    subscriberCount: number;
    videoCount: number;
}

function getApiKey(): string {
    const key = process.env.YOUTUBE_API_KEY;
    if (!key) {
        throw new Error('YOUTUBE_API_KEY environment variable is not set');
    }
    return key;
}

// Convert ISO 8601 duration to seconds
export function parseDuration(iso8601: string): number {
    const match = iso8601.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;

    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    const seconds = parseInt(match[3] || '0', 10);

    return hours * 3600 + minutes * 60 + seconds;
}

// Get channel details by ID
export async function getChannel(channelId: string): Promise<YouTubeChannel | null> {
    const apiKey = getApiKey();
    const url = new URL(`${YOUTUBE_API_BASE}/channels`);
    url.searchParams.set('part', 'snippet,statistics');
    url.searchParams.set('id', channelId);
    url.searchParams.set('key', apiKey);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok) {
        throw new Error(`YouTube API error: ${data.error?.message || 'Unknown error'}`);
    }

    if (!data.items || data.items.length === 0) {
        return null;
    }

    const channel = data.items[0];
    return {
        id: channel.id,
        title: channel.snippet.title,
        description: channel.snippet.description,
        thumbnailUrl: channel.snippet.thumbnails?.high?.url || channel.snippet.thumbnails?.default?.url,
        subscriberCount: parseInt(channel.statistics.subscriberCount, 10),
        videoCount: parseInt(channel.statistics.videoCount, 10),
    };
}

// Get all videos from a channel (paginated)
export async function getChannelVideos(
    channelId: string,
    options: {
        maxResults?: number;
        pageToken?: string;
        publishedAfter?: Date;
    } = {}
): Promise<{ videos: YouTubeVideo[]; nextPageToken?: string }> {
    const apiKey = getApiKey();
    const { maxResults = 50, pageToken, publishedAfter } = options;

    // First, get the uploads playlist ID
    const channelUrl = new URL(`${YOUTUBE_API_BASE}/channels`);
    channelUrl.searchParams.set('part', 'contentDetails');
    channelUrl.searchParams.set('id', channelId);
    channelUrl.searchParams.set('key', apiKey);

    const channelResponse = await fetch(channelUrl.toString());
    const channelData = await channelResponse.json();

    if (!channelResponse.ok || !channelData.items?.length) {
        throw new Error('Could not find channel');
    }

    const uploadsPlaylistId = channelData.items[0].contentDetails.relatedPlaylists.uploads;

    // Get videos from uploads playlist
    const playlistUrl = new URL(`${YOUTUBE_API_BASE}/playlistItems`);
    playlistUrl.searchParams.set('part', 'snippet,contentDetails');
    playlistUrl.searchParams.set('playlistId', uploadsPlaylistId);
    playlistUrl.searchParams.set('maxResults', maxResults.toString());
    playlistUrl.searchParams.set('key', apiKey);

    if (pageToken) {
        playlistUrl.searchParams.set('pageToken', pageToken);
    }

    const playlistResponse = await fetch(playlistUrl.toString());
    const playlistData = await playlistResponse.json();

    if (!playlistResponse.ok) {
        throw new Error(`YouTube API error: ${playlistData.error?.message || 'Unknown error'}`);
    }

    // Get video IDs for fetching duration and view counts
    const videoIds = playlistData.items.map(
        (item: { contentDetails: { videoId: string } }) => item.contentDetails.videoId
    );

    // Fetch video details
    const videoDetails = await getVideoDetails(videoIds);
    const videoDetailsMap = new Map(videoDetails.map((v) => [v.id, v]));

    let videos: YouTubeVideo[] = playlistData.items.map(
        (item: {
            snippet: {
                title: string;
                description: string;
                publishedAt: string;
                thumbnails: { high?: { url: string }; default?: { url: string } };
                channelId: string;
                channelTitle: string;
            };
            contentDetails: { videoId: string };
        }) => {
            const details = videoDetailsMap.get(item.contentDetails.videoId);
            return {
                id: item.contentDetails.videoId,
                title: item.snippet.title,
                description: item.snippet.description,
                publishedAt: item.snippet.publishedAt,
                thumbnailUrl:
                    item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
                duration: details?.duration || 'PT0S',
                viewCount: details?.viewCount || 0,
                channelId: item.snippet.channelId,
                channelTitle: item.snippet.channelTitle,
            };
        }
    );

    // Filter by publish date if specified
    if (publishedAfter) {
        videos = videos.filter((v) => new Date(v.publishedAt) > publishedAfter);
    }

    return {
        videos,
        nextPageToken: playlistData.nextPageToken,
    };
}

// Get video details (duration, view count)
export async function getVideoDetails(
    videoIds: string[]
): Promise<{ id: string; duration: string; viewCount: number }[]> {
    if (videoIds.length === 0) return [];

    const apiKey = getApiKey();
    const url = new URL(`${YOUTUBE_API_BASE}/videos`);
    url.searchParams.set('part', 'contentDetails,statistics');
    url.searchParams.set('id', videoIds.join(','));
    url.searchParams.set('key', apiKey);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok) {
        throw new Error(`YouTube API error: ${data.error?.message || 'Unknown error'}`);
    }

    return data.items.map(
        (item: {
            id: string;
            contentDetails: { duration: string };
            statistics: { viewCount: string };
        }) => ({
            id: item.id,
            duration: item.contentDetails.duration,
            viewCount: parseInt(item.statistics.viewCount || '0', 10),
        })
    );
}

// Get a single video by ID
export async function getVideo(videoId: string): Promise<YouTubeVideo | null> {
    const apiKey = getApiKey();
    const url = new URL(`${YOUTUBE_API_BASE}/videos`);
    url.searchParams.set('part', 'snippet,contentDetails,statistics');
    url.searchParams.set('id', videoId);
    url.searchParams.set('key', apiKey);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok) {
        throw new Error(`YouTube API error: ${data.error?.message || 'Unknown error'}`);
    }

    if (!data.items || data.items.length === 0) {
        return null;
    }

    const video = data.items[0];
    return {
        id: video.id,
        title: video.snippet.title,
        description: video.snippet.description,
        publishedAt: video.snippet.publishedAt,
        thumbnailUrl:
            video.snippet.thumbnails?.high?.url || video.snippet.thumbnails?.default?.url,
        duration: video.contentDetails.duration,
        viewCount: parseInt(video.statistics.viewCount || '0', 10),
        channelId: video.snippet.channelId,
        channelTitle: video.snippet.channelTitle,
    };
}

// Check for new videos since a given date
export async function checkForNewVideos(
    channelId: string,
    since: Date
): Promise<YouTubeVideo[]> {
    const allNewVideos: YouTubeVideo[] = [];
    let pageToken: string | undefined;

    do {
        const result = await getChannelVideos(channelId, {
            maxResults: 50,
            pageToken,
            publishedAfter: since,
        });

        allNewVideos.push(...result.videos);
        pageToken = result.nextPageToken;

        // If we got less than max results, we've probably gotten all new videos
        if (result.videos.length < 50) break;
    } while (pageToken);

    return allNewVideos;
}
