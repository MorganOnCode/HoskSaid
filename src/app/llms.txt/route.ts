import { buildLlmsTxt } from "@/lib/machine-files";

export const dynamic = "force-dynamic";

export async function GET() {
  const body = await buildLlmsTxt();
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
