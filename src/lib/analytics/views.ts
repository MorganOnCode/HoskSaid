/**
 * Server-side composition shared by the /analytics page and /api/analytics*:
 * range resolution, the rankings panel (live subjects + snapshot lists) and
 * honest availability reasons. Server-only.
 */
import { METHOD, PARAMS, captionFlags, distinctiveComparison, eraOf, type YearCount } from "./method";
import { SUBJECTS } from "./subjects";
import {
  getArchiveYears, getRankingLists, getSnapshotStatus, getSubjectYears, snapshotRange,
  type ArchiveYears, type RankingItem, type SnapshotStatus,
} from "./data";

export interface Range {
  from: number;
  to: number;
}

/** Clamp a requested range to the archive's years; null when the archive has no dated videos. */
export function resolveRange(archive: ArchiveYears, from: number | null, to: number | null): Range | null {
  if (!archive.years.length) return null;
  const min = archive.years[0].year;
  const max = archive.years[archive.years.length - 1].year;
  const f = Math.min(max, Math.max(min, from ?? min));
  const t = Math.min(max, Math.max(min, to ?? max));
  return f <= t ? { from: f, to: t } : { from: t, to: f };
}

export const videosIn = (years: YearCount[], r: Range) => years.filter((y) => y.year >= r.from && y.year <= r.to).reduce((s, y) => s + y.videos, 0);

export interface SubjectRow {
  slug: string;
  name: string;
  query: string;
  note: string | null;
  videos: number;
  of_videos: number;
}

export type ListAvailability =
  | { ok: true; items: (RankingItem & { flags: string[] })[] }
  | { ok: false; reason: "not_computed" | "outdated_method" | "thin_range" | "no_years" | "crosses_era" | "no_comparison" | "none_met_support"; detail: string };

export interface RankingsPanel {
  range: Range;
  archive_videos: number;
  subjects: SubjectRow[];
  snapshot: {
    state: SnapshotStatus["state"];
    method: string | null;
    generated_at: string | null;
    videos_computed: number | null;
    current_videos: number | null;
    range_videos: number | null;
  };
  phrases: ListAvailability;
  keywords: ListAvailability;
  distinctive: ListAvailability & { comparison?: string };
  formulas: ListAvailability;
}

const fmtRange = (a: number, b: number) => (a === b ? `${a}` : `${a}–${b}`);

/** "2018, 2020–2021": ascending years grouped into consecutive runs. */
export function yearList(years: number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < years.length; ) {
    let j = i;
    while (j + 1 < years.length && years[j + 1] === years[j] + 1) j++;
    runs.push(fmtRange(years[i], years[j]));
    i = j + 1;
  }
  return runs.join(", ");
}

export async function getRankingsPanel(archive: ArchiveYears, range: Range): Promise<RankingsPanel> {
  const [subjectYears, status] = await Promise.all([getSubjectYears(), getSnapshotStatus()]);
  const N = videosIn(archive.years, range);
  const subjects: SubjectRow[] = SUBJECTS.map((s) => {
    const by = subjectYears.find((x) => x.slug === s.slug)?.by_year ?? {};
    let n = 0;
    for (const [y, c] of Object.entries(by)) if (+y >= range.from && +y <= range.to) n += c;
    return { slug: s.slug, name: s.name, query: s.query, note: s.note ?? null, videos: n, of_videos: N };
  }).sort((a, b) => b.videos - a.videos || a.name.localeCompare(b.name));

  const panel: RankingsPanel = {
    range,
    archive_videos: N,
    subjects,
    snapshot: {
      state: status.state,
      method: "snapshot" in status ? status.snapshot.method : null,
      generated_at: "snapshot" in status ? new Date(status.snapshot.generated_at).toISOString() : null,
      videos_computed: "snapshot" in status ? status.snapshot.videos_computed : null,
      current_videos: status.state === "stale" ? status.current_videos : null,
      range_videos: null,
    },
    phrases: { ok: false, reason: "not_computed", detail: "" },
    keywords: { ok: false, reason: "not_computed", detail: "" },
    distinctive: { ok: false, reason: "not_computed", detail: "" },
    formulas: { ok: false, reason: "not_computed", detail: "" },
  };

  const unavailable = (reason: Exclude<ListAvailability, { ok: true }>["reason"], detail: string): ListAvailability => ({ ok: false, reason, detail });
  if (status.state === "missing") {
    const u = unavailable("not_computed", "Phrase and keyword rankings have not been computed for this archive yet. Subjects and the query tools below work without them.");
    return { ...panel, phrases: u, keywords: u, distinctive: u, formulas: u };
  }
  if (status.state === "outdated_method") {
    const u = unavailable("outdated_method", `The published rankings were computed with an older method (${status.snapshot.method}); they are hidden until they are recomputed with ${METHOD}.`);
    return { ...panel, phrases: u, keywords: u, distinctive: u, formulas: u };
  }

  const snap = status.snapshot;
  const sr = snapshotRange(snap.years, range.from, range.to);
  if (!sr) {
    const u = unavailable("no_years", `The rankings snapshot has no transcripts from ${fmtRange(range.from, range.to)}.`);
    return { ...panel, phrases: u, keywords: u, distinctive: u, formulas: u };
  }
  panel.snapshot.range_videos = sr.videos;
  if (sr.videos < PARAMS.minRangeVideos) {
    const u = unavailable("thin_range", `Only ${sr.videos} transcripts from ${fmtRange(range.from, range.to)} were ranked; at least ${PARAMS.minRangeVideos} are needed for a ranking that isn't noise. Widen the years.`);
    return { ...panel, phrases: u, keywords: u, distinctive: u, formulas: u };
  }

  const lists = await getRankingLists(snap.id, sr.from, sr.to);
  if (!lists) return getRankingsPanel(archive, range);
  const wrap = (items: RankingItem[], none: string): ListAvailability =>
    items.length ? { ok: true, items: items.map((i) => ({ ...i, flags: captionFlags(i.item) })) } : unavailable("none_met_support", none);
  const support = `No item appears in at least ${PARAMS.minVideos} of these ${sr.videos} transcripts.`;
  panel.phrases = wrap(lists.phrases, support);
  panel.keywords = wrap(lists.keywords, support);
  panel.formulas = wrap(lists.formulas, "No intro or sign-off pattern met the rule in these years.");

  const cmp = distinctiveComparison(snap.years, sr.from, sr.to);
  if ("unavailable" in cmp) {
    panel.distinctive =
      cmp.unavailable === "crosses_era"
        ? unavailable("crosses_era", `Distinctive keywords compare the selected years with the other years of the same caption era. These years cross ${PARAMS.eraStartYear}, when YouTube auto-captions changed (older transcripts are mostly unpunctuated and misspell names), so pick years on one side.`)
        : unavailable("no_comparison", `There are not enough other ${eraOf(sr.from) === "recent" ? `${PARAMS.eraStartYear}+` : `pre-${PARAMS.eraStartYear}`} transcripts to compare ${fmtRange(sr.from, sr.to)} with. Pick fewer years.`);
  } else {
    const d = wrap(lists.distinctive, "No keyword is notably more common in these years than in the comparison years.");
    panel.distinctive = { ...d, comparison: `${yearList(cmp.years)} (${cmp.videos} transcripts)` };
  }
  return panel;
}

export { getArchiveYears };
