import { buildSitemapXml } from "@/lib/machine-files";

export const dynamic = "force-dynamic";

export async function GET() {
  const body = await buildSitemapXml();
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
