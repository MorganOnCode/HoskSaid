import { NextRequest } from "next/server";
import { searchSegments } from "@/lib/api";
import { rateLimited } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** GET /api/search?q=&limit=&video_id= → ranked transcript segments. */
export async function GET(request: NextRequest) {
  const limited = rateLimited(request);
  if (limited) return limited;
  const sp = request.nextUrl.searchParams;
  const q = (sp.get("q") || "").trim();
  if (!q) return Response.json({ items: [] });
  try {
    const items = await searchSegments(q, {
      limit: sp.get("limit") ? parseInt(sp.get("limit")!, 10) : undefined,
      videoId: sp.get("video_id") || undefined,
      dateFrom: sp.get("date_from") || undefined,
      dateTo: sp.get("date_to") || undefined,
    });
    return Response.json({ items });
  } catch (error) {
    console.error("GET /api/search:", error);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
