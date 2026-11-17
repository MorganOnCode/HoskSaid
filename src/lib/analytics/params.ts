/**
 * /analytics view state, carried entirely in the URL so a link reproduces the
 * view (no accounts or stored queries). Client-safe: no server imports.
 *
 * Terms use the Library's keyword grammar (Postgres websearch_to_tsquery): plain
 * words, "exact phrases", OR, and -exclusions. Nothing else is executed.
 */
export const MAX_TERMS = 3;
/** Same bound as Library keyword search (MAX_LIBRARY_QUERY). */
export const MAX_TERM_CHARS = 200;
export const SOURCES_PAGE_SIZE = 10;
export const MAX_SOURCE_PAGES = 20;
export const MIN_YEAR = 1990;
export const MAX_YEAR = 2100;

export const RANK_TABS = ["subjects", "phrases", "keywords", "formulas"] as const;
export type RankTab = (typeof RANK_TABS)[number];
export type KeywordMode = "distinctive" | "widespread";
export type Measure = "share" | "count";
export type ResultView = "chart" | "table";

export interface AnalyticsView {
  terms: string[];
  from: number | null;
  to: number | null;
  /** Source drill-down year (inside from..to). */
  year: number | null;
  /** Index into `terms` whose sources are listed. */
  focus: number;
  page: number;
  tab: RankTab;
  kw: KeywordMode;
  measure: Measure;
  view: ResultView;
}

export const DEFAULT_VIEW: AnalyticsView = {
  terms: [], from: null, to: null, year: null, focus: 0, page: 1, tab: "subjects", kw: "distinctive", measure: "share", view: "chart",
};

type Raw = Record<string, string | string[] | undefined>;

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const one = (v: string | string[] | undefined): string | undefined => list(v)[0];

export function normalizeTerm(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

export type TermsResult = { ok: true; terms: string[] } | { ok: false; error: "too_many_terms" | "term_too_long"; detail: string };

/** Strict term validation (API): at most MAX_TERMS distinct terms of at most MAX_TERM_CHARS. */
export function validateTerms(raw: string[]): TermsResult {
  const terms: string[] = [];
  for (const r of raw) {
    const t = normalizeTerm(r);
    if (!t) continue;
    if (t.length > MAX_TERM_CHARS) return { ok: false, error: "term_too_long", detail: `each query must be at most ${MAX_TERM_CHARS} characters` };
    if (!terms.some((x) => x.toLowerCase() === t.toLowerCase())) terms.push(t);
  }
  if (terms.length > MAX_TERMS) return { ok: false, error: "too_many_terms", detail: `compare at most ${MAX_TERMS} queries at once` };
  return { ok: true, terms };
}

export function parseYear(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw === "") return null;
  if (!/^\d{4}$/.test(raw)) return undefined;
  const y = parseInt(raw, 10);
  return y >= MIN_YEAR && y <= MAX_YEAR ? y : undefined;
}

/**
 * Lenient parsing for the page: anything invalid is dropped and reported in
 * `notices`, so a hand-edited or stale link still renders something honest.
 */
export function parseView(sp: Raw): { view: AnalyticsView; notices: string[] } {
  const notices: string[] = [];
  const v: AnalyticsView = { ...DEFAULT_VIEW, terms: [] };

  for (const r of list(sp.q)) {
    const t = normalizeTerm(r);
    if (!t) continue;
    if (t.length > MAX_TERM_CHARS) {
      notices.push(`A query longer than ${MAX_TERM_CHARS} characters was not run.`);
      continue;
    }
    if (v.terms.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
    if (v.terms.length >= MAX_TERMS) {
      notices.push(`Up to ${MAX_TERMS} queries can be compared; “${t.slice(0, 60)}” was not added.`);
      continue;
    }
    v.terms.push(t);
  }

  const from = parseYear(one(sp.from));
  const to = parseYear(one(sp.to));
  if (from === undefined || to === undefined) notices.push("An invalid year was ignored.");
  v.from = from ?? null;
  v.to = to ?? null;
  if (v.from !== null && v.to !== null && v.from > v.to) [v.from, v.to] = [v.to, v.from];

  const year = parseYear(one(sp.year));
  if (year === undefined) notices.push("An invalid year was ignored.");
  else if (year !== null && ((v.from !== null && year < v.from) || (v.to !== null && year > v.to))) {
    notices.push(`${year} is outside the selected years, so all selected years are shown.`);
  } else v.year = year;

  const focus = one(sp.focus);
  if (focus !== undefined && v.terms.length) {
    const i = v.terms.findIndex((t) => t.toLowerCase() === normalizeTerm(focus).toLowerCase());
    v.focus = i >= 0 ? i : 0;
  }

  const page = one(sp.page);
  if (page !== undefined) {
    const p = /^\d{1,3}$/.test(page) ? parseInt(page, 10) : NaN;
    v.page = Number.isFinite(p) ? Math.min(MAX_SOURCE_PAGES, Math.max(1, p)) : 1;
  }
  const tab = one(sp.tab);
  v.tab = (RANK_TABS as readonly string[]).includes(tab ?? "") ? (tab as RankTab) : "subjects";
  v.kw = one(sp.kw) === "widespread" ? "widespread" : "distinctive";
  v.measure = one(sp.m) === "count" ? "count" : "share";
  v.view = one(sp.view) === "table" ? "table" : "chart";
  return { view: v, notices: [...new Set(notices)] };
}

/** Canonical /analytics URL for a view (defaults omitted, stable order). */
export function viewHref(v: AnalyticsView, patch: Partial<AnalyticsView> = {}): string {
  const n = { ...v, ...patch };
  const p = new URLSearchParams();
  for (const t of n.terms) p.append("q", t);
  if (n.from !== null) p.set("from", String(n.from));
  if (n.to !== null) p.set("to", String(n.to));
  if (n.tab !== "subjects") p.set("tab", n.tab);
  if (n.kw !== "distinctive") p.set("kw", n.kw);
  if (n.terms.length) {
    if (n.focus > 0 && n.terms[n.focus]) p.set("focus", n.terms[n.focus]);
    if (n.year !== null) p.set("year", String(n.year));
    if (n.page > 1) p.set("page", String(n.page));
    if (n.measure !== "share") p.set("m", n.measure);
    if (n.view !== "chart") p.set("view", n.view);
  }
  const qs = p.toString();
  return qs ? `/analytics?${qs}` : "/analytics";
}

/** A term as it is typed into the box: phrases stay quoted, words stay bare. */
export function termForItem(item: string): string {
  return /\s/.test(item.trim()) ? `"${item.trim().replace(/"/g, "")}"` : item.trim();
}
