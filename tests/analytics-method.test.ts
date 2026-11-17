/** /analytics ranking method and URL contract: pure functions, no database. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PARAMS, captionFlags, computeRankings, distinctiveComparison, extractItems, foldWord, isContentWord, isFormula, tokenize,
  type ItemStats, type YearCount,
} from "../src/lib/analytics/method";
import { MAX_TERM_CHARS, MAX_TERMS, parseView, termForItem, validateTerms, viewHref } from "../src/lib/analytics/params";
import { SUBJECTS, subjectForQuery } from "../src/lib/analytics/subjects";
import { excerptPatterns, termParts } from "../src/lib/analytics/data";

/** n words of stopwords/fillers only: never ranked, so tests control every content word. */
const FILLER = "so we are going to think about it and you know that is really what we do".split(" ");
const filler = (n: number) => Array.from({ length: n }, (_, i) => FILLER[i % FILLER.length]).join(" ");

describe("tokens and content words", () => {
  test("lower-cases, keeps apostrophes, records sentence breaks", () => {
    const t = tokenize("Cardano’s Hydra works. Partner chains!");
    assert.deepEqual(t.words, ["cardano's", "hydra", "works", "partner", "chains"]);
    assert.deepEqual([...t.breakAfter], [0, 0, 1, 0, 1]);
  });

  test("caption annotations are dropped and break phrases", () => {
    const t = tokenize("[Music] stake pool [Applause] operators [Music]");
    assert.deepEqual(t.words, ["stake", "pool", "operators"]);
    assert.ok(!extractItems("stake pool [Music] operators").phrases.has("pool operator"));
  });

  test("simple plurals and possessives fold together; other -s words do not", () => {
    assert.equal(foldWord("contracts"), "contract");
    // One video saying both forms holds one item, so it counts once.
    const it = extractItems("smart contract and smart contracts");
    assert.ok(it.phrases.has("smart contract") && !it.phrases.has("smart contracts"));
    assert.equal(foldWord("cardano's"), "cardano");
    for (const w of ["process", "status", "analysis", "physics", "news"]) assert.equal(foldWord(w), w);
  });

  test("stopwords and the conversational stoplist are never content words", () => {
    for (const w of ["the", "basically", "gonna", "people", "things", "ok"]) assert.equal(isContentWord(w), false, w);
    for (const w of ["midnight", "hydra", "contracts"]) assert.equal(isContentWord(w), true, w);
  });

  test("phrases start and end with content words and never cross a sentence break", () => {
    const it = extractItems("We built partner chains. Proof of stake matters");
    assert.ok(it.phrases.has("partner chain"));
    assert.ok(it.phrases.has("proof of stake"));
    assert.ok(!it.phrases.has("chain proof"), "crosses a break");
    assert.ok(!it.phrases.has("built partner chain proof"));
    assert.equal(it.phrases.get("partner chain")?.label, "partner chains");
  });

  test("an item is edge-only when every occurrence is in the first/last edge words", () => {
    const text = `warm sunny colorado ${filler(700)} midnight ${filler(300)} warm sunny colorado`;
    const it = extractItems(text);
    assert.equal(it.phrases.get("warm sunny colorado")?.allEdge, true);
    assert.equal(it.keywords.get("midnight")?.allEdge, false);
  });
});

/** Build ItemStats from per-video item sets so tests state documents, not counts. */
function statsFrom(videos: { year: number; text: string }[]): { years: YearCount[]; items: ItemStats[] } {
  const yearsSorted = [...new Set(videos.map((v) => v.year))].sort();
  const yi = new Map(yearsSorted.map((y, i) => [y, i]));
  const counts = new Array(yearsSorted.length).fill(0);
  const acc = new Map<string, ItemStats & { perYear: Int32Array }>();
  for (const v of videos) {
    const it = extractItems(v.text);
    const i = yi.get(v.year)!;
    counts[i]++;
    const long = it.words >= PARAMS.longVideoWords;
    for (const [kind, map] of [["word", it.keywords], ["phrase", it.phrases]] as const) {
      for (const [k, o] of map) {
        const id = `${kind}:${k}`;
        let a = acc.get(id);
        if (!a) acc.set(id, (a = { key: k, label: o.label, kind, perYear: new Int32Array(yearsSorted.length), long: 0, edge: 0 }));
        a.perYear[i]++;
        if (long) {
          a.long++;
          if (o.allEdge) a.edge++;
        }
      }
    }
  }
  return { years: yearsSorted.map((y, i) => ({ year: y, videos: counts[i] })), items: [...acc.values()] };
}

