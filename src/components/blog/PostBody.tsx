import Link from "next/link";
import { missingReason, resolveCite, videoHref, youtubeHref } from "@/lib/render/post";
import { formatTimecode } from "@/lib/format";
import { YOUTUBE_ID_RE, type PostParagraph, type PublicPost } from "@/lib/posts";

function Para({ p, post }: { p: PostParagraph; post: PublicPost }) {
  return (
    <p>
      {p.text}{" "}
      {p.cites.map((c) => {
        const link = resolveCite(c, post.sources);
        return link ? (
          <Link key={c} className="pcite" href={link.href} aria-label={`Source ${link.label}: ${link.title}`}>
            {link.label}
          </Link>
        ) : null;
      })}
    </p>
  );
}

/** A post's structured body as escaped React text, with source and timestamp links. */
export function PostBody({ post }: { post: PublicPost }) {
  const sources = post.sources.filter((s) => YOUTUBE_ID_RE.test(s.video_id));
  return (
    <article className="prose post">
      {post.body.intro.map((p, i) => <Para key={`i${i}`} p={p} post={post} />)}
      {post.body.sections.map((s, i) => (
        <section key={`s${i}`}>
          <h2>{s.heading}</h2>
          {s.paragraphs.map((p, j) => <Para key={j} p={p} post={post} />)}
        </section>
      ))}
      {post.coverage.missing.length ? (
        <>
          <h2>Not covered in this digest</h2>
          <ul className="post-missing">
            {post.coverage.missing.map((m) => (
              <li key={m.video_id}>
                {YOUTUBE_ID_RE.test(m.video_id) ? <a href={youtubeHref(m.video_id)}>{m.title}</a> : m.title} <span className="when">· {missingReason(m.reason)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h2>Sources</h2>
      <ol className="post-sources">
        {sources.map((s) => (
          <li key={s.id} id={`source-${s.id}`}>
            <Link href={videoHref(s.video_id)}>{s.title}</Link> <span className="when">· {s.published_at.slice(0, 10)}</span>{" "}
            <a href={youtubeHref(s.video_id)} aria-label={`${s.title} on YouTube`}>YouTube</a>
            {s.moments.length ? (
              <span className="moments">
                {s.moments.map((m) =>
                  Number.isInteger(m.start_seconds) && m.start_seconds >= 0 ? (
                    <Link key={m.id} href={videoHref(s.video_id, "", m.start_seconds)} aria-label={`${s.title} at ${formatTimecode(m.start_seconds)}`}>
                      {formatTimecode(m.start_seconds)}
                    </Link>
                  ) : null
                )}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </article>
  );
}
