"use client";

import Link from "next/link";
import { formatDate } from "@/lib/format";
import type { AskSource } from "@/lib/ask-types";

/** A source card in the answer's source rail (.sa-source). */
export function SourceCard({
  source,
  active,
  onEnter,
  onLeave,
}: {
  source: AskSource;
  active: boolean;
  onEnter?: () => void;
  onLeave?: () => void;
}) {
  const thumb = `https://i.ytimg.com/vi/${source.video_id}/mqdefault.jpg`;
  const dateLabel = source.date ? formatDate(source.date) : "";
  return (
    <Link
      href={source.url}
      className="sa-source"
      data-n={source.n}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={active ? { borderColor: "var(--accent)", transform: "translateY(-2px)" } : undefined}
    >
      <div className="th">
        {/* eslint-disable-next-line @next/next/no-img-element -- remote YT thumbnail */}
        <img src={thumb} alt="" loading="lazy" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        <span className="play">▶</span>
        <span className="ts">{source.timestamp}</span>
      </div>
      <div className="body">
        <span className="num">{source.n}</span>
        <div className="ct">{source.title}</div>
        <div className="cm">
          {dateLabel ? <span>{dateLabel}</span> : null}
          {dateLabel ? <span>·</span> : null}
          <span>{source.cite_count} {source.cite_count === 1 ? "cite" : "cites"}</span>
        </div>
      </div>
    </Link>
  );
}
