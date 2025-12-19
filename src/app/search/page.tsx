import Link from "next/link";
import { hybridSearch } from "@/lib/search-server";
import { type VideoWithDetails } from "@/lib/supabase";
import { Metadata } from "next";

interface PageProps {
    searchParams: Promise<{ q?: string }>;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
    const { q } = await searchParams;

    if (q) {
        return {
            title: `Search: ${q} - HoskSaid`,
            description: `Search results for "${q}" in Charles Hoskinson's transcripts.`,
        };
    }

    return {
        title: "Search - HoskSaid",
        description: "Search through Charles Hoskinson's video transcripts.",
    };
}

async function search(query: string): Promise<VideoWithDetails[]> {
    if (!query.trim()) return [];

    try {
        // Use hybrid search (Server-Side)
        return await hybridSearch(query, 50);
    } catch (error) {
        console.error("Search failed:", error);
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

function highlightText(text: string, query: string): React.ReactNode {
    if (!query.trim()) return text;

    const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));

    return parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
            ? <mark key={i} className="highlight">{part}</mark>
            : part
    );
}

function getSnippet(text: string, query: string, maxLength: number = 200): string {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerText.indexOf(lowerQuery);

    if (index === -1) return text.slice(0, maxLength) + '...';

    const start = Math.max(0, index - 80);
    const end = Math.min(text.length, index + query.length + 80);

    let snippet = text.slice(start, end);
    if (start > 0) snippet = '...' + snippet;
    if (end < text.length) snippet = snippet + '...';

    return snippet;
}

export default async function SearchPage({ searchParams }: PageProps) {
    const { q: query = '' } = await searchParams;
    const results = await search(query);

    return (
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
            {/* Search header */}
            <div className="mb-8">
                <h1 className="text-3xl font-bold mb-6">Search Transcripts</h1>

                <form action="/search" method="GET">
                    <div className="relative">
                        <input
                            type="text"
                            name="q"
                            defaultValue={query}
                            placeholder="Search for topics, quotes, or ideas..."
                            className="w-full h-14 pl-5 pr-14 rounded-xl bg-[var(--background-secondary)] border border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--foreground-muted)] focus:border-[var(--color-primary)] transition-colors"
                            autoFocus
                        />
                        <button
                            type="submit"
                            className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-light)] transition-colors"
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                        </button>
                    </div>
                </form>
            </div>

            {/* Results */}
            {query && (
                <div className="mb-4 text-sm text-[var(--foreground-muted)]">
                    {results.length === 0
                        ? 'No results found'
                        : `Found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}"`
                    }
                </div>
            )}

            {results.length > 0 ? (
                <div className="space-y-6">
                    {results.map((video) => {
                        // Get snippet from transcript if available
                        const transcriptSnippet = video.transcript?.cleaned_text
                            ? getSnippet(video.transcript.cleaned_text, query)
                            : null;

                        return (
                            <Link
                                key={video.id}
                                href={`/videos/${video.youtube_id}`}
                                className="block p-5 rounded-xl bg-[var(--background-secondary)] border border-[var(--border)] card-hover"
                            >
                                <div className="flex gap-4">
                                    {/* Thumbnail */}
                                    <div className="flex-shrink-0 w-32 aspect-video rounded-lg overflow-hidden bg-[var(--background-tertiary)]">
                                        {video.thumbnail_url ? (
                                            <img
                                                src={video.thumbnail_url}
                                                alt={video.title}
                                                className="w-full h-full object-cover"
                                            />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center">
                                                <svg className="w-6 h-6 text-[var(--foreground-muted)]" fill="currentColor" viewBox="0 0 24 24">
                                                    <path d="M8 5v14l11-7z" />
                                                </svg>
                                            </div>
                                        )}
                                    </div>

                                    {/* Content */}
                                    <div className="flex-1 min-w-0">
                                        <h2 className="font-medium line-clamp-2">
                                            {highlightText(video.title, query)}
                                        </h2>
                                        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--foreground-muted)]">
                                            <span>{formatDate(video.published_at)}</span>
                                            {video.duration_seconds && (
                                                <>
                                                    <span>•</span>
                                                    <span>{formatDuration(video.duration_seconds)}</span>
                                                </>
                                            )}
                                        </div>

                                        {/* Transcript snippet */}
                                        {transcriptSnippet && (
                                            <p className="mt-3 text-sm text-[var(--foreground-muted)] line-clamp-2">
                                                {highlightText(transcriptSnippet, query)}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </Link>
                        );
                    })}
                </div>
            ) : query ? (
                <div className="text-center py-16">
                    <svg className="w-16 h-16 mx-auto mb-4 text-[var(--foreground-muted)] opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <p className="text-lg font-medium text-[var(--foreground-muted)]">No results found</p>
                    <p className="mt-2 text-sm text-[var(--foreground-muted)]">
                        Try different keywords or check your spelling
                    </p>
                </div>
            ) : (
                <div className="text-center py-16">
                    <svg className="w-16 h-16 mx-auto mb-4 text-[var(--foreground-muted)] opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <p className="text-lg font-medium text-[var(--foreground-muted)]">Search the transcript library</p>
                    <p className="mt-2 text-sm text-[var(--foreground-muted)]">
                        Find specific topics, quotes, or ideas from Charles Hoskinson&apos;s videos
                    </p>
                </div>
            )}
        </div>
    );
}
