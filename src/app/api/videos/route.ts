import { NextRequest } from "next/server";
import { listVideosApi } from "@/lib/api";
import { rateLimited } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** GET /api/videos?type=&topic=&sort=&cursor=&limit= → { items, next_cursor } */
export async function GET(request: NextRequest) {
  const limited = rateLimited(request);
  if (limited) return limited;
  const sp = request.nextUrl.searchParams;
  try {
    const result = await listVideosApi({
      type: sp.get("type") || undefined,
      topic: sp.get("topic") || undefined,
      sort: sp.get("sort") || undefined,
      cursor: sp.get("cursor") || undefined,
      limit: sp.get("limit") ? parseInt(sp.get("limit")!, 10) : undefined,
    });
    return Response.json(result);
  } catch (error) {
    console.error("GET /api/videos:", error);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
