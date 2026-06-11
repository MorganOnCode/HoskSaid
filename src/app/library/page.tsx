import Link from "next/link";
import "../browse.css";
import { getLibraryVideos, type LibrarySort } from "@/lib/browse";
import { LibraryToolbar } from "@/components/browse/LibraryToolbar";
import { formatDuration, formatDate, formatCount } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Library" };

const PAGE = 24;

interface SP { type?: string; topic?: string; sort?: string; q?: string; page?: string }

export default async function LibraryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sort = (sp.sort as LibrarySort) || "recent";
  const page = Math.max(1, parseInt(sp.page || "1", 10) || 1);
  const limit = PAGE * page;

  const { rows, total } = await getLibraryVideos({
    type: sp.type,
    topic: sp.topic,
    q: sp.q,
    sort,
    limit,
    offset: 0,
  });

  return (
    <div className="wrap">
      <LibraryToolbar type={sp.type || "all"} sort={sort} q={sp.q || ""} />

      <div className="count-line">Showing <b>{rows.length}</b> of {formatCount(total)} videos</div>

      {rows.length === 0 ? (
        <div className="count-line" style={{ padding: "40px 0" }}>No videos match — try a different filter.</div>
      ) : (
        <div className="lib-grid">
          {rows.map((v) => (
            <Link className="vcard" key={v.youtube_id} href={`/video/${v.youtube_id}`}>
              <div className="th">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`https://i.ytimg.com/vi/${v.youtube_id}/mqdefault.jpg`} alt="" loading="lazy" />
                {v.video_type ? <span className="type">{v.video_type}</span> : null}
                <span className="dur">{formatDuration(v.duration_seconds)}</span>
              </div>
              <div className="body">
                <div className="vtitle">{v.title}</div>
                <div className="vmeta">
                  {v.published_at ? <span>{formatDate(v.published_at)}</span> : null}
                  <span className="sep">·</span><span className="seg">{v.segment_count} segments</span>
                  {v.view_count ? <><span className="sep">·</span><span>{formatCount(v.view_count)} views</span></> : null}
                  {v.cite_count ? <><span className="sep">·</span><span>{v.cite_count} cites</span></> : null}
                </div>
                {v.tags.length > 0 && (
                  <div className="vfoot"><div className="tags">{v.tags.map((t) => <span className="tg" key={t}>{t}</span>)}</div></div>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {rows.length < total && (
        <div className="loadmore">
          <Link className="btn" href={{ query: { ...sp, page: page + 1 } }}>Load {Math.min(PAGE, total - rows.length)} more ↓</Link>
        </div>
      )}
    </div>
  );
}
