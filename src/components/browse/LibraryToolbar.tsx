"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

const SORTS = [
  { v: "recent", label: "Most recent" },
  { v: "cited", label: "Most cited" },
  { v: "viewed", label: "Most viewed" },
  { v: "longest", label: "Longest" },
];

/**
 * Filter/sort/search toolbar that drives the /library URL (server re-renders).
 * Type pills appear only for types that have videos; until video types are
 * assigned none are shown rather than five empty filters.
 */
export function LibraryToolbar({
  type,
  sort,
  q,
  types,
}: {
  type: string;
  sort: string;
  q: string;
  types: { type: string; count: number }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = useState(q);

  function update(next: Record<string, string | null>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "" || v === "all") sp.delete(k);
      else sp.set(k, v);
    }
    sp.delete("page");
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  }

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== q) update({ q: search });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const activeType = type || "all";
  return (
    <>
      <div className="page-head">
        <div className="row">
          <div>
            <span className="eyebrow"><span className="dot" />THE FULL CATALOGUE · FULLY TRANSCRIBED</span>
            <h1>The <em>library</em></h1>
            <p className="sub">Every talk, AMA, whiteboard and fireside, with keyword search across titles, tags and full transcripts.</p>
          </div>
          <form className="lib-search" role="search" onSubmit={(e) => { e.preventDefault(); update({ q: search }); }}>
            <span className="ic" aria-hidden="true">⌕</span>
            <input
              type="search"
              placeholder="Search titles, tags & transcripts…"
              value={search}
              maxLength={200}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search titles, tags and transcripts"
            />
          </form>
        </div>
      </div>

      <div className="toolbar">
        {types.length > 0 ? (
          <div className="filters" role="group" aria-label="Video type">
            {[{ type: "all", count: 0 }, ...types].map((t) => (
              <button
                key={t.type}
                type="button"
                className={"pill" + (activeType === t.type ? " solid" : "")}
                aria-pressed={activeType === t.type}
                onClick={() => update({ type: t.type })}
              >
                {t.type === "all" ? "All" : `${t.type} · ${t.count}`}
              </button>
            ))}
          </div>
        ) : <div />}
        <div className="right">
          <label className="sortsel">
            <span>SORT</span>
            <select value={sort} onChange={(e) => update({ sort: e.target.value })} aria-label="Sort videos">
              {SORTS.map((s) => (
                <option key={s.v} value={s.v}>{s.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </>
  );
}
