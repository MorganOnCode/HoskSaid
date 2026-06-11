import Link from "next/link";
import Image from "next/image";
import "./home.css";
import { AskProvider } from "@/components/ask/AskProvider";
import { AskBox } from "@/components/ask/AskBox";
import { AnswerShell } from "@/components/ask/AnswerShell";
import { getLatestVideos, getTopicsWithCounts, getMostCitedVideos, getArchiveStats } from "@/lib/browse";
import { formatDuration, formatAgo, formatCount } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [latest, topics, mostCited, stats] = await Promise.all([
    getLatestVideos(5).catch(() => []),
    getTopicsWithCounts(10).catch(() => []),
    getMostCitedVideos(5).catch(() => []),
    getArchiveStats().catch(() => ({ videos: 0, hours: 0, words: 0, last_sync: null })),
  ]);

  const maxCite = Math.max(1, ...mostCited.map((m) => m.cites));
  const hero = latest[0];

  return (
    <div className="wrap">
      <AskProvider>
        <section className="hero">
          <div className="hero-left">
            <span className="eyebrow">
              <span className="dot" />
              {formatCount(stats.videos)} VIDEOS · {formatCount(stats.hours)} HOURS · LIVE INDEX
            </span>
            <h1>What did <em>Charles</em> say?</h1>
            <p className="tagline">Every talk, AMA, and whiteboard — searchable to the moment it was said.</p>

            <AskBox videoCount={stats.videos} />

            <Link className="agent-cue" href="/agents">
              Building with agents? Connect the archive over MCP <span className="arr">→</span>
            </Link>
          </div>

          {hero && (
            <figure className="hero-media">
              <Link className="hm-frame" href={`/video/${hero.youtube_id}`}>
                <Image src="/images/hero/hero.png" alt={hero.title} width={800} height={600} priority />
                <span className="hm-tag"><span className="dot" />LATEST</span>
                <span className="hm-cap">
                  <span className="t">{hero.title}</span>
                  <span className="m">
                    <span>{hero.segment_count} segments</span><span>·</span>
                    <span>{formatAgo(hero.published_at)}</span>
                  </span>
                </span>
              </Link>
            </figure>
          )}
        </section>

        <AnswerShell />
      </AskProvider>

      <div className="cols">
        <section>
          <div className="sec-head">
            <h2>Latest <em>videos</em></h2>
            <span className="ln" />
            <span className="more">{stats.last_sync ? `UPDATED ${formatAgo(stats.last_sync).toUpperCase()}` : ""}</span>
          </div>
          <div className="vid-list">
            {latest.map((v) => (
              <Link className="vid-row" key={v.youtube_id} href={`/video/${v.youtube_id}`}>
                <div className="thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`https://i.ytimg.com/vi/${v.youtube_id}/mqdefault.jpg`} alt="" loading="lazy" />
                  <span className="dur">{formatDuration(v.duration_seconds)}</span>
                </div>
                <div>
                  <div className="vid-title">{v.title}</div>
                  <div className="vid-meta">
                    <span className="seg">{v.segment_count} segments</span><span>·</span>
                    <span>{formatAgo(v.published_at)}</span>
                    {v.view_count ? <><span>·</span><span>{formatCount(v.view_count)} views</span></> : null}
                  </div>
                </div>
                <span className="vid-go">OPEN →</span>
              </Link>
            ))}
          </div>
        </section>

        <aside className="aside">
          <div className="panel">
            <div className="panel-hd"><span className="t">Most cited</span><span className="m">BY ANSWERS</span></div>
            {mostCited.map((m, i) => (
              <Link className={"rank-row" + (i < 2 ? " hot" : "")} key={m.youtube_id} href={`/video/${m.youtube_id}`}>
                <span className="rank-num">{i + 1}</span>
                <div className="rank-body">
                  <div className="rank-title">{m.title}</div>
                  <div className="rank-bar"><span style={{ width: `${Math.round((m.cites / maxCite) * 100)}%` }} /></div>
                </div>
                <div className="rank-meta"><span className="rank-ct">{formatCount(m.cites)}</span></div>
              </Link>
            ))}
          </div>

          <div className="panel">
            <div className="panel-hd"><span className="t">Browse by topic</span><span className="m">{topics.length} TOPICS</span></div>
            <div className="topic-wrap">
              {topics.map((t) => (
                <Link
                  className={"topic" + (t.citation_count > 0 || t.video_count > 10 ? " hot" : "")}
                  key={t.slug}
                  href={`/topics?t=${t.slug}`}
                >
                  {t.name} <span className="ct">{t.citation_count || t.video_count}</span>
                </Link>
              ))}
            </div>
          </div>

          <div className="stat-grid">
            <div className="stat"><span className="n">{formatCount(stats.videos)}</span><span className="l">videos indexed</span></div>
            <div className="stat"><span className="n">{formatCount(stats.hours)}<em>h</em></span><span className="l">of transcripts</span></div>
            <div className="stat"><span className="n">{formatCount(stats.words)}</span><span className="l">words searchable</span></div>
            <div className="stat"><span className="n">{stats.last_sync ? formatAgo(stats.last_sync) : "—"}</span><span className="l">since last sync</span></div>
          </div>
        </aside>
      </div>
    </div>
  );
}
