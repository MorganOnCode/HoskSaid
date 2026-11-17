"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AskFilters } from "@/lib/ask-types";

interface Hit {
  video_id: string;
  title: string;
  published_at: string | null;
  matched_in: string | null;
  snippet: string | null;
  url: string;
  semantic_search_available: boolean;
}

/** Path part of an absolute deep link (the API returns canonical absolute URLs). */
function localPath(url: string): string {
  try {
    const u = new URL(url, "https://x.invalid");
    return u.pathname.startsWith("/video/") ? `${u.pathname}${u.search}` : "/library";
  } catch {
    return "/library";
  }
}

/**
 * Keyword matches for a question inside the conversation's scope. No model
 * call and no embedding: shown instead of an answer when semantic search is
 * out of allowance or finds nothing.
 */
export function KeywordResults({ query, filters }: { query: string; filters: AskFilters | undefined }) {
  const [state, setState] = useState<{ status: "loading" | "done" | "error"; items: Hit[]; total: number }>({ status: "loading", items: [], total: 0 });

  useEffect(() => {
    const p = new URLSearchParams({ q: query.slice(0, 200), limit: "8" });
    for (const id of filters?.video_ids ?? []) p.append("video_id", id);
    if (filters?.date_from) p.set("date_from", filters.date_from);
    if (filters?.date_to) p.set("date_to", filters.date_to);
    let live = true;
    fetch(`/api/search/keyword?${p.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("keyword search failed"))))
      .then((d: { items: Hit[]; total: number }) => live && setState({ status: "done", items: d.items ?? [], total: d.total ?? 0 }))
      .catch(() => live && setState({ status: "error", items: [], total: 0 }));
    return () => {
      live = false;
    };
  }, [query, filters]);

  return (
    <div className="kw-results" aria-live="polite">
      <div className="sources-head">
        <span className="lab">Keyword matches</span>
        <span className="ln" />
        <span className="eyebrow" style={{ fontSize: 11 }}>NO MODEL · NO ALLOWANCE USED</span>
      </div>
      {state.status === "loading" && <p className="kw-note">Searching titles, tags and full transcripts…</p>}
      {state.status === "error" && <p className="kw-note">Keyword search is unavailable right now.</p>}
      {state.status === "done" && state.items.length === 0 && <p className="kw-note">No keyword matches in this scope either.</p>}
      {state.items.length > 0 && (
        <ul className="kw-list">
          {state.items.map((h) => (
            <li key={h.video_id}>
              <Link href={localPath(h.url)} className="kw-hit">
                <span className="kw-title">{h.title}</span>
                <span className="kw-meta">
                  {h.published_at ?? "undated"} · matched in {h.matched_in ?? "video"}
                  {h.semantic_search_available ? "" : " · keyword-only video"}
                </span>
                {h.snippet && <span className="kw-snip">…{h.snippet}…</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {state.status === "done" && (
        <p className="kw-note">
          {state.total > state.items.length ? `${state.total - state.items.length} more in this scope. ` : ""}
          <Link href={`/library?q=${encodeURIComponent(query.slice(0, 200))}`}>Search the whole Library →</Link>
        </p>
      )}
    </div>
  );
}
