import Link from "next/link";
import { createBrowserClient, getVideos, type VideoWithDetails } from "@/lib/supabase";

export const revalidate = 300;

export const metadata = {
    title: "All Videos - HoskSaid",
    description: "Browse all transcribed videos from Charles Hoskinson's YouTube channel.",
};

async function getAllVideos(): Promise<VideoWithDetails[]> {
    try {
        const supabase = createBrowserClient();
        return await getVideos(supabase, { limit: 100 });
    } catch (error) {
        console.error("Failed to fetch videos:", error);
        return [];
    }
}

function formatDate(dateString?: string): string {
    if (!dateString) return "";
    return new Date(dateString).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

function formatDuration(seconds?: number): string {
    if (!seconds) return "";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes} min`;
}

export default async function VideosPage() {
    const videos = await getAllVideos();

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
            <div className="mb-8">
                <h1 className="text-3xl font-bold">All Videos</h1>
                <p className="mt-2 text-[var(--foreground-muted)]">
                    {videos.length} transcribed videos available
                </p>
            </div>

            {videos.length > 0 ? (
                <div className="space-y-4">
                    {videos.map((video) => (
                        <Link
                            key={video.id}
                            href={`/videos/${video.youtube_id}`}
                            className="flex gap-4 p-4 rounded-xl bg-[var(--background-secondary)] border border-[var(--border)] card-hover"
                        >
                            {/* Thumbnail */}
                            <div className="flex-shrink-0 w-48 aspect-video rounded-lg overflow-hidden bg-[var(--background-tertiary)]">
                                {video.thumbnail_url ? (
                                    <img
                                        src={video.thumbnail_url}
                                        alt={video.title}
                                        className="w-full h-full object-cover"
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <svg className="w-8 h-8 text-[var(--foreground-muted)]" fill="currentColor" viewBox="0 0 24 24">
                                            <path d="M8 5v14l11-7z" />
                                        </svg>
                                    </div>
                                )}
                            </div>

                            {/* Content */}
                            <div className="flex-1 min-w-0">
                                <h2 className="font-medium text-lg line-clamp-2 group-hover:text-[var(--color-accent)]">
                                    {video.title}
                                </h2>
                                <div className="mt-2 flex items-center gap-3 text-sm text-[var(--foreground-muted)]">
                                    <span>{formatDate(video.published_at)}</span>
                                    {video.duration_seconds && (
                                        <>
                                            <span>•</span>
                                            <span>{formatDuration(video.duration_seconds)}</span>
                                        </>
                                    )}
                                    {video.view_count && (
                                        <>
                                            <span>•</span>
                                            <span>{video.view_count.toLocaleString()} views</span>
                                        </>
                                    )}
                                </div>
                                {video.transcript?.summary && (
                                    <p className="mt-3 text-sm text-[var(--foreground-muted)] line-clamp-2">
                                        {video.transcript.summary.replace(/^• /gm, '').split('\n')[0]}
                                    </p>
                                )}
                                {video.tags && video.tags.length > 0 && (
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        {video.tags.slice(0, 5).map((tag) => (
                                            <span key={tag.id} className="tag">
                                                {tag.name}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </Link>
                    ))}
                </div>
            ) : (
                <div className="text-center py-20 text-[var(--foreground-muted)]">
                    <p className="text-lg">No videos yet. Run the ingestion script to populate the library.</p>
                </div>
            )}
        </div>
    );
}
