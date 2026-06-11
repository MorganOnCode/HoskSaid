import Link from "next/link";
import "../browse.css";
import { getTimelineVideos, type VideoCard } from "@/lib/browse";
import { formatDuration } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Timeline" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthKey(d: string): string {
  const dt = new Date(d);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function TimelinePage() {
  const videos = await getTimelineVideos(400).catch(() => []);
  const dated = videos.filter((v) => v.published_at);

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

  return (
    <div className="wrap">
      <div className="page-head">
        <span className="eyebrow"><span className="dot" />EVERY UPLOAD · IN ORDER</span>
        <h1>The <em>timeline</em></h1>
        <p className="sub">The whole archive in sequence — talks, AMAs and whiteboards as they aired.</p>
      </div>

      <div className="tllayout">
        <div className="rail">
          <div className="rl-h">Jump to month</div>
          {groups.map((g) => (
            <a className="rl-item" key={g.key} href={`#m-${g.key}`}>
              <span className="ml">{g.label} {g.year}</span>
              <span className="ct">{g.items.length}</span>
            </a>
          ))}
        </div>

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
                        <div className="tt">{v.title}</div>
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
