import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import "../../video.css";
import { getVideoByYoutubeId } from "@/lib/db";
import { getVideoChunks, getLatestVideos } from "@/lib/browse";
import { deriveSummaryPoints } from "@/lib/transcript-utils";
import { AskProvider } from "@/components/ask/AskProvider";
import { AnswerShell } from "@/components/ask/AnswerShell";
import { VideoDetailClient } from "@/components/video/VideoDetailClient";
import { ChapterList, type Chapter } from "@/components/video/ChapterList";
import { VideoSummary } from "@/components/video/VideoSummary";
import { VideoAskBox } from "@/components/video/VideoAskBox";
import { formatCount, formatDuration, formatDate, formatAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const video = await getVideoByYoutubeId(id);
  if (!video) return { title: "Video not found" };
  const desc = video.transcript?.summary?.slice(0, 160) || video.description?.slice(0, 160);
  return {
    title: video.title,
    description: desc,
    openGraph: {
      title: video.title,
      description: desc,
      type: "video.other",
      images: video.thumbnail_url ? [video.thumbnail_url] : [],
    },
  };
}

export default async function VideoPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { t } = await searchParams;
  const video = await getVideoByYoutubeId(id);
  if (!video) notFound();

  const startSeconds = Math.max(0, parseInt(t || "0", 10) || 0);
  const channel = video.channel;

  const [{ timed, count: segCount }, latest] = await Promise.all([
    getVideoChunks(video.id),
    getLatestVideos(6).catch(() => []),
  ]);

  // Paragraph fallback when no timed segments exist yet (pre-backfill).
  const paragraphs =
    timed.length === 0 && video.transcript?.cleaned_text
      ? video.transcript.cleaned_text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
      : undefined;

  const chapters: Chapter[] = Array.isArray(video.chapters) ? (video.chapters as Chapter[]) : [];
  const summaryPoints = deriveSummaryPoints(video.transcript?.summary, timed);
  const related = latest.filter((v) => v.youtube_id !== video.youtube_id).slice(0, 3);

  const metaBits = [
    video.published_at ? formatDate(video.published_at) : null,
    video.duration_seconds ? formatDuration(video.duration_seconds) : null,
    segCount ? `${segCount} segments` : null,
    video.view_count ? `${formatCount(video.view_count)} views` : null,
  ].filter(Boolean);

  return (
    <div className="wrap">
      <div className="crumb">
        <Link href="/library">Library</Link><span className="sep">/</span>
        {video.video_type ? <><Link href={`/library?type=${video.video_type}`}>{video.video_type}</Link><span className="sep">/</span></> : null}
        <span className="cur">{video.title.slice(0, 48)}{video.title.length > 48 ? "…" : ""}</span>
      </div>

      <AskProvider fixedFilters={{ video_ids: [video.youtube_id] }}>
        <VideoDetailClient
          youtubeId={video.youtube_id}
          startSeconds={startSeconds}
          segments={timed.length > 0 ? timed : undefined}
          paragraphs={paragraphs}
        >
          <div className="vhead">
            <h1>{video.title}</h1>
            <div className="vmeta">
              {metaBits.map((b, i) => (
                <span key={i}>
                  {i > 0 ? <span className="sep">·</span> : null} <span className={b!.includes("segments") ? "seg" : ""}>{b}</span>
                </span>
              ))}
              {video.published_at ? <><span className="sep">·</span><span>indexed {formatAgo(video.created_at)}</span></> : null}
            </div>
            <div className="vactions">
              <a className="btn accent" href={`https://www.youtube.com/watch?v=${video.youtube_id}`} target="_blank" rel="noopener noreferrer">▶ Watch on YouTube</a>
            </div>
          </div>

          {video.tags && video.tags.length > 0 && (
            <div className="vtags">
              {video.tags.map((tag) => (
                <Link key={tag.id} href={`/library?q=${encodeURIComponent(tag.name)}`} className="topic" style={{ fontSize: 12.5, padding: "6px 11px" }}>
                  {tag.name}
                </Link>
              ))}
            </div>
          )}

          <VideoAskBox videoTitle={video.title} segmentCount={segCount} />
          <AnswerShell />

          {chapters.length > 0 ? <ChapterList chapters={chapters} /> : <VideoSummary points={summaryPoints} />}
        </VideoDetailClient>

        {related.length > 0 && (
          <section className="related">
            <div className="sec-head"><h2>Related <em>talks</em></h2><span className="ln" /><span className="more">RECENT</span></div>
            {related.map((m) => (
              <Link className="vid-row" key={m.youtube_id} href={`/video/${m.youtube_id}`}>
                <div className="thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`https://i.ytimg.com/vi/${m.youtube_id}/mqdefault.jpg`} alt="" loading="lazy" />
                  <span className="dur">{formatDuration(m.duration_seconds)}</span>
                </div>
                <div>
                  <div className="vid-title">{m.title}</div>
                  <div className="vid-meta"><span className="seg">{m.segment_count} segments</span><span>·</span><span>{formatAgo(m.published_at)}</span></div>
                </div>
                <span className="vid-go">OPEN →</span>
              </Link>
            ))}
          </section>
        )}
      </AskProvider>
    </div>
  );
}
