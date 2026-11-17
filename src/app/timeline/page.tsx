import Link from "next/link";
import "../browse.css";
import { getTimelineVideos, type VideoCard } from "@/lib/browse";
import { formatDuration, formatCount } from "@/lib/format";
import { decodeEntities } from "@/lib/text";

export const dynamic = "force-dynamic";
export const metadata = { title: "Timeline", alternates: { canonical: "/timeline" } };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthKey(d: string): string {
  const dt = new Date(d);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function TimelinePage() {
  const { videos, total } = await getTimelineVideos().catch(() => ({ videos: [] as VideoCard[], total: 0 }));
  const dated = videos.filter((v) => v.published_at);
  const undated = videos.length - dated.length;

  // Group by month, newest first.
  const groups: { key: string; label: string; year: number; items: VideoCard[] }[] = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const v of dated) {
    const key = monthKey(v.published_at!);
    let g = byKey.get(key);
    if (!g) {
      const dt = new Date(v.published_at!);
      g = { key, label: MONTHS[dt.getUTCMonth()], year: dt.getUTCFullYear(), items: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.items.push(v);
  }

  // Year index for the rail (the month list is too long to stay sticky).
  const years: { year: number; firstKey: string; count: number }[] = [];
  for (const g of groups) {
    const last = years[years.length - 1];
    if (last && last.year === g.year) last.count += g.items.length;
    else years.push({ year: g.year, firstKey: g.key, count: g.items.length });
  }

  return (
    <div className="wrap">
      <div className="page-head">
        <span className="eyebrow"><span className="dot" />{formatCount(dated.length)} DATED VIDEOS · NEWEST FIRST</span>
        <h1>The <em>timeline</em></h1>
        <p className="sub">The whole archive in sequence — talks, AMAs and whiteboards as they aired.</p>
        {undated > 0 || total > videos.length ? (
          <p className="count-line" style={{ marginTop: 14 }}>
            {undated > 0 ? `${undated} videos without a publish date are not shown. ` : ""}
            {total > videos.length ? `Showing the newest ${videos.length} of ${total}.` : ""}
          </p>
        ) : null}
      </div>

      <div className="tllayout">
        <nav className="rail" aria-label="Jump to year">
          <div className="rl-h">Jump to year</div>
          {years.map((y) => (
            <a className="rl-item" key={y.year} href={`#m-${y.firstKey}`}>
              <span className="ml">{y.year}</span>
              <span className="ct">{y.count}</span>
            </a>
          ))}
        </nav>

        <div className="tl">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="tl-month" id={`m-${g.key}`}>
                <h2>{g.label}</h2><span className="ct">{g.year}</span>
                <span className="ln" /><span className="ct">{g.items.length} videos</span>
              </div>
              {g.items.map((v) => {
                const dt = new Date(v.published_at!);
                return (
                  <div className="tl-row" key={v.youtube_id}>
                    <span className="node" />
                    <Link className="tl-card" href={`/video/${v.youtube_id}`}>
                      <div className="date"><b>{String(dt.getUTCDate()).padStart(2, "0")}</b>{MONTHS[dt.getUTCMonth()]}</div>
                      <div className="mid">
                        <div className="tt">{decodeEntities(v.title)}</div>
                        <div className="mt">
                          {v.video_type ? <span className="type">{v.video_type}</span> : null}
                          <span className="seg">{v.segment_count} segments</span>
                          {v.duration_seconds ? <><span className="sep">·</span><span>{formatDuration(v.duration_seconds)}</span></> : null}
                        </div>
                      </div>
                      <span className="go">OPEN →</span>
                    </Link>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
