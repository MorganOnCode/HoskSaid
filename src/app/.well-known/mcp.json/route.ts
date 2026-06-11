import manifest from "@/lib/contracts/mcp.json";

/** GET /.well-known/mcp.json — MCP server manifest, served as application/json. */
export async function GET() {
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
