import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import "../browse.css";
import "../analytics.css";
import { checkRate } from "@/lib/ratelimit";
import { decodeEntities } from "@/lib/text";
import { formatCount, formatDate, formatDuration } from "@/lib/format";
import { CAPTION_SPELLINGS, CONVERSATIONAL_STOPLIST, METHOD, PARAMS, STOPWORDS, captionFlags } from "@/lib/analytics/method";
import {
  MAX_SOURCE_PAGES, MAX_TERM_CHARS, MAX_TERMS, SOURCES_PAGE_SIZE, normalizeTerm, parseView, termForItem, viewHref, type AnalyticsView,
} from "@/lib/analytics/params";
import { SUBJECTS, subjectForQuery } from "@/lib/analytics/subjects";
import { AnalyticsTimeoutError, getCoverage, getSources, type SourcesPage, type TermCoverage } from "@/lib/analytics/data";
import { getArchiveYears, getRankingsPanel, resolveRange, videosIn, type ListAvailability, type Range, type RankingsPanel } from "@/lib/analytics/views";
import { CoverageChart, SERIES_COLORS } from "@/components/analytics/CoverageChart";
import { CopyLink } from "@/components/analytics/CopyLink";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Analytics",
  description: "Subjects, repeated phrases and distinctive keywords in Charles Hoskinson's videos by year, plus keyword queries compared year by year with linked sources.",
  alternates: { canonical: "/analytics" },
};

/** Years with fewer videos are drawn hollow and flagged. */
const THIN_YEAR = PARAMS.minRangeVideos;

