import Link from "next/link";
import { createBrowserClient, getVideos, getAllTags, type VideoWithDetails, type Tag } from "@/lib/supabase";

// Revalidate every 5 minutes
export const revalidate = 300;

async function getLatestVideos(): Promise<VideoWithDetails[]> {
  try {
    const supabase = createBrowserClient();
    return await getVideos(supabase, { limit: 12 });
  } catch (error) {
    console.error("Failed to fetch videos:", error);
    return [];
  }
}

async function getTags(): Promise<Tag[]> {
  try {
    const supabase = createBrowserClient();
    return await getAllTags(supabase);
  } catch (error) {
    console.error("Failed to fetch tags:", error);
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

function VideoCard({ video }: { video: VideoWithDetails }) {
  return (
    <Link
      href={`/videos/${video.youtube_id}`}
      className="group block rounded-xl overflow-hidden bg-[var(--background-secondary)] border border-[var(--border)] card-hover"
    >
      {/* Thumbnail */}
      <div className="relative aspect-video bg-[var(--background-tertiary)] overflow-hidden">
        {video.thumbnail_url ? (
          <img
            src={video.thumbnail_url}
            alt={video.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <svg className="w-12 h-12 text-[var(--foreground-muted)]" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}
        {/* Duration badge */}
        {video.duration_seconds && (
          <div className="absolute bottom-2 right-2 px-2 py-1 rounded bg-black/80 text-xs font-medium">
            {formatDuration(video.duration_seconds)}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-4">
        <h3 className="font-medium text-sm leading-snug line-clamp-2 group-hover:text-[var(--color-accent)] transition-colors">
          {video.title}
        </h3>
        <div className="mt-2 flex items-center gap-2 text-xs text-[var(--foreground-muted)]">
          <span>{formatDate(video.published_at)}</span>
          {video.view_count && (
            <>
              <span>•</span>
              <span>{video.view_count.toLocaleString()} views</span>
            </>
          )}
        </div>
        {/* Tags */}
        {video.tags && video.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {video.tags.slice(0, 3).map((tag) => (
              <span key={tag.id} className="tag text-[10px] py-1 px-2">
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

function HeroSection() {
  return (
    <section className="relative py-24 overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-[var(--color-primary)]/10 to-transparent pointer-events-none" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-[var(--color-accent)]/5 rounded-full blur-3xl pointer-events-none" />

      <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight">
          What did{" "}
          <span className="gradient-text">Charles</span>
          {" "}say?
        </h1>
        <p className="mt-6 text-lg sm:text-xl text-[var(--foreground-muted)] max-w-2xl mx-auto">
          Search and explore transcripts from Charles Hoskinson&apos;s YouTube videos.
          A research tool for the Cardano community.
        </p>

        {/* Search bar */}
        <form action="/search" method="GET" className="mt-10 max-w-xl mx-auto">
          <div className="relative">
            <input
              type="text"
              name="q"
              placeholder="Search transcripts..."
              className="w-full h-14 pl-5 pr-14 rounded-full bg-[var(--background-secondary)] border border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--foreground-muted)] focus:border-[var(--color-primary)] transition-colors"
            />
            <button
              type="submit"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-full bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-primary-light)] text-white hover:opacity-90 transition-opacity"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
          </div>
        </form>

        {/* Quick stats placeholder */}
        <div className="mt-10 flex items-center justify-center gap-8 text-sm text-[var(--foreground-muted)]">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[var(--color-accent)] animate-pulse" />
            <span>Auto-updating library</span>
          </div>
        </div>
      </div>
    </section>
  );
}

export default async function Home() {
  const [videos, tags] = await Promise.all([getLatestVideos(), getTags()]);

  return (
    <div>
      <HeroSection />

      {/* Latest Videos */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-2xl font-semibold">Latest Videos</h2>
          <Link
            href="/videos"
            className="text-sm text-[var(--color-accent)] hover:underline"
          >
            View all →
          </Link>
        </div>

        {videos.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {videos.map((video) => (
              <VideoCard key={video.id} video={video} />
            ))}
          </div>
        ) : (
          <div className="text-center py-20 text-[var(--foreground-muted)]">
            <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <p className="text-lg font-medium">No videos yet</p>
            <p className="mt-2">Run the ingestion script to populate the library</p>
          </div>
        )}
      </section>

      {/* Browse by Topic */}
      {tags.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <h2 className="text-2xl font-semibold mb-8">Browse by Topic</h2>
          <div className="flex flex-wrap gap-3">
            {tags.slice(0, 30).map((tag) => (
              <Link
                key={tag.id}
                href={`/search?q=${encodeURIComponent(tag.name)}`}
                className="tag"
              >
                {tag.name}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
