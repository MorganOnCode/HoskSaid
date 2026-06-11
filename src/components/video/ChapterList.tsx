"use client";

import { usePlayer } from "./VideoDetailClient";
import { formatTimecode } from "@/lib/format";

export interface Chapter {
  t_seconds: number;
  title: string;
}

/** Seekable chapter list; the chapter containing the playhead is highlighted. */
export function ChapterList({ chapters }: { chapters: Chapter[] }) {
  const { seek, currentTime } = usePlayer();
  if (!chapters.length) return null;

  let activeIdx = 0;
  for (let i = 0; i < chapters.length; i++) if (chapters[i].t_seconds <= currentTime + 0.25) activeIdx = i;

  return (
    <div style={{ marginTop: 30 }}>
      <div className="sec-head">
        <h2>In this <em>video</em></h2>
        <span className="ln" />
        <span className="more">{chapters.length} CHAPTERS</span>
      </div>
      <div className="chap-list">
        {chapters.map((c, i) => (
          <button
            key={i}
            type="button"
            className={"chap-item" + (i === activeIdx ? " active" : "")}
            onClick={() => seek(c.t_seconds)}
          >
            <span className="ts">{formatTimecode(c.t_seconds)}</span>
            <span className="nm">{c.title}</span>
            <span />
          </button>
        ))}
      </div>
    </div>
  );
}
