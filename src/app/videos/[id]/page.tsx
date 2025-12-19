import { notFound } from "next/navigation";
import Link from "next/link";
import { createBrowserClient, getVideoByYoutubeId, type VideoWithDetails } from "@/lib/supabase";
import { Metadata } from "next";
import { CopyButton } from "@/components/CopyButton";
import { cleanTranscriptText } from "@/lib/transcript";

export const revalidate = 300;

interface PageProps {
    params: Promise<{ id: string }>;
}

async function getVideo(youtubeId: string): Promise<VideoWithDetails | null> {
    try {
        const supabase = createBrowserClient();
        return await getVideoByYoutubeId(supabase, youtubeId);
    } catch (error) {
        console.error("Failed to fetch video:", error);
        return null;
    }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const { id } = await params;
    const video = await getVideo(id);

    if (!video) {
        return { title: "Video Not Found - HoskSaid" };
    }

    return {
        title: `${video.title} - HoskSaid`,
        description: video.transcript?.summary?.slice(0, 160) || video.description?.slice(0, 160),
        openGraph: {
            title: video.title,
            description: video.transcript?.summary?.slice(0, 160) || video.description?.slice(0, 160),
            type: "video.other",
            images: video.thumbnail_url ? [video.thumbnail_url] : [],
        },
    };
}

function formatDate(dateString?: string): string {
    if (!dateString) return "";
    return new Date(dateString).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    });
}

function formatDuration(seconds?: number): string {
    if (!seconds) return "";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function Summary({ text }: { text: string }) {
    const bullets = text.split('\n').filter(line => line.trim().startsWith('•'));

    if (bullets.length > 0) {
        return (
            <ul className="space-y-2">
                {bullets.map((bullet, i) => (
                    <li key={i} className="flex gap-2">
                        <span className="text-[var(--color-accent)]">•</span>
                        <span>{bullet.replace(/^• /, '')}</span>
                    </li>
                ))}
            </ul>
        );
    }

    return <p className="whitespace-pre-wrap">{text}</p>;
}

function Transcript({ text }: { text: string }) {
    // Clean up the transcript text
    const cleanedText = cleanTranscriptText(text, {
        removeFillers: true,
        addParagraphs: true,
        sentencesPerParagraph: 5,
    });

    // Split into paragraphs
    const paragraphs = cleanedText.split('\n\n').filter(p => p.trim());

    return (
        <div className="transcript-text space-y-4 leading-relaxed">
            {paragraphs.map((paragraph, i) => (
                <p key={i} className="text-[var(--foreground-muted)]">{paragraph}</p>
            ))}
        </div>
    );
}

export default async function VideoPage({ params }: PageProps) {
    const { id } = await params;
    const video = await getVideo(id);

    if (!video) {
        notFound();
    }

    return (
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            {/* Back link */}
            <Link
                href="/videos"
                className="inline-flex items-center gap-2 text-sm text-[var(--foreground-muted)] hover:text-[var(--foreground)] mb-6"
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back to videos
            </Link>

            {/* Video embed */}
            <div className="video-container rounded-xl overflow-hidden bg-[var(--background-secondary)]">
                <iframe
                    src={`https://www.youtube.com/embed/${video.youtube_id}`}
                    title={video.title}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                />
            </div>

            {/* Video info */}
            <div className="mt-6">
                <h1 className="text-2xl sm:text-3xl font-bold leading-tight">{video.title}</h1>

                <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-[var(--foreground-muted)]">
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
                    <a
                        href={`https://www.youtube.com/watch?v=${video.youtube_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline ml-auto"
                    >
                        Watch on YouTube
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                    </a>
                </div>

                {/* Tags */}
                {video.tags && video.tags.length > 0 && (
                    <div className="mt-6 flex flex-wrap gap-2">
                        {video.tags.map((tag) => (
                            <Link
                                key={tag.id}
                                href={`/search?q=${encodeURIComponent(tag.name)}`}
                                className="px-3 py-1 rounded-full text-xs font-medium bg-[var(--background-tertiary)] text-[var(--foreground-muted)] hover:bg-[var(--color-primary)] hover:text-white transition-colors"
                            >
                                {tag.name}
                            </Link>
                        ))}
                    </div>
                )}
            </div>

            {/* Summary */}
            {video.transcript?.summary && (
                <section className="mt-8 p-6 rounded-xl bg-[var(--background-secondary)] border border-[var(--border)]">
                    <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-[var(--color-accent)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Summary
                    </h2>
                    <div className="text-[var(--foreground-muted)]">
                        <Summary text={video.transcript.summary} />
                    </div>
                </section>
            )}

            {/* Transcript */}
            {video.transcript?.cleaned_text && (
                <section className="mt-8">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-semibold flex items-center gap-2">
                            <svg className="w-5 h-5 text-[var(--color-accent)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                            </svg>
                            Full Transcript
                        </h2>
                        <CopyButton text={video.transcript?.cleaned_text || ''} />
                    </div>
                    <div className="p-6 rounded-xl bg-[var(--background-secondary)] border border-[var(--border)] max-h-[600px] overflow-y-auto">
                        <Transcript text={video.transcript.cleaned_text} />
                    </div>
                </section>
            )}

            {/* Error report section */}
            <section className="mt-12 p-6 rounded-xl border border-[var(--border)]">
                <h3 className="text-sm font-medium text-[var(--foreground-muted)] mb-2">
                    Found an error in the transcript?
                </h3>
                <p className="text-sm text-[var(--foreground-muted)]">
                    Help improve this transcript by{" "}
                    <a
                        href={`mailto:report@hosksaid.com?subject=Transcript Error: ${encodeURIComponent(video.title)}`}
                        className="text-[var(--color-accent)] hover:underline"
                    >
                        reporting an error
                    </a>.
                </p>
            </section>
        </div>
    );
}
