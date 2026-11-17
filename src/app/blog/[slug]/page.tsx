import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import "../../browse.css";
import { getPublishedPost } from "@/lib/posts";
import { coverageSentence, postPeriodLabel } from "@/lib/render/post";
import { PostBody } from "@/components/blog/PostBody";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPublishedPost(slug).catch(() => null);
  if (!post) return { title: "Post not found" };
  return {
    title: post.title,
    description: post.dek ?? undefined,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: { title: post.title, description: post.dek ?? undefined, type: "article" },
  };
}

/** Published posts only: drafts and withdrawn posts are a 404 here. */
export default async function BlogPost({ params }: Props) {
  const { slug } = await params;
  const post = await getPublishedPost(slug).catch(() => null);
  if (!post) notFound();
  const label = postPeriodLabel(post);
  return (
    <div className="wrap">
      <nav className="crumb post-crumb" aria-label="Breadcrumb">
        <Link href="/blog">Blog</Link> <span aria-hidden="true">/</span> <span>{label}</span>
      </nav>
      <div className="page-head">
        <span className="eyebrow"><span className="dot" />{label.toUpperCase()} · MONTHLY DIGEST</span>
        <h1>{post.title}</h1>
        {post.dek ? <p className="sub">{post.dek}</p> : null}
        <p className="count-line post-note">
          {coverageSentence(post.coverage, post.period)} Drafted with AI from each video&apos;s stored summary and transcript excerpts, checked against
          the cited sources and reviewed before publication{post.published_at ? ` on ${formatDate(post.published_at)}` : ""}.
        </p>
      </div>
      <PostBody post={post} />
    </div>
  );
}
