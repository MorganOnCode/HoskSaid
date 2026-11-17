/**
 * `hosk analytics refresh`: recompute /analytics phrase and keyword rankings.
 *
 * Reads transcripts (never modifies them) in one REPEATABLE READ, READ ONLY
 * transaction and writes only analytics_snapshots/analytics_rankings, in one
 * transaction that also deletes the previous snapshot, so the page always sees
 * one complete snapshot. No model or embedding calls.
 *
 * Memory is bounded independently of archive size: pass 1 counts keywords
 * exactly (the vocabulary is small) and phrases approximately in a fixed-size
 * count-min sketch; pass 2 counts exactly only the phrases the sketch says could
 * reach PARAMS.minVideos (the sketch can overcount, never undercount, so no
 * qualifying phrase is lost). Resource use is measured and returned.
 */
import type postgres from "postgres";
import {
  METHOD, PARAMS, STOPWORDS, CONVERSATIONAL_STOPLIST, CAPTION_SPELLINGS,
  computeRankings, extractItems, type ItemStats, type RankingRow, type YearCount,
} from "./method";

type Sql = ReturnType<typeof postgres>;

export class RefreshError extends Error {
  constructor(message: string, readonly code: "tables_missing" | "memory_cap" | "too_many_candidates" | "no_transcripts", readonly help?: string) {
    super(message);
    this.name = "RefreshError";
  }
}

export interface RefreshOptions {
  dryRun?: boolean;
  /** Abort (writing nothing) if the process RSS exceeds this. */
  maxRssMb?: number;
  /** Abort if more exact phrase candidates than this survive pass 1. */
  maxPhraseCandidates?: number;
  /** Rows fetched per cursor round-trip. */
  batchSize?: number;
  progress?: (msg: string) => void;
}

export interface RefreshResult {
  method: string;
  published: boolean;
  snapshot_id: number | null;
  videos: number;
  words: number;
  years: YearCount[];
  keywords_tracked: number;
  phrase_candidates: number;
  rows: number;
  measured: {
    elapsed_ms: number;
    cpu_user_ms: number;
    cpu_system_ms: number;
    peak_rss_mb: number;
    db_read_ms: number;
    db_write_ms: number;
  };
}

const SKETCH_BITS = 22;
const SKETCH_MASK = (1 << SKETCH_BITS) - 1;

function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Two-row count-min sketch of per-video phrase counts (Uint16, saturating). */
class Sketch {
  private a = new Uint16Array(1 << SKETCH_BITS);
  private b = new Uint16Array(1 << SKETCH_BITS);
  add(key: string) {
    const i = fnv1a(key, 0x811c9dc5) & SKETCH_MASK;
    const j = fnv1a(key, 0x9747b28c) & SKETCH_MASK;
    if (this.a[i] < 0xffff) this.a[i]++;
    if (this.b[j] < 0xffff) this.b[j]++;
  }
  atLeast(key: string, n: number): boolean {
    return this.a[fnv1a(key, 0x811c9dc5) & SKETCH_MASK] >= n && this.b[fnv1a(key, 0x9747b28c) & SKETCH_MASK] >= n;
  }
}

interface Acc {
  perYear: Int32Array;
  long: number;
  edge: number;
  labels: Map<string, number>;
}

function accumulate(map: Map<string, Acc>, key: string, label: string, allEdge: boolean, yi: number, Y: number, isLong: boolean) {
  let a = map.get(key);
  if (!a) {
    a = { perYear: new Int32Array(Y), long: 0, edge: 0, labels: new Map() };
    map.set(key, a);
  }
  a.perYear[yi]++;
  if (isLong) {
    a.long++;
    if (allEdge) a.edge++;
  }
  a.labels.set(label, (a.labels.get(label) ?? 0) + 1);
}

function toStats(map: Map<string, Acc>, kind: ItemStats["kind"]): ItemStats[] {
  const out: ItemStats[] = [];
  for (const [key, a] of map) {
    let total = 0;
    for (const n of a.perYear) total += n;
    if (total < PARAMS.minVideos) continue;
    let label = key;
    let best = -1;
    for (const [l, n] of a.labels) if (n > best || (n === best && l < label)) [label, best] = [l, n];
    out.push({ key, label, kind, perYear: a.perYear, long: a.long, edge: a.edge });
  }
  return out;
}

