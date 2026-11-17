/**
 * The published, deterministic ranking method behind /analytics (no model calls).
 * Pure and client-safe: tokenizing, the intro/sign-off rule, phrase collapsing and
 * per-year-range rankings. `hosk analytics refresh` feeds it transcripts; tests
 * feed it fixtures. Changing any rule here should bump METHOD so the page stops
 * presenting rankings computed under the old rules.
 *
 * Unit: every count is a number of VIDEOS containing an item (document
 * frequency), never raw mentions, so one long stream that repeats a word 80
 * times counts once.
 */

export const METHOD = "rank-v1";

export const PARAMS = {
  /** Words at the start/end of a transcript that count as its intro/sign-off. */
  edgeWords: 150,
  /** Only transcripts at least this long have a "middle" to judge position by. */
  longVideoWords: 600,
  /** An item is an intro/sign-off formula when, in at least this share of the long
   *  videos containing it, every occurrence is within the edge words... */
  edgeShare: 0.5,
  /** ...and at least this many long videos contain it. */
  formulaMinLongVideos: 5,
  /** Minimum videos containing an item before it is ranked. */
  minVideos: 5,
  /** Ranges (and distinctive-keyword comparisons) with fewer videos are not ranked. */
  minRangeVideos: 20,
  /** A shorter phrase is folded into a longer kept phrase covering this share of its videos. */
  collapseShare: 0.8,
  /** Auto-caption quality changes here: pre-2022 transcripts are mostly unpunctuated
   *  captions with misspelled names, so keyword comparisons stay inside one era. */
  eraStartYear: 2022,
  /** A distinctive keyword must be at least this many times as common (smoothed) as in the comparison years. */
  minLift: 1.5,
  /** Phrases are 2..maxPhraseWords words that start and end with a content word. */
  maxPhraseWords: 4,
  topK: 30,
  formulasTopK: 20,
} as const;

/** Common English function words (never content words). */
export const STOPWORDS: ReadonlySet<string> = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being
below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't
down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's
her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it
it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought
our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such
than that that's the their theirs them themselves then there there's these they they'd they'll
they're they've this those through to too under until up very was wasn't we we'd we'll we're we've
were weren't what what's when when's where where's which while who who's whom why why's with won't
would wouldn't you you'd you'll you're you've your yours yourself yourselves`.split(/\s+/)
);

/** Fillers and generic spoken words that dominate any unfiltered speech ranking. */
export const CONVERSATIONAL_STOPLIST: ReadonlySet<string> = new Set(
  `able absolutely across actually ah along already also although always another answer anyone
anything anywhere around ask asked asking back bad basically behind believe best better beyond big
bit call called came can certainly come comes coming day days definitely different doing done else
enough even ever every everybody everyone everything everywhere feel felt find fine first five
folks found four gave get gets getting give given go goes going gone gonna good got gotta great guy
guys hey hmm huh idea just keep kept kind kinda know last let like literally little long look
looked looking looks lot lots made make makes making many maybe mean means meant mind month months
much need needed needs never new next nobody nothing now obviously oh ok okay old one part parts
people place please point points pretty probably put question questions quite real really right
said same say saying says second see seeing seem seemed seems seen short small somebody someone
something somewhere sort sorta start started still sure take takes taking talk talked talking tell
telling thank thanks thing things think thinking though thought three time times today told took
toward towards tried try trying two uh uhm um upon use used using wanna want wanted wants way ways
week weeks well went whatever whether whole will within without work worked working works yeah year
years yep yes yet`.split(/\s+/)
);

/**
 * Known auto-caption misspellings (checked against sample contexts). Items
 * containing one are flagged, not hidden: the word may also be used literally.
 */
export const CAPTION_SPELLINGS: Readonly<Record<string, string>> = {
  cardinal: "Cardano",
  cardno: "Cardano",
  cardona: "Cardano",
  aetherium: "Ethereum",
  shelly: "Shelley",
  oroboros: "Ouroboros",
  hoskins: "Hoskinson",
};

export type CaptionEra = "early" | "recent";
export const eraOf = (year: number): CaptionEra => (year < PARAMS.eraStartYear ? "early" : "recent");

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const TOKEN_RE = /[a-z][a-z']*|[.!?;]/g;

export interface Tokens {
  /** Lower-cased words in order (punctuation removed). */
  words: string[];
  /** breakAfter[i] = 1 when a sentence break follows words[i]; phrases never span one. */
  breakAfter: Uint8Array;
}

/** Caption annotations such as [Music], [Applause] or [expletive]: noise, never words. */
const ANNOTATION_RE = /\[[^\]\n]{0,40}\]/g;