describe("rankings", () => {
  // 24 long videos per year in 2020, 2021, 2022, 2023, 2025. Every video opens
  // with the same greeting; "proof of stake" sits mid-transcript in half of them;
  // early-era captions spell Cardano "cardinal"; Leios only appears in 2025.
  const videos: { year: number; text: string }[] = [];
  for (const year of [2020, 2021, 2022, 2023, 2025]) {
    for (let i = 0; i < 24; i++) {
      const mid = [
        i % 2 === 0 ? "proof of stake works" : "consensus",
        year < 2022 ? "the cardinal network" : "the cardano network",
        year === 2025 ? "leios throughput" : "",
        i < 6 ? "stake pool operators" : "",
      ].join(` ${filler(6)} `);
      videos.push({ year, text: `this is charles hoskinson broadcasting live from warm sunny colorado ${filler(400)} ${mid} ${filler(400)} cheers` });
    }
  }
  const { years, items } = statsFrom(videos);
  const rows = computeRankings(years, items);
  const list = (from: number, to: number, l: string) => rows.filter((r) => r.year_from === from && r.year_to === to && r.list === l);

  test("counts are videos with n/N denominators for the range", () => {
    const pos = list(2020, 2025, "phrases").find((r) => r.item === "proof of stake");
    assert.ok(pos);
    assert.equal(pos.videos, 60);
    assert.equal(pos.of_videos, 120);
    const one = list(2022, 2022, "phrases").find((r) => r.item === "proof of stake");
    assert.deepEqual([one?.videos, one?.of_videos], [12, 24]);
  });

  test("a repeated greeting is listed as intro/sign-off, never in the phrase or keyword rankings", () => {
    const phrases = list(2020, 2025, "phrases").map((r) => r.item);
    const keywords = list(2020, 2025, "keywords").map((r) => r.item);
    assert.ok(!phrases.some((p) => /sunny|hoskinson|broadcasting/.test(p)), phrases.join(", "));
    assert.ok(!keywords.includes("cheers") && !keywords.includes("colorado"));
    const formulas = list(2020, 2025, "formulas");
    assert.ok(formulas.some((r) => r.item.includes("warm sunny colorado")), formulas.map((r) => r.item).join(", "));
    assert.ok(formulas.some((r) => r.item === "cheers" && r.edge_share === 1));
  });

  test("a shorter phrase is folded into a longer one that covers its videos", () => {
    const phrases = list(2020, 2025, "phrases").map((r) => r.item);
    assert.ok(phrases.includes("stake pool operators"));
    assert.ok(!phrases.includes("pool operators"), "pool operators only occurs inside stake pool operators");
  });

  test("ranges with too few videos are not ranked", () => {
    const thin = statsFrom(videos.slice(0, 10));
    assert.equal(computeRankings(thin.years, thin.items).length, 0);
  });

  test("distinctive keywords compare within one caption era only", () => {
    assert.deepEqual(distinctiveComparison(years, 2020, 2023), { unavailable: "crosses_era" });
    assert.deepEqual(distinctiveComparison(years, 2022, 2025), { unavailable: "no_comparison" });
    assert.equal(list(2020, 2023, "distinctive").length, 0);
    const d2025 = list(2025, 2025, "distinctive");
    assert.equal(d2025[0].item, "leios");
    assert.deepEqual([d2025[0].videos, d2025[0].of_videos, d2025[0].cmp_videos, d2025[0].cmp_of], [24, 24, 0, 48]);
    // (24/24) / ((0 + 0.5) / (48 + 1)) = 98
    assert.equal(d2025[0].lift, 98);
    // "cardinal" is in every early video, so it is not distinctive inside the early era.
    assert.ok(!list(2021, 2021, "distinctive").some((r) => r.item === "cardinal"));
  });

  test("known caption spellings are flagged", () => {
    assert.ok(list(2020, 2021, "keywords").some((r) => r.item === "cardinal"));
    assert.deepEqual(captionFlags("cardinal"), ["Cardano"]);
    assert.deepEqual(captionFlags("the cardno network"), ["Cardano"]);
    assert.deepEqual(captionFlags("hydra"), []);
  });

  test("the formula rule needs enough long videos", () => {
    assert.equal(isFormula({ long: 4, edge: 4 }), false);
    assert.equal(isFormula({ long: 10, edge: 5 }), true);
    assert.equal(isFormula({ long: 10, edge: 4 }), false);
  });
});