type SP = Record<string, string | string[] | undefined>;

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const rangeLabel = (r: Range) => (r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`);
const sameTerm = (a: string, b: string) => normalizeTerm(a).toLowerCase() === normalizeTerm(b).toLowerCase();

function termLabel(t: string): string {
  const s = subjectForQuery(t);
  return s ? `${s.name} (subject)` : t;
}

/** A term in running text: phrase queries already carry their quotes. */
const inQuotes = (t: string) => (/^".*"$/.test(t) ? t : `“${t}”`);

/** Render an excerpt whose \u0001…\u0002 spans mark matched words. */
function Excerpt({ text }: { text: string }) {
  const parts = decodeEntities(text).split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <p className="ex">
      …{parts.map((p, i) => (p.startsWith("\u0001") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}…
    </p>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { view, notices } = parseView(sp);

  // The add-a-query form submits ?add=…; fold it into the canonical, shareable URL.
  const addRaw = Array.isArray(sp.add) ? sp.add[0] : sp.add;
  if (addRaw !== undefined) {
    const t = normalizeTerm(addRaw);
    const existing = view.terms.findIndex((x) => sameTerm(x, t));
    if (!t) redirect(viewHref(view));
    if (existing >= 0) redirect(viewHref(view, { focus: existing, year: null, page: 1 }));
    if (t.length > MAX_TERM_CHARS) notices.push(`That query is longer than ${MAX_TERM_CHARS} characters, so it was not run.`);
    else if (view.terms.length >= MAX_TERMS) notices.push(`Up to ${MAX_TERMS} queries can be compared. Remove one to add “${t.slice(0, 60)}”.`);
    else redirect(viewHref(view, { terms: [...view.terms, t], focus: view.terms.length, year: null, page: 1 }));
  }

  let archive;
  try {
    archive = await getArchiveYears();
  } catch (e) {
    console.error("/analytics archive years:", e);
    return <UnavailableState />;
  }
  const range = resolveRange(archive, view.from, view.to);
  if (!range) return <EmptyArchive />;
  const yearsInRange = archive.years.filter((y) => y.year >= range.from && y.year <= range.to);
  const N = videosIn(archive.years, range);

  let panel: RankingsPanel | null = null;
  try {
    panel = await getRankingsPanel(archive, range);
  } catch (e) {
    if (!(e instanceof AnalyticsTimeoutError)) console.error("/analytics rankings:", e);
  }

  let coverage: TermCoverage[] | null = null;
  let sources: SourcesPage | null = null;
  let queryProblem: string | null = null;
  if (view.terms.length) {
    const rate = checkRate({ headers: await headers() });
    if (!rate.ok) {
      queryProblem = `Too many analytics queries from your network in the last minute. Try again in ${rate.retryAfter ?? 60} seconds; the rankings above still work.`;
    } else {
      try {
        coverage = await getCoverage(view.terms, range.from, range.to);
        const focusCov = coverage[view.focus];
        if (focusCov?.status === "ok") {
          sources = await getSources(view.terms[view.focus], range.from, range.to, view.year, view.page);
        }
      } catch (e) {
        if (e instanceof AnalyticsTimeoutError) queryProblem = "That query took too long to count. Try a more specific word or an exact phrase.";
        else {
          console.error("/analytics query:", e);
          queryProblem = "The query could not be counted just now. Please try again.";
        }
      }
    }
  }

  return (
    <div className="wrap an">
      <div className="page-head">
        <span className="eyebrow"><span className="dot" />ANALYTICS · {formatCount(N)} VIDEOS · {rangeLabel(range)}</span>
        <h1>What Charles keeps <em>coming back to</em></h1>
        <p className="sub">
          Subjects, repeated phrases and distinctive keywords across the archive, and your own keyword queries compared
          year by year. Every number counts videos and links to the videos it counts.
        </p>
      </div>

      {notices.map((n) => <div className="an-notice" role="status" key={n}>{n}</div>)}

      <RangeBar view={view} range={range} years={archive.years.map((y) => y.year)} />

      <div className="an-grid">
        <RankingsCard panel={panel} view={view} />
        <section className="an-card" aria-labelledby="an-compare-h">
          <div className="an-card-hd">
            <h2 id="an-compare-h">Compare queries</h2>
            <p>Up to {MAX_TERMS} words or phrases, counted as the share of videos per year whose transcript or title matches.</p>
          </div>
          <div className="an-card-bd">
            <CompareControls view={view} coverage={coverage} />
            {queryProblem && <div className="an-notice warn" role="alert">{queryProblem}</div>}
            {coverage && (
              <Results
                view={view}
                range={range}
                years={yearsInRange.map((y) => y.year)}
                coverage={coverage}
                sources={sources}
                panel={panel}
              />
            )}
            {!view.terms.length && <EmptyCompare view={view} />}
          </div>
        </section>
      </div>

      <MethodDetails panel={panel} archiveUndated={archive.undated} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

function RangeBar({ view, range, years }: { view: AnalyticsView; range: Range; years: number[] }) {
  const min = years[0];
  const max = years[years.length - 1];
  const quick: { label: string; from: number | null; to: number | null }[] = [{ label: "All years", from: null, to: null }];
  if (min < PARAMS.eraStartYear && max >= PARAMS.eraStartYear) {
    quick.push({ label: `Since ${PARAMS.eraStartYear}`, from: PARAMS.eraStartYear, to: null });
    quick.push({ label: `Before ${PARAMS.eraStartYear}`, from: null, to: PARAMS.eraStartYear - 1 });
  }
  quick.push({ label: `${max}`, from: max, to: max });
  const isCurrent = (q: { from: number | null; to: number | null }) => (q.from ?? min) === range.from && (q.to ?? max) === range.to;
  return (
    <div className="an-range">
      <form action="/analytics" method="get" aria-label="Years">
        {view.terms.map((t) => <input key={t} type="hidden" name="q" value={t} />)}
        {view.terms.length > 0 && view.focus > 0 && <input type="hidden" name="focus" value={view.terms[view.focus]} />}
        {view.tab !== "subjects" && <input type="hidden" name="tab" value={view.tab} />}
        {view.kw !== "distinctive" && <input type="hidden" name="kw" value={view.kw} />}
        {view.measure !== "share" && <input type="hidden" name="m" value={view.measure} />}
        {view.view !== "chart" && <input type="hidden" name="view" value={view.view} />}
        <label className="an-field">From
          <select name="from" defaultValue={String(range.from)}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <label className="an-field">To
          <select name="to" defaultValue={String(range.to)}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <button className="btn" type="submit">Apply years</button>
      </form>
      <nav className="an-quick" aria-label="Quick year ranges">
        {quick.map((q) => (
          <Link key={q.label} className="pill" aria-current={isCurrent(q) ? "true" : undefined}
            href={viewHref(view, { from: q.from, to: q.to, year: null, page: 1 })}>{q.label}</Link>
        ))}
        <Link className="an-reset" href="/analytics">Reset view</Link>
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

function addHref(view: AnalyticsView, term: string): { href: string; state: "add" | "in" } | null {
  const i = view.terms.findIndex((t) => sameTerm(t, term));
  if (i >= 0) return { href: viewHref(view, { focus: i, year: null, page: 1 }), state: "in" };
  if (view.terms.length >= MAX_TERMS) return null;
  return { href: viewHref(view, { terms: [...view.terms, term], focus: view.terms.length, year: null, page: 1 }), state: "add" };
}

function Row({ n, label, flags, count, meta, bar, link }: {
  n: number; label: string; flags?: string[]; count: React.ReactNode; meta?: React.ReactNode; bar: number;
  link: { href: string; state: "add" | "in" } | null;
}) {
  const body = (
    <>
      <span className="n">{n}</span>
      <span className="lb">
        {label}
        {flags?.map((f) => <span className="an-flag" key={f} title={`Often an auto-caption misspelling of ${f}`}>caption: {f}?</span>)}
        {link && <span className="add">{link.state === "in" ? "in compare" : "+ compare"}</span>}
      </span>
      <span className="ct">{count}</span>
      <span className="bar" aria-hidden="true"><span style={{ width: `${Math.max(2, Math.round(bar * 100))}%` }} /></span>
      {meta ? <span className="meta">{meta}</span> : null}
    </>
  );
  return <li>{link ? <Link className="an-row" href={link.href}>{body}</Link> : <div className="an-row">{body}</div>}</li>;
}

function NotRanked({ list }: { list: Exclude<ListAvailability, { ok: true }> }) {
  return <p className="an-empty">{list.detail}</p>;
}

function RankingsCard({ panel, view }: { panel: RankingsPanel | null; view: AnalyticsView }) {
  const tabs: { id: AnalyticsView["tab"]; label: string }[] = [
    { id: "subjects", label: "Subjects" },
    { id: "phrases", label: "Repeated phrases" },
    { id: "keywords", label: "Keywords" },
    { id: "formulas", label: "Intro & sign-off" },
  ];
  const full = view.terms.length >= MAX_TERMS;
  return (
    <section className="an-card" aria-labelledby="an-rank-h">
      <div className="an-card-hd">
        <h2 id="an-rank-h">Most frequent</h2>
        <p>Ranked by how many videos contain each item{panel ? `, out of ${formatCount(panel.archive_videos)} in ${rangeLabel(panel.range)}` : ""}. Select one to compare it by year.</p>
      </div>
      <nav className="an-tabs" aria-label="Ranking lists">
        {tabs.map((t) => (
          <Link key={t.id} className="an-tab" aria-current={view.tab === t.id ? "page" : undefined} href={viewHref(view, { tab: t.id })}>{t.label}</Link>
        ))}
      </nav>
      <div className="an-card-bd">
        {full && <p className="an-empty" role="status">Compare already holds {MAX_TERMS} queries; remove one to add another.</p>}
        {!panel ? (
          <p className="an-empty" role="alert">Rankings are temporarily unavailable. The query tools still work.</p>
        ) : view.tab === "subjects" ? (
          <SubjectsList panel={panel} view={view} />
        ) : view.tab === "phrases" ? (
          <ItemList list={panel.phrases} view={view} kind="phrases" />
        ) : view.tab === "keywords" ? (
          <>
            <nav className="an-subtabs" aria-label="Keyword ranking">
              <Link href={viewHref(view, { kw: "distinctive" })} aria-current={view.kw === "distinctive" ? "page" : undefined}>Distinctive for these years</Link>
              <Link href={viewHref(view, { kw: "widespread" })} aria-current={view.kw === "widespread" ? "page" : undefined}>Most widespread</Link>
            </nav>
            {view.kw === "distinctive" ? <ItemList list={panel.distinctive} view={view} kind="distinctive" comparison={panel.distinctive.comparison} /> : <ItemList list={panel.keywords} view={view} kind="keywords" />}
          </>
        ) : (
          <ItemList list={panel.formulas} view={view} kind="formulas" />
        )}
        {panel && <RankingFootnote panel={panel} tab={view.tab} />}
      </div>
    </section>
  );
}

const SUBJECTS_SHOWN = 15;

function SubjectsList({ panel, view }: { panel: RankingsPanel; view: AnalyticsView }) {
  const max = Math.max(1, ...panel.subjects.map((s) => s.videos));
  const row = (s: RankingsPanel["subjects"][number], i: number) => (
    <Row
      key={s.slug}
      n={i + 1}
      label={s.name}
      count={<><b>{s.videos}</b>/{s.of_videos} · {pct(s.videos, s.of_videos)}%</>}
      bar={s.videos / max}
      meta={<><code>{s.query}</code>{s.note ? <> · {s.note}</> : null}</>}
      link={addHref(view, s.query)}
    />
  );
  const rest = panel.subjects.slice(SUBJECTS_SHOWN);
  return (
    <>
      <ol className="an-rows">{panel.subjects.slice(0, SUBJECTS_SHOWN).map(row)}</ol>
      {rest.length > 0 && (
        <details className="an-more">
          <summary>Show all {panel.subjects.length} subjects</summary>
          <ol className="an-rows" start={SUBJECTS_SHOWN + 1}>{rest.map((s, i) => row(s, i + SUBJECTS_SHOWN))}</ol>
        </details>
      )}
    </>
  );
}

function ItemList({ list, view, kind, comparison }: { list: ListAvailability; view: AnalyticsView; kind: "phrases" | "keywords" | "distinctive" | "formulas"; comparison?: string }) {
  if (!list.ok) return <NotRanked list={list} />;
  const max = Math.max(1, ...list.items.map((i) => i.videos));
  return (
    <>
      {kind === "distinctive" && comparison && <p className="an-empty">Compared with {comparison}, the other years of the same caption era.</p>}
      <ol className="an-rows">
        {list.items.map((it) => (
          <Row
            key={`${it.rank}-${it.item}`}
            n={it.rank}
            label={it.item}
            flags={it.flags}
            bar={it.videos / max}
            count={<><b>{it.videos}</b>/{it.of_videos}</>}
            meta={
              kind === "distinctive" && it.cmp_of !== null
                ? <>{pct(it.videos, it.of_videos)}% of these videos vs {pct(it.cmp_videos ?? 0, it.cmp_of)}% ({it.cmp_videos}/{it.cmp_of}) of the comparison years · ×{it.lift}</>
                : kind === "formulas" && it.edge_share !== null
                  ? <>Only in the first or last {PARAMS.edgeWords} words in {Math.round(it.edge_share * 100)}% of the long videos that contain it</>
                  : undefined
            }
            link={addHref(view, termForItem(it.item))}
          />
        ))}
      </ol>
    </>
  );
}

function RankingFootnote({ panel, tab }: { panel: RankingsPanel; tab: AnalyticsView["tab"] }) {
  if (tab === "subjects") {
    return <p className="an-method">Live count: videos whose transcript or title matches the subject&apos;s public query (shown under each subject). Tags are not counted. No model assigns subjects.</p>;
  }
  const s = panel.snapshot;
  if (s.state === "missing" || !s.generated_at) return null;
  return (
    <p className="an-method">
      Method {s.method} · computed {formatDate(s.generated_at)} over {formatCount(s.videos_computed ?? 0)} transcripts
      {s.range_videos !== null ? ` (${formatCount(s.range_videos)} in these years)` : ""} · minimum {PARAMS.minVideos} videos per item ·
      stopwords, {CONVERSATIONAL_STOPLIST.size} conversational fillers and intro/sign-off patterns removed
      {s.state === "stale" ? (
        <><br /><b>Out of date:</b> the archive now has {formatCount(s.current_videos ?? 0)} rankable transcripts, or transcripts changed since this was computed. Counts below may lag; the query tools are live.</>
      ) : null}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

function CompareControls({ view, coverage }: { view: AnalyticsView; coverage: TermCoverage[] | null }) {
  const full = view.terms.length >= MAX_TERMS;
  return (
    <>
      {full ? (
        <p className="an-empty">Comparing the maximum of {MAX_TERMS} queries. Remove one to add another.</p>
      ) : (
        <form className="an-add" action="/analytics" method="get" role="search">
          {view.terms.map((t) => <input key={t} type="hidden" name="q" value={t} />)}
          {view.from !== null && <input type="hidden" name="from" value={view.from} />}
          {view.to !== null && <input type="hidden" name="to" value={view.to} />}
          {view.tab !== "subjects" && <input type="hidden" name="tab" value={view.tab} />}
          {view.kw !== "distinctive" && <input type="hidden" name="kw" value={view.kw} />}
          {view.measure !== "share" && <input type="hidden" name="m" value={view.measure} />}
          {view.view !== "chart" && <input type="hidden" name="view" value={view.view} />}
          <label className="an-field">Add a word or phrase
            <input name="add" type="search" maxLength={MAX_TERM_CHARS} required placeholder='midnight, "partner chains", hydra OR mithril' autoComplete="off" />
          </label>
          <button className="btn accent" type="submit">Add</button>
        </form>
      )}
      <p className="an-hint">
        Same search as the Library: <code>&quot;exact phrase&quot;</code>, <code>a OR b</code>, <code>a -b</code>. Word endings are matched
        (“chains” also finds “chain”). It counts mentions, not meaning: check the sources.
      </p>
      {view.terms.length > 0 && (
        <>
          <div className="an-terms" aria-label="Queries being compared">
            {view.terms.map((t, i) => {
              const focus = i === view.focus;
              const rest = view.terms.filter((_, k) => k !== i);
              const nextFocus = view.focus > i ? view.focus - 1 : view.focus === i ? 0 : view.focus;
              const bad = coverage?.[i] && coverage[i].status !== "ok";
              return (
                <span className={"an-term" + (focus ? " focus" : "")} key={t}>
                  <span className="sw" style={{ background: bad ? "var(--ink-faint)" : SERIES_COLORS[i] }} aria-hidden="true" />
                  <span className="tq">{termLabel(t)}</span>
                  {!focus && <Link href={viewHref(view, { focus: i, year: null, page: 1 })} aria-label={`Show sources for ${t}`}>sources</Link>}
                  <Link href={viewHref(view, { terms: rest, focus: Math.min(nextFocus, Math.max(0, rest.length - 1)), year: null, page: 1 })} aria-label={`Remove ${t}`}>✕</Link>
                </span>
              );
            })}
          </div>
          <div className="an-actions">
            <Link href={viewHref(view, { terms: [], focus: 0, year: null, page: 1 })}>Clear all queries</Link>
            <Link href={`/library?q=${encodeURIComponent(view.terms[view.focus])}`}>Search the Library for {inQuotes(view.terms[view.focus].slice(0, 48))}</Link>
            <CopyLink />
          </div>
        </>
      )}
    </>
  );
}

function EmptyCompare({ view }: { view: AnalyticsView }) {
  const examples = ["midnight", '"partner chains"', "hydra OR mithril"];
  return (
    <div className="an-empty" style={{ marginTop: 14 }}>
      Nothing to compare yet. Pick an item from the rankings, add your own query, or start from an example:{" "}
      {examples.map((e, i) => (
        <span key={e}>{i ? ", " : ""}<Link href={viewHref(view, { terms: [e], focus: 0, year: null, page: 1 })}>{e}</Link></span>
      ))}.
    </div>
  );
}

function Results({ view, range, years, coverage, sources, panel }: {
  view: AnalyticsView; range: Range; years: number[]; coverage: TermCoverage[]; sources: SourcesPage | null; panel: RankingsPanel | null;
}) {
  const ok = coverage.map((c, i) => ({ c, i })).filter((x) => x.c.status === "ok");
  const hrefFor = (i: number, year: number) => viewHref(view, { focus: i, year, page: 1 });
  const yearN = new Map(coverage.find((c) => c.status === "ok")?.by_year.map((b) => [b.year, b.videos]) ?? []);
  return (
    <>
      <div className="an-sums">
        {coverage.map((c, i) => <TermSummary key={c.q} c={c} i={i} range={range} />)}
      </div>
      {ok.length > 0 && (
        <>
          <div className="an-viewbar">
            <div className="an-seg" role="group" aria-label="Show as">
              <Link href={viewHref(view, { view: "chart" })} aria-current={view.view === "chart" ? "page" : undefined}>Chart</Link>
              <Link href={viewHref(view, { view: "table" })} aria-current={view.view === "table" ? "page" : undefined}>Table</Link>
            </div>
            {view.view === "chart" && (
              <div className="an-seg" role="group" aria-label="Measure">
                <Link href={viewHref(view, { measure: "share" })} aria-current={view.measure === "share" ? "page" : undefined}>% of videos</Link>
                <Link href={viewHref(view, { measure: "count" })} aria-current={view.measure === "count" ? "page" : undefined}>Videos</Link>
              </div>
            )}
          </div>
          {view.view === "chart" ? (
            <>
              <CoverageChart
                years={years}
                series={ok.map(({ c, i }) => ({ index: i, label: c.q, by_year: c.by_year }))}
                measure={view.measure}
                focus={view.focus}
                selectedYear={view.year}
                thinBelow={THIN_YEAR}
                hrefFor={hrefFor}
              />
              <div className="an-legend">
                {ok.map(({ c, i }) => (
                  <span key={c.q}><span style={{ color: SERIES_COLORS[i] }}>{["●", "■", "◆"][i]}</span> {termLabel(c.q)}</span>
                ))}
                <span>Hollow = fewer than {THIN_YEAR} videos that year</span>
                <span>Select a point for that year&apos;s sources</span>
              </div>
            </>
          ) : (
            <CoverageTable view={view} years={years} coverage={coverage} yearN={yearN} hrefFor={hrefFor} />
          )}
        </>
      )}
      <Sources view={view} range={range} coverage={coverage} sources={sources} panel={panel} yearN={yearN} />
    </>
  );
}

function TermSummary({ c, i, range }: { c: TermCoverage; i: number; range: Range }) {
  if (c.status !== "ok") {
    return (
      <div className="an-sum bad">
        <div className="hd">{termLabel(c.q)}</div>
        <div className="big">
          {c.status === "empty"
            ? "Only very common words (like “the”), which the search ignores. Add a more specific word."
            : "Only exclusions. Add at least one word to look for, e.g. hydra -heads."}
        </div>
      </div>
    );
  }
  const peak = c.by_year.filter((y) => y.videos >= THIN_YEAR && y.matched > 0).sort((a, b) => b.matched / b.videos - a.matched / a.videos || b.year - a.year)[0];
  return (
    <div className="an-sum">
      <div className="hd"><span style={{ color: SERIES_COLORS[i] }} aria-hidden="true">{["●", "■", "◆"][i]}</span>{termLabel(c.q)}</div>
      <div className="big">{formatCount(c.matched)}<small>of {formatCount(c.of)} videos · {pct(c.matched, c.of)}%</small></div>
      {c.matched === 0 ? (
        <div className="ln">No video from {rangeLabel(range)} matches. Check the spelling or widen the years.</div>
      ) : (
        <>
          {peak && <div className="ln">Peak: {peak.year}, {peak.matched}/{peak.videos} ({pct(peak.matched, peak.videos)}%)</div>}
          {c.first && <div className="ln">First: <Link href={`/video/${c.first.youtube_id}`}>{formatDate(c.first.published_at)}</Link></div>}
          {c.latest && <div className="ln">Latest: <Link href={`/video/${c.latest.youtube_id}`}>{formatDate(c.latest.published_at)}</Link></div>}
          {c.title_only > 0 && <div className="ln">{c.title_only} matched in the title only</div>}
        </>
      )}
    </div>
  );
}

function CoverageTable({ view, years, coverage, yearN, hrefFor }: {
  view: AnalyticsView; years: number[]; coverage: TermCoverage[]; yearN: Map<number, number>; hrefFor: (i: number, y: number) => string;
}) {
  const ok = coverage.map((c, i) => ({ c, i })).filter((x) => x.c.status === "ok");
  return (
    <div className="an-tablewrap">
      <table className="an-table">
        <caption className="sr-only">Videos matching each query per year (matching videos / all videos that year). Select a cell for its sources.</caption>
        <thead>
          <tr>
            <th scope="col">Year</th>
            <th scope="col">Videos</th>
            {ok.map(({ c }) => <th scope="col" key={c.q}>{termLabel(c.q)}</th>)}
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            const n = yearN.get(y) ?? 0;
            return (
              <tr key={y} className={n < THIN_YEAR ? "thin" : undefined}>
                <th scope="row">{y}{n < THIN_YEAR ? " · few" : ""}</th>
                <td>{n}</td>
                {ok.map(({ c, i }) => {
                  const b = c.by_year.find((x) => x.year === y);
                  const cur = view.focus === i && view.year === y;
                  return (
                    <td key={c.q} className={cur ? "cur" : undefined}>
                      {b ? <Link href={hrefFor(i, y)} aria-current={cur ? "true" : undefined}>{b.matched}/{b.videos} · {pct(b.matched, b.videos)}%</Link> : "—"}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          <tr>
            <th scope="row">All</th>
            <td>{years.reduce((s, y) => s + (yearN.get(y) ?? 0), 0)}</td>
            {ok.map(({ c, i }) => (
              <td key={c.q}><Link href={viewHref(view, { focus: i, year: null, page: 1 })}>{c.matched}/{c.of} · {pct(c.matched, c.of)}%</Link></td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Sources({ view, range, coverage, sources, panel, yearN }: {
  view: AnalyticsView; range: Range; coverage: TermCoverage[]; sources: SourcesPage | null; panel: RankingsPanel | null; yearN: Map<number, number>;
}) {
  const term = view.terms[view.focus];
  const cov = coverage[view.focus];
  if (!term || !cov || cov.status !== "ok" || !sources) return null;
  const scope = view.year !== null ? `${view.year}` : rangeLabel(range);
  const lo = view.year ?? range.from;
  const caveats: string[] = [];
  if (lo < PARAMS.eraStartYear) caveats.push(`Before ${PARAMS.eraStartYear} most transcripts are unpunctuated auto-captions that can misspell names (Cardano often appears as “cardinal” or “cardno”), so early years can undercount.`);
  const subject = subjectForQuery(term);
  if (subject?.note) caveats.push(`${subject.name}: ${subject.note}`);
  const flags = captionFlags(term.replace(/["()-]/g, " "));
  if (flags.length) caveats.push(`This query contains a known caption misspelling (${flags.join(", ")}); matches may be that word rather than the literal one.`);
  const formulas = panel?.formulas.ok ? panel.formulas.items : [];
  if (formulas.some((f) => sameTerm(termForItem(f.item), term))) caveats.push("This is mostly an intro or sign-off phrase, so its count says little about what was discussed.");
  if (view.year !== null && (yearN.get(view.year) ?? 0) < THIN_YEAR) caveats.push(`Only ${yearN.get(view.year) ?? 0} videos are from ${view.year}; one video moves the percentage a lot.`);
  caveats.push("Counts are keyword matches, not meaning: a word can be used in another sense.");
  const pageHref = (p: number) => viewHref(view, { page: p });
  const reachable = Math.min(sources.pages, MAX_SOURCE_PAGES);

  return (
    <section className="an-sources" aria-labelledby="an-src-h">
      <h3 id="an-src-h">Sources for {inQuotes(termLabel(term))} · {scope}</h3>
      <p className="sub" role="status">
        {sources.total === 0
          ? `No video from ${scope} matches.`
          : `${formatCount(sources.total)} matching video${sources.total === 1 ? "" : "s"}, newest first${reachable > 1 ? ` · page ${sources.page} of ${reachable}` : ""}.`}
        {sources.pages > MAX_SOURCE_PAGES && ` Only the newest ${MAX_SOURCE_PAGES * SOURCES_PAGE_SIZE} are listed; select a year in the chart or table for older ones.`}
        {view.year !== null && <> <Link href={viewHref(view, { year: null, page: 1 })}>Show all of {rangeLabel(range)}</Link></>}
      </p>
      {sources.items.length === 0 && sources.total > 0 && (
        <p className="an-empty">This page is past the last result. <Link href={pageHref(1)}>Back to the first page</Link></p>
      )}
      <ol className="an-src">
        {sources.items.map((s) => (
          <li key={s.youtube_id}>
            <div className="tt"><Link href={`/video/${s.youtube_id}`}>{decodeEntities(s.title)}</Link></div>
            <div className="mt">
              {s.published_at && <span>{formatDate(s.published_at)}</span>}
              {s.duration_seconds ? <><span>·</span><span>{formatDuration(s.duration_seconds)}</span></> : null}
              <span>·</span>
              <span>{s.matched_in === "title" ? "matched in the title only" : s.matched_in === "both" ? "matched in the title and transcript" : "matched in the transcript"}</span>
            </div>
            {s.excerpt && <Excerpt text={s.excerpt} />}
            <div className="go">
              {s.link_kind === "timed" && s.timed_start !== null ? (
                <Link href={s.href}>▶ Play from {formatDuration(s.timed_start)} (first timed match)</Link>
              ) : s.link_kind === "transcript" ? (
                <Link href={s.href}>Open the transcript at the match</Link>
              ) : (
                <>
                  <Link href={s.href}>Open the video</Link>
                  {s.matched_in !== "title" && <span>(its timed segments don&apos;t contain this match)</span>}
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      {reachable > 1 && (
        <nav className="an-pager" aria-label="Source pages">
          {sources.page > 1 ? <Link href={pageHref(sources.page - 1)}>← Newer</Link> : null}
          <span>Page {sources.page} of {reachable} ({SOURCES_PAGE_SIZE} per page)</span>
          {sources.page < reachable ? <Link href={pageHref(sources.page + 1)}>Older →</Link> : null}
        </nav>
      )}
      <div className="an-caveats">
        {caveats.map((c) => <p className="an-empty" key={c}>{c}</p>)}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Method
// ---------------------------------------------------------------------------

function MethodDetails({ panel, archiveUndated }: { panel: RankingsPanel | null; archiveUndated: number }) {
  const s = panel?.snapshot;
  return (
    <details className="an-details">
      <summary>How these numbers are made</summary>
      <h4>What is counted</h4>
      <p>
        Every number is a count of <b>videos</b>, never raw mentions, so one long stream that repeats a word 80 times counts once.
        A video matches a query when its transcript or its title matches. YouTube tags are not counted: they are uploader keywords, not speech.
        The denominator is every completed, dated video in the selected years{archiveUndated ? ` (${archiveUndated} undated videos are left out)` : ""}.
        Query counts are live, refreshed at most every 10 minutes.
      </p>
      <h4>Subjects</h4>
      <p>
        The {SUBJECTS.length} curated subjects are each defined by a public keyword query, shown under its name. Paste one into
        the compare box to reproduce its count. No AI model labels videos.
      </p>
      <h4>Repeated phrases and keywords ({METHOD})</h4>
      <ul>
        <li>Words are lower-cased; simple plurals and possessives are grouped (“contracts” with “contract”); caption annotations such as [Music] are ignored.</li>
        <li>{STOPWORDS.size} English stopwords and {CONVERSATIONAL_STOPLIST.size} conversational fillers (“basically”, “gonna”, “people”…) are never ranked.</li>
        <li>Phrases are {2}–{PARAMS.maxPhraseWords} words that start and end with a content word and don&apos;t cross a sentence break. A shorter phrase is folded into a longer one that covers at least {Math.round(PARAMS.collapseShare * 100)}% of its videos.</li>
        <li>An item must appear in at least {PARAMS.minVideos} videos, and a range needs at least {PARAMS.minRangeVideos} transcripts to be ranked.</li>
        <li><b>Distinctive keywords</b> compare the share of videos containing a word in the selected years with its share in the other years of the same caption era (smoothed ratio, shown as ×; at least ×{PARAMS.minLift}).</li>
        <li><b>Intro and sign-off</b>: an item is listed there instead of in the rankings when, in at least {Math.round(PARAMS.edgeShare * 100)}% of the {PARAMS.longVideoWords}+-word videos that contain it, it only occurs in the first or last {PARAMS.edgeWords} words.</li>
        <li>
          {s?.generated_at
            ? <>Rankings were computed {formatDate(s.generated_at)} over {formatCount(s.videos_computed ?? 0)} transcripts by an offline job that only reads transcripts.</>
            : <>Rankings are computed by an offline job that only reads transcripts; it has not been run for this archive yet.</>}
        </li>
      </ul>
      <h4>Transcript quality</h4>
      <p>
        Before {PARAMS.eraStartYear} most transcripts are YouTube auto-captions without punctuation, and names are often misspelled.
        Known misspellings are flagged, not hidden: {Object.entries(CAPTION_SPELLINGS).map(([k, v]) => `“${k}” (${v})`).join(", ")}.
        Keyword comparisons stay inside one era so these spellings don&apos;t pose as trends.
      </p>
      <h4>Privacy and cost</h4>
      <p>
        This page reads only the public video catalogue and transcripts. It never uses visitors&apos; questions or answers, and it makes
        no AI model calls. Links are the view: copying the address shares exactly what you see, and nothing is saved.
      </p>
    </details>
  );
}

function UnavailableState() {
  return (
    <div className="wrap" style={{ paddingTop: 60 }}>
      <div className="state-card error" role="alert">
        <span className="glyph">!</span>
        <h3>Analytics is unavailable right now</h3>
        <p>The archive could not be read. The <Link href="/library" style={{ textDecoration: "underline" }}>Library</Link> may still work; please try again shortly.</p>
      </div>
    </div>
  );
}

function EmptyArchive() {
  return (
    <div className="wrap an">
      <div className="page-head">
        <span className="eyebrow"><span className="dot" />ANALYTICS</span>
        <h1>What Charles keeps <em>coming back to</em></h1>
      </div>
      <div className="empty-card"><h2>No dated videos yet</h2><p>Analytics appears once the archive has completed videos with publication dates.</p></div>
    </div>
  );
}
