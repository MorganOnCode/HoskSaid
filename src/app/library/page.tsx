import Link from "next/link";
import "../browse.css";
import { getLibraryVideos, getVideoTypeCounts, VIDEO_TYPES, type LibrarySort } from "@/lib/browse";
import { LibraryToolbar } from "@/components/browse/LibraryToolbar";
import { formatDuration, formatDate, formatCount } from "@/lib/format";
import { decodeEntities } from "@/lib/text";

export const dynamic = "force-dynamic";
export const metadata = { title: "Library", alternates: { canonical: "/library" } };

const PAGE = 24;
const MAX_PAGES = 40;
const SORTS: LibrarySort[] = ["recent", "cited", "viewed", "longest"];

interface SP { type?: string; topic?: string; sort?: string; q?: string; page?: string }

/** Render a ts_headline excerpt (\u0001…\u0002 mark matches) as text + <mark>. */
function Snippet({ text }: { text: string }) {
  const parts = decodeEntities(text).split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <p className="vsnip">
      …{parts.map((p, i) =>
        p.startsWith("\u0001") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>
      )}…
    </p>
  );
}

export default async function LibraryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sort = SORTS.find((s) => s === sp.sort) ?? "recent";
  const page = Math.min(MAX_PAGES, Math.max(1, parseInt(sp.page || "1", 10) || 1));
  const limit = PAGE * page;
  const type = VIDEO_TYPES.find((t) => t === sp.type);
  const topic = typeof sp.topic === "string" && /^[a-z0-9-]{1,60}$/.test(sp.topic) ? sp.topic : undefined;
  const q = (sp.q || "").slice(0, 200);

  const [{ rows, total }, typeCounts] = await Promise.all([
    getLibraryVideos({ type, topic, q, sort, limit, offset: 0 }),
    getVideoTypeCounts().catch(() => []),
  ]);

  return (
    <div className="wrap">
      <LibraryToolbar type={type || "all"} sort={sort} q={q} types={typeCounts} />

      <div className="count-line" role="status">
        Showing <b>{rows.length}</b> of {formatCount(total)} videos
        {q ? <> matching “{q}” in titles, tags or transcripts</> : null}
        {topic ? <> in topic “{topic}”</> : null}
      </div>

      {rows.length === 0 ? (
        <div className="count-line" style={{ padding: "40px 0" }}>No videos match — try a different filter or search.</div>
      ) : (
        <div className="lib-grid">
          {rows.map((v) => (
            <Link
              className="vcard"
              key={v.youtube_id}
              href={v.matched_in === "transcript" && q ? `/video/${v.youtube_id}?q=${encodeURIComponent(q)}` : `/video/${v.youtube_id}`}
            >
              <div className="th">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`https://i.ytimg.com/vi/${v.youtube_id}/mqdefault.jpg`} alt="" loading="lazy" />
                {v.video_type ? <span className="type">{v.video_type}</span> : null}
                <span className="dur">{formatDuration(v.duration_seconds)}</span>
              </div>
              <div className="body">
                <div className="vtitle">{decodeEntities(v.title)}</div>
                <div className="vmeta">
                  {v.published_at ? <span>{formatDate(v.published_at)}</span> : null}
                  <span className="sep">·</span>
                  {v.segment_count ? <span className="seg">{v.segment_count} segments</span> : <span>keyword search only</span>}
                  {v.view_count ? <><span className="sep">·</span><span>{formatCount(v.view_count)} views</span></> : null}
                  {v.cite_count ? <><span className="sep">·</span><span>{v.cite_count} cites</span></> : null}
                </div>
                {v.matched_in === "transcript" && v.snippet ? <Snippet text={v.snippet} /> : null}
                {v.tags.length > 0 && (
                  <div className="vfoot"><div className="tags">{v.tags.map((t) => <span className="tg" key={t}>{t}</span>)}</div></div>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {rows.length < total && page < MAX_PAGES && (
        <div className="loadmore">
          <Link className="btn" href={{ query: { ...sp, page: page + 1 } }} scroll={false}>Load {Math.min(PAGE, total - rows.length)} more ↓</Link>
        </div>
      )}
    </div>
  );
}