export function tokenize(text: string): Tokens {
  const lower = text.toLowerCase().replace(/[‘’]/g, "'").replace(ANNOTATION_RE, " . ");
  const words: string[] = [];
  const breaks: number[] = [];
  for (const m of lower.matchAll(TOKEN_RE)) {
    const t = m[0];
    if (t.length === 1 && ".!?;".includes(t)) {
      if (words.length) breaks.push(words.length - 1);
      continue;
    }
    const w = t.replace(/'+$/, "");
    if (w) words.push(w);
  }
  const breakAfter = new Uint8Array(words.length);
  for (const b of breaks) breakAfter[b] = 1;
  return { words, breakAfter };
}

/**
 * Grouping key for a word: drops a possessive and a simple plural "s" so
 * "contract"/"contracts" and "Cardano's"/"Cardano" count as one item (the
 * Postgres English stemmer used by the query box merges these forms too).
 */
export function foldWord(w: string): string {
  const base = w.replace(/'s$/, "");
  if (base.length >= 5 && base.endsWith("s") && !/(ss|us|is|ics)$/.test(base)) return base.slice(0, -1);
  return base;
}

/** A content word: not a stopword or conversational filler (in either form) and >= 3 letters. */
export function isContentWord(w: string): boolean {
  if (w.length < 3 || STOPWORDS.has(w) || CONVERSATIONAL_STOPLIST.has(w)) return false;
  const f = foldWord(w);
  return f.length >= 3 && !STOPWORDS.has(f) && !CONVERSATIONAL_STOPLIST.has(f);
}

export interface Occurrence {
  /** Surface form as first seen in this video. */
  label: string;
  /** Every occurrence lies within the first or last PARAMS.edgeWords words. */
  allEdge: boolean;
}

export interface VideoItems {
  words: number;
  keywords: Map<string, Occurrence>;
  phrases: Map<string, Occurrence>;
}

/**
 * Items in one transcript, keyed by folded form. `keepPhrase` limits which
 * phrase keys are recorded (the refresh's second pass keeps only candidates).
 */
export function extractItems(text: string, keepPhrase?: (key: string) => boolean): VideoItems {
  const { words, breakAfter } = tokenize(text);
  const n = words.length;
  const edge = PARAMS.edgeWords;
  const content = new Uint8Array(n);
  const folded: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    content[i] = isContentWord(words[i]) ? 1 : 0;
    folded[i] = foldWord(words[i]);
  }
  const atEdge = (p: number) => p < edge || p >= n - edge;
  const keywords = new Map<string, Occurrence>();
  const phrases = new Map<string, Occurrence>();
  const note = (map: Map<string, Occurrence>, key: string, label: string, p: number) => {
    const hit = map.get(key);
    if (!hit) map.set(key, { label, allEdge: atEdge(p) });
    else if (hit.allEdge && !atEdge(p)) hit.allEdge = false;
  };
  for (let i = 0; i < n; i++) {
    if (!content[i]) continue;
    note(keywords, folded[i], words[i], i);
    // Phrases start at a content word, end at a content word, never cross a break.
    let key = folded[i];
    let label = words[i];
    for (let len = 2; len <= PARAMS.maxPhraseWords; len++) {
      const j = i + len - 1;
      if (j >= n || breakAfter[j - 1]) break;
      key += " " + folded[j];
      label += " " + words[j];
      if (content[j] && (!keepPhrase || keepPhrase(key))) note(phrases, key, label, i);
    }
  }
  return { words: n, keywords, phrases };
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

export interface YearCount {
  year: number;
  videos: number;
}

export interface ItemStats {
  key: string;
  label: string;
  kind: "word" | "phrase";
  /** Videos containing the item, per entry of the `years` array (same order). */
  perYear: ArrayLike<number>;
  /** Long videos (>= PARAMS.longVideoWords) containing it. */
  long: number;
  /** ...of which every occurrence is within the edge words. */
  edge: number;
}

export type RankingList = "phrases" | "keywords" | "distinctive" | "formulas";

export interface RankingRow {
  year_from: number;
  year_to: number;
  list: RankingList;
  rank: number;
  item: string;
  videos: number;
  of_videos: number;
  cmp_videos: number | null;
  cmp_of: number | null;
  lift: number | null;
  edge_share: number | null;
}

export function isFormula(s: Pick<ItemStats, "long" | "edge">): boolean {
  return s.long >= PARAMS.formulaMinLongVideos && s.edge / s.long >= PARAMS.edgeShare;
}

/**
 * Comparison years for distinctive keywords: the other years of the same caption
 * era. Null when the range crosses eras or the comparison is too thin.
 */
export function distinctiveComparison(
  years: YearCount[],
  from: number,
  to: number
): { years: number[]; videos: number } | { unavailable: "crosses_era" | "no_comparison" } {
  if (eraOf(from) !== eraOf(to)) return { unavailable: "crosses_era" };
  const era = eraOf(from);
  const cmp = years.filter((y) => eraOf(y.year) === era && (y.year < from || y.year > to));
  const videos = cmp.reduce((s, y) => s + y.videos, 0);
  if (videos < PARAMS.minRangeVideos) return { unavailable: "no_comparison" };
  return { years: cmp.map((y) => y.year), videos };
}

/** Contiguous sub-phrases of a folded key (lengths minLen..len-1). */
function subPhrases(key: string, minLen: number): string[] {
  const w = key.split(" ");
  const out: string[] = [];
  for (let len = minLen; len < w.length; len++) {
    for (let i = 0; i + len <= w.length; i++) out.push(w.slice(i, i + len).join(" "));
  }
  return out;
}

interface Scored { s: ItemStats; df: number; words: number }

/**
 * Drop an item when a longer kept item contains it and covers at least
 * PARAMS.collapseShare of its videos ("stake pool operators" absorbs "pool
 * operators" when they nearly always occur together).
 */
function collapse(items: Scored[], minSubLen: number): Scored[] {
  const sorted = [...items].sort((a, b) => b.words - a.words || b.df - a.df || (a.s.key < b.s.key ? -1 : 1));
  const cover = new Map<string, number>();
  const kept: Scored[] = [];
  for (const it of sorted) {
    const c = cover.get(it.s.key);
    if (c !== undefined && c >= PARAMS.collapseShare * it.df) continue;
    kept.push(it);
    for (const sub of subPhrases(it.s.key, minSubLen)) cover.set(sub, Math.max(cover.get(sub) ?? 0, it.df));
  }
  return kept;
}

const byDf = (a: Scored, b: Scored) => b.df - a.df || (a.s.label < b.s.label ? -1 : a.s.label > b.s.label ? 1 : 0);

/**
 * Rankings for every contiguous range of `years` (ascending, with per-year
 * video denominators). Ranges with fewer than PARAMS.minRangeVideos videos get
 * no rows; the page says so instead of ranking noise.
 */
export function computeRankings(years: YearCount[], items: ItemStats[]): RankingRow[] {
  const Y = years.length;
  const prefix = (arr: ArrayLike<number>) => {
    const p = new Int32Array(Y + 1);
    for (let i = 0; i < Y; i++) p[i + 1] = p[i] + (arr[i] ?? 0);
    return p;
  };
  const yp = prefix(years.map((y) => y.videos));
  const prepared = items.map((s) => ({
    s,
    p: prefix(s.perYear),
    formula: isFormula(s),
    words: s.kind === "word" ? 1 : s.key.split(" ").length,
  }));
  const rows: RankingRow[] = [];
  const emit = (from: number, to: number, list: RankingList, scored: Scored[], N: number, extra?: (x: Scored) => Partial<RankingRow>) => {
    scored.forEach((x, i) =>
      rows.push({
        year_from: from, year_to: to, list, rank: i + 1, item: x.s.label, videos: x.df, of_videos: N,
        cmp_videos: null, cmp_of: null, lift: null, edge_share: null, ...(extra ? extra(x) : {}),
      })
    );
  };

  for (let i = 0; i < Y; i++) {
    for (let j = i; j < Y; j++) {
      const N = yp[j + 1] - yp[i];
      if (N < PARAMS.minRangeVideos) continue;
      const from = years[i].year;
      const to = years[j].year;
      const phrases: Scored[] = [];
      const keywords: Scored[] = [];
      const formulas: Scored[] = [];
      for (const it of prepared) {
        const df = it.p[j + 1] - it.p[i];
        if (df < PARAMS.minVideos) continue;
        const sc = { s: it.s, df, words: it.words };
        if (it.formula) formulas.push(sc);
        else if (it.s.kind === "phrase") phrases.push(sc);
        else keywords.push(sc);
      }
      emit(from, to, "phrases", collapse(phrases, 2).sort(byDf).slice(0, PARAMS.topK), N);
      emit(from, to, "keywords", keywords.sort(byDf).slice(0, PARAMS.topK), N);
      emit(from, to, "formulas", collapse(formulas, 1).sort(byDf).slice(0, PARAMS.formulasTopK), N, (x) => ({
        edge_share: Math.round((x.s.edge / x.s.long) * 100) / 100,
      }));

      const cmp = distinctiveComparison(years, from, to);
      if ("years" in cmp) {
        const idx = cmp.years.map((y) => years.findIndex((yc) => yc.year === y));
        const scored: (Scored & { cdf: number; lift: number })[] = [];
        for (const x of keywords) {
          const per = x.s.perYear;
          let cdf = 0;
          for (const k of idx) cdf += per[k] ?? 0;
          // +0.5 smoothing keeps words absent from the comparison years finite.
          const lift = (x.df / N) / ((cdf + 0.5) / (cmp.videos + 1));
          if (lift >= PARAMS.minLift) scored.push({ ...x, cdf, lift });
        }
        scored.sort((a, b) => b.lift - a.lift || byDf(a, b));
        emit(from, to, "distinctive", scored.slice(0, PARAMS.topK), N, (x) => {
          const d = x as Scored & { cdf: number; lift: number };
          return { cmp_videos: d.cdf, cmp_of: cmp.videos, lift: Math.round(d.lift * 10) / 10 };
        });
      }
    }
  }
  return rows;
}

/** Caption-spelling flags for an item label ("cardinal" -> Cardano). */
export function captionFlags(item: string): string[] {
  const out = new Set<string>();
  for (const w of item.toLowerCase().split(/\s+/)) {
    const hit = CAPTION_SPELLINGS[foldWord(w)] ?? CAPTION_SPELLINGS[w];
    if (hit) out.add(hit);
  }
  return [...out];
}
