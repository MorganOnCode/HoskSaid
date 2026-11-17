/**
 * Deterministic evidence check for generated statements (pure).
 *
 * A valid citation id only says which source a statement claims to rest on; it
 * does not show the source says it. This check compares each statement with
 * the stored text of the sources it cites and rejects it when:
 *   - it contains a number that the cited text does not contain;
 *   - it names a capitalised term (not at sentence start, not on a small
 *     allowlist) that the cited text never mentions;
 *   - too few of its content words occur in the cited text.
 *
 * This is a lexical guard against invented specifics and off-source
 * paraphrase. It is not semantic verification: a statement that reuses the
 * source's words can still distort it, so editorial review stays required.
 */

const STOP = new Set(
  (
    "a an and are as at be been being but by can could did do does doing for from had has have having he her hers him his how i if in into is it its " +
    "itself just may me might more most much must my no nor not of off on once only or other our ours out over own same she should so some such than " +
    "that the their theirs them then there these they this those through to too under until up very was we were what when where which while who whom " +
    "why will with would you your yours also about again against all any because before below between both down during each few further here " +
    "above after am let lets thing things way ways lot lots really like well make makes made get gets got going go goes " +
    // attribution and framing verbs a summary legitimately adds
    "argue argued argues arguing said say says saying discuss discussed discusses discussing explain explained explains explaining note noted notes " +
    "noting describe described describes describing emphasise emphasised emphasize emphasized emphasizes emphasizing highlight highlighted highlights " +
    "talk talked talks talking spoke speak speaks mention mentioned mentions suggest suggested suggests point pointed points claim claimed claims " +
    "stress stressed stresses outline outlined outlines share shared shares cover covered covers address addressed addresses video videos month " +
    "charles hoskinson discussion overall several many various key main also according view views update updates"
  ).split(/\s+/)
);

/** Names a summary may use without the cited excerpt repeating them. */
const NAME_ALLOW = new Set(
  (
    "charles hoskinson i january february march april may june july august september october november december " +
    "monday tuesday wednesday thursday friday saturday sunday ama"
  ).split(/\s+/)
);

const NUM_RE = /\d+(?:[.,]\d+)*/g;

function normNum(n: string): string {
  return n.replace(/,(?=\d{3}\b)/g, "").replace(/\.0+$/, "");
}

export function stem(w: string): string {
  let s = w.toLowerCase();
  if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 4 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z'-]*[a-z]|[a-z]/g) ?? [];
}

function contentWords(text: string): string[] {
  return words(text)
    .map((w) => w.replace(/'s$/, ""))
    .filter((w) => w.length >= 4 && !STOP.has(w));
}

/** Capitalised words that are not the first word of a sentence. */
function namedTerms(text: string): string[] {
  const out: string[] = [];
  const re = /([.!?:;"“(]\s*|^\s*)?\b([A-Z][A-Za-z0-9-]*[A-Za-z0-9])\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) continue; // sentence/clause start
    const term = m[2].toLowerCase().replace(/'s$/, "");
    if (!NAME_ALLOW.has(term)) out.push(term);
  }
  return out;
}

export interface GroundingOptions {
  /** Fraction of content words that must occur in the evidence (default 0.5). */
  minOverlap?: number;
}

export type GroundingResult = { ok: true; overlap: number } | { ok: false; overlap: number; reason: string };

export function checkGrounding(statement: string, evidence: string[], opts: GroundingOptions = {}): GroundingResult {
  const minOverlap = opts.minOverlap ?? 0.5;
  const ev = evidence.join("\n");
  if (!ev.trim()) return { ok: false, overlap: 0, reason: "cited sources have no stored text" };

  const evNums = new Set((ev.match(NUM_RE) ?? []).map(normNum));
  const missingNums = [...new Set((statement.match(NUM_RE) ?? []).map(normNum))].filter((n) => !evNums.has(n));
  if (missingNums.length) return { ok: false, overlap: 0, reason: `number not in cited source: ${missingNums.slice(0, 3).join(", ")}` };

  const evWords = new Set(words(ev).map((w) => w.replace(/'s$/, "")));
  const evStems = new Set([...evWords].map(stem));
  const missingNames = [...new Set(namedTerms(statement))].filter((t) => !evWords.has(t) && !evStems.has(stem(t)));
  if (missingNames.length) return { ok: false, overlap: 0, reason: `name not in cited source: ${missingNames.slice(0, 3).join(", ")}` };

  const cw = [...new Set(contentWords(statement).map(stem))];
  if (!cw.length) return { ok: false, overlap: 0, reason: "statement has no checkable content" };
  const hit = cw.filter((w) => evStems.has(w)).length;
  const overlap = hit / cw.length;
  if (overlap < minOverlap) {
    return { ok: false, overlap, reason: `only ${hit}/${cw.length} content words appear in the cited source` };
  }
  return { ok: true, overlap };
}
