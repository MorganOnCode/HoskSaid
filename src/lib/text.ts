/**
 * Display-side text repair (client-safe). About 300 transcripts and ~2,000
 * chunks were stored with HTML entities escaped once or twice (`how&amp;#39;s`).
 * Re-cleaning and re-embedding that data is a separate, cost-approved pass; until
 * then every place that shows transcript text decodes it here. Output is plain
 * text for React to escape, never HTML.
 */
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeOnce(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6}|#39);/gi, (full, ent: string) => {
    const e = ent.toLowerCase();
    if (e in NAMED) return NAMED[e];
    if (e.startsWith("#x") || e.startsWith("#")) {
      const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
    }
    return full;
  });
}

/** Decode up to three layers of HTML entity escaping. */
export function decodeEntities(s: string | null | undefined): string {
  if (!s) return "";
  let out = s;
  for (let i = 0; i < 3 && /&(?:#x?[0-9a-f]+|[a-z]{2,6});/i.test(out); i++) out = decodeOnce(out);
  return out;
}
