"use client";

import { useState } from "react";
import { useAsk } from "./AskProvider";
import type { AskFilters } from "@/lib/ask-types";

export interface Suggestion {
  label: string;
  q: string;
}

const DEFAULT_SUGGESTIONS: Suggestion[] = [
  { label: "Cardano governance & Voltaire", q: "Where does Charles stand on Cardano governance and the Voltaire era?" },
  { label: "Midnight & the Glacier Drop", q: "What has Charles said about the Midnight launch and the Glacier Drop?" },
  { label: "Hydra throughput", q: "What are the latest Hydra throughput numbers Charles has cited?" },
  { label: "Regulation in 2026", q: "How does Charles think regulation will evolve in 2026?" },
];

/** The hero Ask box: question input, scope/filter tools, and suggestion pills. */
export function AskBox({
  placeholder = "Ask the archive — “Where does Charles stand on Cardano governance?”",
  suggestions = DEFAULT_SUGGESTIONS,
  videoCount,
}: {
  placeholder?: string;
  suggestions?: Suggestion[];
  videoCount?: number;
}) {
  const { submit } = useAsk();
  const [value, setValue] = useState("");
  const [last90, setLast90] = useState(false);

  function buildFilters(): AskFilters | undefined {
    if (!last90) return undefined;
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return { date_from: d.toISOString().split("T")[0] };
  }

  function go(q: string) {
    submit(q, buildFilters());
  }

  return (
    <>
      <div className="ask" id="askbox">
        <textarea
          className="ask-input-field"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (value.trim()) go(value);
            }
          }}
          placeholder={placeholder}
          rows={2}
          aria-label="Ask the archive"
        />
        <div className="ask-bar">
          <div className="ask-tools">
            <span className="scope-chip">
              <span className="dotc" />
              {videoCount ? `ALL ${videoCount.toLocaleString()} VIDEOS` : "ALL VIDEOS"}
            </span>
            <button
              type="button"
              className={"pill" + (last90 ? " solid" : "")}
              onClick={() => setLast90((v) => !v)}
            >
              Last 90 days
            </button>
          </div>
          <button className="send" aria-label="Ask" onClick={() => value.trim() && go(value)}>→</button>
        </div>
      </div>

      <div className="suggest-row">
        {suggestions.map((s) => (
          <button key={s.q} type="button" className="suggest" onClick={() => go(s.q)}>
            {s.label} <span className="arr">→</span>
          </button>
        ))}
      </div>
    </>
  );
}
