const BASE = process.env.PUBLIC_BASE_URL || "https://thehosksaid.com";

const ROBOTS = `User-agent: *
Allow: /

# Independent transcript index of Charles Hoskinson's public videos.
# Machine-readable index for LLMs: ${BASE}/llms.txt
# MCP server manifest:              ${BASE}/.well-known/mcp.json

Sitemap: ${BASE}/sitemap.xml

# AI agents and assistant crawlers are welcome to read and cite this archive.
# Please prefer the MCP server or /api/ask over scraping rendered HTML.

User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

# Keep crawlers out of internal/transient endpoints
User-agent: *
Disallow: /api/ask
`;

/** GET /robots.txt — served as text/plain. */
export async function GET() {
  return new Response(ROBOTS, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
