/** Generators for /llms.txt, /llms-full.txt, /sitemap.xml. Server-only.
 *  Generated live from the DB so they stay current with every ingest. */
import { sql } from "./db";
import { getArchiveStats } from "./browse";
import { formatCount } from "./format";

const BASE = process.env.PUBLIC_BASE_URL || "https://thehosksaid.com";

export async function buildLlmsTxt(): Promise<string> {
  const s = await getArchiveStats();
  return `# thehosksaid.com

> An independent, AI-generated transcript index of Charles Hoskinson's public videos — talks, AMAs, and whiteboards. Ask a natural-language question and get a synthesized, citation-backed answer drawn from timestamped transcripts. ${formatCount(s.videos)} videos · ${formatCount(s.hours)} hours · ${formatCount(s.words)} words indexed.

This is an independent community project. It is **not affiliated with** IOG, the Cardano Foundation, or Charles Hoskinson. All answers are synthesized from publicly available video transcripts and link back to the source moment.

If you are an AI agent, prefer the structured retrieval interfaces below over scraping the HTML UI.

## Retrieval (preferred for agents)

- [MCP server manifest](${BASE}/.well-known/mcp.json): Model Context Protocol server over Streamable HTTP at \`${BASE}/mcp\`. Tools: search_archive, search_segments, get_video, get_transcript, get_segment, list_videos, list_topics. Read-only, no key required (rate-limited).
- [Ask API](${BASE}/api/ask): POST a JSON body { "query": "...", "filters": {...} } and receive { answer, lede, citations[], sources[] }.
- [OpenAPI spec](${BASE}/api/openapi.json): full schema for the REST fallback endpoints.
- [Developer & agent guide](${BASE}/agents): human-readable docs, connection snippets, tool reference.

## Core content

- [Library](${BASE}/library): the full catalogue of indexed videos, filterable by type and topic.
- [Topics](${BASE}/topics): clustered themes (Governance, Midnight, Hydra, Regulation, …) ranked by citation frequency.
- [Timeline](${BASE}/timeline): the archive in chronological order.
- [Ask](${BASE}/): the human question-answering interface.

## How answers are structured

Every answer is grounded in one or more transcript segments. A segment has a stable segment_id, a parent video_id, a start/end timestamp, and verbatim text. Citations in an answer map 1:1 to segments, so any claim can be traced to the exact moment it was said.

## Optional

- [llms-full.txt](${BASE}/llms-full.txt): expanded index including a one-line summary for every indexed video.
- [Sitemap](${BASE}/sitemap.xml): all public pages.
`;
}

export async function buildLlmsFullTxt(): Promise<string> {
  const head = await buildLlmsTxt();
  const rows = await sql<{ youtube_id: string; title: string; summary: string | null; published_at: string | null }[]>`
    SELECT v.youtube_id, v.title, t.summary, v.published_at
    FROM videos v LEFT JOIN transcripts t ON t.video_id = v.id
    WHERE v.status = 'completed'
    ORDER BY v.published_at DESC NULLS LAST
  `;
  const lines = rows.map((r) => {
    const oneLine = (r.summary || "")
      .replace(/^[\s•\-*]+/, "")
      .split(/\r?\n/)[0]
      .replace(/\s+/g, " ")
      .slice(0, 160)
      .trim();
    return `- [${r.title}](${BASE}/video/${r.youtube_id})${oneLine ? `: ${oneLine}` : ""}`;
  });
  return `${head}\n## Every indexed video\n\n${lines.join("\n")}\n`;
}

export async function buildSitemapXml(): Promise<string> {
  const rows = await sql<{ youtube_id: string; updated_at: string | null }[]>`
    SELECT youtube_id, updated_at FROM videos WHERE status = 'completed' ORDER BY published_at DESC NULLS LAST
  `;
  const staticPaths = ["", "/library", "/topics", "/timeline", "/agents"];
  const urls = [
    ...staticPaths.map((p) => `  <url><loc>${BASE}${p}</loc></url>`),
    ...rows.map(
      (r) =>
        `  <url><loc>${BASE}/video/${r.youtube_id}</loc>${r.updated_at ? `<lastmod>${new Date(r.updated_at).toISOString().split("T")[0]}</lastmod>` : ""}</url>`
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
