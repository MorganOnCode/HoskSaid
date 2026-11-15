import Link from "next/link";
import "../browse.css";
import { getTopicsWithCounts } from "@/lib/browse";
import { formatCount } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Topics", alternates: { canonical: "/topics" } };

export default async function TopicsPage() {
  const topics = await getTopicsWithCounts().catch(() => []);
  const ranked = [...topics].sort((a, b) => (b.citation_count - a.citation_count) || (b.video_count - a.video_count));
  const max = Math.max(1, ...ranked.map((t) => t.citation_count || t.video_count));
  const anyCited = ranked.some((t) => t.citation_count > 0);
  const featured = ranked.slice(0, 3);

  if (topics.length === 0) {
    return (
      <div className="wrap">
        <div className="page-head">
          <span className="eyebrow"><span className="dot" />TOPICS</span>
          <h1>What Charles keeps <em>coming back to</em></h1>
        </div>
        <div className="empty-card">
          <h2>Topics haven&apos;t been assigned yet</h2>
          <p>
            The archive has a curated list of themes, but no videos have been classified into them yet, so there is
            nothing honest to rank. Until then, search titles, tags and full transcripts in the{" "}
            <Link href="/library" style={{ textDecoration: "underline" }}>Library</Link>, or ask a question on the{" "}
            <Link href="/" style={{ textDecoration: "underline" }}>home page</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="page-head">
        <span className="eyebrow"><span className="dot" />{topics.length} TOPICS WITH ASSIGNED VIDEOS</span>
        <h1>What Charles keeps <em>coming back to</em></h1>
        <p className="sub">{anyCited ? "Recurring themes in the archive, ranked by how often answers draw on them." : "Recurring themes in the archive, ranked by how many videos cover them."}</p>
      </div>

      <div className="feature">
        {featured.map((t, i) => (
          <Link className="feat" key={t.slug} href={`/library?topic=${t.slug}`}>
            <div className="rank">#{i + 1} {anyCited ? "MOST-CITED THEME" : "MOST-COVERED THEME"}</div>
            <h3>{t.name}</h3>
            <div className="nums">
              <span><b>{formatCount(t.citation_count)}</b> citations</span>
              <span><b>{t.video_count}</b> videos</span>
              {t.trend_pct > 0 ? <span className="delta up">▲ {t.trend_pct}%</span> : null}
            </div>
            <div className="bar"><span style={{ width: `${Math.round(((t.citation_count || t.video_count) / max) * 100)}%` }} /></div>
          </Link>
        ))}
      </div>

      <div className="count-line">All <b>{topics.length}</b> topics</div>

      <div className="topic-grid">
        {ranked.map((t) => {
          const hot = t.trend_pct >= 50 || t.citation_count > 0;
          return (
            <Link className={"tcard" + (hot ? " hot" : "")} key={t.slug} href={`/library?topic=${t.slug}`}>
              <div className="l">
                <div className="tname">{t.name}</div>
                <div className="tnums">
                  <span><b>{formatCount(t.citation_count)}</b> citations</span>
                  <span className="seg">{t.video_count} videos</span>
                  <span>{formatCount(t.segment_count)} segments</span>
                </div>
                <div className="bar"><span style={{ width: `${Math.round(((t.citation_count || t.video_count) / max) * 100)}%` }} /></div>
              </div>
              <div className="right">
                {t.trend_pct > 0 ? <span className="delta up">▲ {t.trend_pct}%</span> : <span className="delta flat">—</span>}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
