const BASE = process.env.PUBLIC_BASE_URL || "https://thehosksaid.com";

// One group per agent: a crawler obeys only the most specific group naming it,
// so every group repeats the same Disallow lines for paid/transient endpoints.
const DISALLOW = ["/api/ask", "/api/search", "/mcp"];
const AGENTS = ["*", "GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"];

const ROBOTS = `# Independent transcript index of Charles Hoskinson's public videos.
# Machine-readable index for LLMs: ${BASE}/llms.txt
# MCP server manifest:              ${BASE}/.well-known/mcp.json
# AI agents and assistant crawlers are welcome to read and cite this archive.
# Please prefer the MCP server or /api/ask over scraping rendered HTML.

${AGENTS.map((a) => `User-agent: ${a}\nAllow: /\n${DISALLOW.map((d) => `Disallow: ${d}`).join("\n")}`).join("\n\n")}

Sitemap: ${BASE}/sitemap.xml
`;

/** GET /robots.txt — served as text/plain. */
export async function GET() {
  return new Response(ROBOTS, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
