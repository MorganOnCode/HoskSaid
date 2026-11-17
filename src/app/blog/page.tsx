import Link from "next/link";
import "../browse.css";
import { listPublishedPosts } from "@/lib/posts";
import { coverageSentence, postPeriodLabel } from "@/lib/render/post";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Blog",
  description: "Monthly, source-linked digests of what Charles Hoskinson discussed in his public videos.",
  alternates: { canonical: "/blog", types: { "application/rss+xml": "/blog/feed.xml" } },
};

/** Published posts only; drafts and withdrawn posts never appear here. */
export default async function BlogIndex() {
  const posts = await listPublishedPosts().catch(() => []);
  return (
    <div className="wrap">
      <div className="page-head">
        <span className="eyebrow"><span className="dot" />MONTHLY DIGEST · <a href="/blog/feed.xml">RSS</a></span>
        <h1>The month in <em>Charles&apos;s words</em></h1>
        <p className="sub">What Charles discussed in his public videos each month. Every paragraph links to the video it comes from.</p>
      </div>
      {posts.length === 0 ? (
        <div className="empty-card">
          <h2>No posts published yet</h2>
          <p>Monthly digests are drafted from the archive and published only after an editor has reviewed them against their sources.</p>
        </div>
      ) : (
        <ul className="post-list">
          {posts.map((p) => (
            <li key={p.id}>
              <Link className="post-card" href={`/blog/${p.slug}`}>
                <span className="eyebrow">{postPeriodLabel(p).toUpperCase()}</span>
                <h2>{p.title}</h2>
                {p.dek ? <p>{p.dek}</p> : null}
                <span className="meta">{coverageSentence(p.coverage, p.period)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
