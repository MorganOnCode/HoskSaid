/**
 * Shared transcript text utilities (safe for both client and server).
 * Keep this file free of Node.js-specific imports (child_process, fs, etc.).
 * Ported from tubechat.
 */

/** A single "Key takeaways" bullet, optionally anchored to a moment in the video. */
export interface SummaryPoint {
  text: string;
  /** Seconds offset of the best-matching transcript moment, when one is found. */
  start?: number;
}

// Common words that carry no topical signal — dropped before matching.
const SUMMARY_STOPWORDS = new Set([
  "that", "this", "with", "from", "they", "have", "what", "when", "their", "there",
  "would", "about", "which", "these", "those", "into", "than", "then", "them", "were",
  "been", "also", "such", "only", "even", "more", "most", "some", "much", "very", "just",
  "like", "your", "will", "said", "says", "here", "over", "because", "while", "where",
]);

function summaryTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (w) => w.length >= 4 && !SUMMARY_STOPWORDS.has(w)
  );
}

/**
 * Pick the single most query-relevant sentence from a chunk (max token overlap).
 * Used to derive the `quote` field for citations. Falls back to a trimmed prefix.
 */
export function bestQuote(chunkText: string, query: string, maxLen = 240): string {
  const sentences = chunkText.match(/[^.!?]+[.!?]+/g) ?? [chunkText];
  const qTokens = new Set(summaryTokens(query));
  let best = sentences[0] ?? chunkText;
  let bestScore = -1;
  for (const s of sentences) {
    let overlap = 0;
    for (const tok of summaryTokens(s)) if (qTokens.has(tok)) overlap++;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = s;
    }
  }
  const trimmed = best.trim().replace(/\s+/g, " ");
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen - 1).trimEnd() + "…" : trimmed;
}

/**
 * Split an AI bullet-point summary (lines beginning with "• ", "-", "*", or "1.")
 * into individual takeaway strings, stripping the leading marker.
 */
export function parseSummaryBullets(summary: string): string[] {
  return summary
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*[•\-*]\s+/, "")
        .replace(/^\s*\d+[.)]\s+/, "")
        .trim()
    )
    .filter(Boolean);
}

/**
 * Turn an AI summary string into seekable takeaways. Each bullet is anchored to the
 * timed transcript chunk with the most shared topical words (≥ 2 to trust the match);
 * bullets with no confident match — or when no timed chunks exist — render without a
 * timestamp so the box degrades to a plain summary.
 */
export function deriveSummaryPoints(
  summary: string | null | undefined,
  chunks: { start: number; text: string }[]
): SummaryPoint[] {
  if (!summary?.trim()) return [];
  const bullets = parseSummaryBullets(summary);
  if (chunks.length === 0) return bullets.map((text) => ({ text }));

  const chunkTokens = chunks.map((c) => ({ start: c.start, tokens: new Set(summaryTokens(c.text)) }));

  return bullets.map((text) => {
    const tokens = summaryTokens(text);
    if (tokens.length === 0) return { text };
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < chunkTokens.length; i++) {
      let overlap = 0;
      for (const tok of tokens) if (chunkTokens[i].tokens.has(tok)) overlap++;
      if (overlap > bestScore) {
        bestScore = overlap;
        bestIdx = i;
      }
    }
    return bestIdx >= 0 && bestScore >= 2 ? { text, start: chunkTokens[bestIdx].start } : { text };
  });
}
