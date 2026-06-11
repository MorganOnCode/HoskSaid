"use client";

import { useState } from "react";
import { useAsk } from "@/components/ask/AskProvider";

/** Scoped question box on the video page. The AskProvider it sits inside is
 *  configured with fixedFilters={video_ids:[id]}, so answers cover only this video. */
export function VideoAskBox({ videoTitle, segmentCount }: { videoTitle: string; segmentCount: number }) {
  const { submit } = useAsk();
  const [value, setValue] = useState("");
  const placeholder = `Ask just this video — “What did he say about the treasury budget?”`;

  return (
    <div className="vask">
      <textarea
        className="vin-field"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (value.trim()) submit(value);
          }
        }}
        placeholder={placeholder}
        rows={1}
        aria-label={`Ask about ${videoTitle}`}
      />
      <div className="vbar">
        <div className="l">
          <span className="scope-chip"><span className="dotc" />THIS VIDEO{segmentCount ? ` · ${segmentCount} SEGMENTS` : ""}</span>
        </div>
        <button className="send" aria-label="Ask" onClick={() => value.trim() && submit(value)}>→</button>
      </div>
    </div>
  );
}