describe("query contract", () => {
  test("at most three terms of at most 200 characters", () => {
    assert.deepEqual(validateTerms(["midnight", " Midnight ", "hydra"]), { ok: true, terms: ["midnight", "hydra"] });
    const four = validateTerms(["a1", "b1", "c1", "d1"]);
    assert.equal(four.ok, false);
    assert.equal(!four.ok && four.error, "too_many_terms");
    const long = validateTerms(["x".repeat(MAX_TERM_CHARS + 1)]);
    assert.equal(!long.ok && long.error, "term_too_long");
  });

  test("the page parses leniently and says what it dropped", () => {
    const { view, notices } = parseView({ q: ["a1", "b1", "c1", "d1", "x".repeat(250)], from: "2026", to: "2019", year: "2030", page: "99", tab: "bogus" });
    assert.equal(view.terms.length, MAX_TERMS);
    assert.deepEqual([view.from, view.to, view.year, view.page, view.tab], [2019, 2026, null, 20, "subjects"]);
    assert.equal(notices.length, 3);
  });

  test("a view round-trips through its URL", () => {
    const { view } = parseView({ q: ["midnight", '"partner chains"'], from: "2019", to: "2026", year: "2025", focus: '"partner chains"', page: "2", tab: "phrases", m: "count", view: "table" });
    const href = viewHref(view);
    assert.equal(href, "/analytics?q=midnight&q=%22partner+chains%22&from=2019&to=2026&tab=phrases&focus=%22partner+chains%22&year=2025&page=2&m=count&view=table");
    const again = parseView(Object.fromEntries([...new URL(href, "http://x").searchParams].reduce((m, [k, v]) => m.set(k, [...(m.get(k) ?? []), v]), new Map<string, string[]>())));
    assert.deepEqual(again.view, view);
    assert.equal(viewHref({ ...view, terms: [] }), "/analytics?from=2019&to=2026&tab=phrases");
  });

  test("ranked phrases become quoted queries", () => {
    assert.equal(termForItem("partner chains"), '"partner chains"');
    assert.equal(termForItem("midnight"), "midnight");
  });

  test("excerpts look for the quoted phrase before single words", () => {
    assert.deepEqual(termParts('"partner chains" OR hydra -heads the'), { phrases: [["partner", "chains"]], words: ["hydra"] });
    const [phrase, word] = excerptPatterns('"partner chains" OR hydra');
    assert.equal(phrase, "\\mpartner\\w*\\W+chain\\w*");
    assert.equal(word, "\\mhydra\\w*");
  });
});

describe("subjects", () => {
  test("every subject has a unique slug and a bounded public query", () => {
    for (const s of SUBJECTS) assert.ok(s.query.length <= MAX_TERM_CHARS, s.slug);
    assert.equal(new Set(SUBJECTS.map((s) => s.slug)).size, SUBJECTS.length);
    assert.equal(subjectForQuery("  MIDNIGHT ")?.slug, "midnight");
  });
});