export async function refreshAnalytics(sql: Sql, opts: RefreshOptions = {}): Promise<RefreshResult> {
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const cap = opts.maxRssMb ? opts.maxRssMb * 1024 * 1024 : null;
  const maxCandidates = opts.maxPhraseCandidates ?? 400_000;
  const batch = opts.batchSize ?? 50;
  const log = opts.progress ?? (() => {});
  let peak = process.memoryUsage().rss;
  const sample = () => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
    if (cap && rss > cap) {
      throw new RefreshError(`memory cap exceeded: ${Math.round(rss / 1048576)} MB > ${opts.maxRssMb} MB`, "memory_cap", "Raise --max-rss-mb or run the refresh on a larger host; nothing was written");
    }
  };

  if (!opts.dryRun) {
    const [{ t }] = await sql<{ t: string | null }[]>`SELECT to_regclass('public.analytics_snapshots')::text AS t`;
    if (!t) throw new RefreshError("analytics tables are missing (migration 010 not applied)", "tables_missing", "Apply migrations first: npx tsx src/cli/hosk.ts migrate apply");
  }

  let dbRead = 0;
  let videos = 0;
  let words = 0;
  let years: YearCount[] = [];
  let sourceUpdated: string | null = null;
  const keywords = new Map<string, Acc>();
  const phrases = new Map<string, Acc>();

  await sql.begin("isolation level repeatable read read only", async (tx) => {
    await tx`SELECT set_config('statement_timeout', '600000', true)`;
    const t = performance.now();
    const meta = await tx<{ year: number; videos: number; updated: string | null }[]>`
      SELECT extract(year FROM v.published_at AT TIME ZONE 'UTC')::int AS year, count(*)::int AS videos, max(t.updated_at) AS updated
      FROM videos v JOIN transcripts t ON t.video_id = v.id
      WHERE v.status = 'completed' AND v.published_at IS NOT NULL AND octet_length(t.cleaned_text) > 0
      GROUP BY 1 ORDER BY 1
    `;
    dbRead += performance.now() - t;
    years = meta.map((m) => ({ year: m.year, videos: m.videos }));
    sourceUpdated = meta.reduce<string | null>((mx, m) => (m.updated && (!mx || new Date(m.updated) > new Date(mx)) ? new Date(m.updated).toISOString() : mx), null);
    if (!years.length) return;
    const yIndex = new Map(years.map((y, i) => [y.year, i]));
    const Y = years.length;

    // Each pass streams the same rows (same snapshot) through `visit`.
    const stream = async (visit: (year: number, text: string) => void) => {
      let waitStart = performance.now();
      await tx<{ year: number; text: string }[]>`
        SELECT extract(year FROM v.published_at AT TIME ZONE 'UTC')::int AS year, t.cleaned_text AS text
        FROM videos v JOIN transcripts t ON t.video_id = v.id
        WHERE v.status = 'completed' AND v.published_at IS NOT NULL AND octet_length(t.cleaned_text) > 0
        ORDER BY v.id
      `.cursor(batch, async (rows) => {
        dbRead += performance.now() - waitStart;
        for (const r of rows) visit(r.year, r.text);
        sample();
        waitStart = performance.now();
      });
      dbRead += performance.now() - waitStart;
    };

    const sketch = new Sketch();
    log("pass 1/2: keywords + phrase sketch");
    await stream((year, text) => {
      const it = extractItems(text);
      const yi = yIndex.get(year)!;
      const isLong = it.words >= PARAMS.longVideoWords;
      videos++;
      words += it.words;
      for (const [k, o] of it.keywords) accumulate(keywords, k, o.label, o.allEdge, yi, Y, isLong);
      for (const k of it.phrases.keys()) sketch.add(k);
    });

    log("pass 2/2: exact phrase counts");
    await stream((year, text) => {
      const it = extractItems(text, (k) => sketch.atLeast(k, PARAMS.minVideos));
      const yi = yIndex.get(year)!;
      const isLong = it.words >= PARAMS.longVideoWords;
      for (const [k, o] of it.phrases) accumulate(phrases, k, o.label, o.allEdge, yi, Y, isLong);
      if (phrases.size > maxCandidates) {
        throw new RefreshError(`more than ${maxCandidates} phrase candidates`, "too_many_candidates", "Nothing was written; raise --max-phrase-candidates only after checking memory headroom");
      }
    });
  });

  if (!years.length) {
    throw new RefreshError("no completed, dated videos with transcript text to rank", "no_transcripts");
  }

  const items = [...toStats(keywords, "word"), ...toStats(phrases, "phrase")];
  const keywordsTracked = keywords.size;
  const phraseCandidates = phrases.size;
  keywords.clear();
  phrases.clear();
  sample();
  log(`ranking ${items.length} items over ${years.length} years`);
  const rows: RankingRow[] = computeRankings(years, items);
  sample();

  let snapshotId: number | null = null;
  let dbWrite = 0;
  if (!opts.dryRun) {
    const t = performance.now();
    const params = {
      ...PARAMS,
      stopwords: STOPWORDS.size,
      conversational_stoplist: CONVERSATIONAL_STOPLIST.size,
      caption_spellings: Object.keys(CAPTION_SPELLINGS).length,
      unit: "videos containing the item",
      text: "transcripts.cleaned_text of completed, dated videos",
    };
    snapshotId = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('hosk:analytics-refresh'))`;
      const [s] = await tx<{ id: number }[]>`
        INSERT INTO analytics_snapshots (method, videos_computed, words_computed, years, params, source_updated_at)
        VALUES (${METHOD}, ${videos}, ${words}, ${tx.json(years as unknown as postgres.JSONValue)}, ${tx.json(params as unknown as postgres.JSONValue)}, ${sourceUpdated})
        RETURNING id::int AS id
      `;
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000).map((r) => ({ snapshot_id: s.id, ...r }));
        await tx`INSERT INTO analytics_rankings ${tx(chunk)}`;
      }
      await tx`DELETE FROM analytics_snapshots WHERE id <> ${s.id}`;
      return s.id;
    });
    dbWrite = performance.now() - t;
  }

  const cpu = process.cpuUsage(cpu0);
  return {
    method: METHOD,
    published: !opts.dryRun,
    snapshot_id: snapshotId,
    videos,
    words,
    years,
    keywords_tracked: keywordsTracked,
    phrase_candidates: phraseCandidates,
    rows: rows.length,
    measured: {
      elapsed_ms: Math.round(performance.now() - t0),
      cpu_user_ms: Math.round(cpu.user / 1000),
      cpu_system_ms: Math.round(cpu.system / 1000),
      peak_rss_mb: Math.round(peak / 1048576),
      db_read_ms: Math.round(dbRead),
      db_write_ms: Math.round(dbWrite),
    },
  };
}
