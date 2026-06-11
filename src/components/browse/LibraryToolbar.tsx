"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

const TYPES = ["all", "AMA", "Whiteboard", "Fireside", "Keynote", "Interview"];
const SORTS = [
  { v: "recent", label: "Most recent" },
  { v: "cited", label: "Most cited" },
  { v: "viewed", label: "Most viewed" },
  { v: "longest", label: "Longest" },
];

/** Filter/sort/search toolbar that drives the /library URL (server re-renders). */
export function LibraryToolbar({ type, sort, q }: { type: string; sort: string; q: string }) {
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
            <p className="sub">Every talk, AMA, whiteboard and fireside — indexed segment by segment.</p>
          </div>
          <div className="lib-search">
            <span className="ic">⌕</span>
            <input
              type="text"
              placeholder="Search titles & topics…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search the library"
            />
          </div>
        </div>
      </div>

      <div className="toolbar">
        <div className="filters">
          {TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={"pill" + (activeType === t ? " solid" : "")}
              onClick={() => update({ type: t })}
            >
              {t === "all" ? "All" : t}
            </button>
          ))}
        </div>
        <div className="right">
          <div className="sortsel">
            <span>SORT</span>
            <select value={sort} onChange={(e) => update({ sort: e.target.value })}>
              {SORTS.map((s) => (
                <option key={s.v} value={s.v}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </>
  );
}
