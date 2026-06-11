"use client";

import { formatTimecode } from "@/lib/format";
import type { SummaryPoint } from "@/lib/transcript-utils";
import { usePlayer } from "./VideoDetailClient";

/**
 * "Key takeaways" — AI summary bullets. Bullets anchored to a transcript moment
 * are buttons that seek the player; unanchored bullets render as plain text.
 * Shown on the video page when no chapters have been derived yet.
 */
export function VideoSummary({ points }: { points: SummaryPoint[] }) {
  const { seek } = usePlayer();
  if (points.length === 0) return null;

  return (
    <div className="vsum">
      <div className="vsum-hd">
        <span className="vsum-ttl"><span className="tagdot">◈</span> Key takeaways</span>
        <span className="kicker">AI summary · {points.length} {points.length === 1 ? "point" : "points"}</span>
      </div>
      <div className="vsum-list">
        {points.map((p, i) =>
          p.start != null ? (
            <button key={i} className="vsum-item" onClick={() => seek(p.start as number)} type="button">
              <span className="vsum-ts">{formatTimecode(p.start)}</span>
              <span className="vsum-tx">{p.text}</span>
            </button>
          ) : (
            <div key={i} className="vsum-item noseek">
              <span className="vsum-tx">{p.text}</span>
            </div>
          )
        )}
      </div>
      <div className="vsum-foot">Generated from the transcript — jump to any point to verify.</div>
    </div>
  );
}
