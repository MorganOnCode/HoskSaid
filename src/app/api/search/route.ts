import { NextRequest } from "next/server";
import { searchSegments } from "@/lib/api";
import { clientIdentity, rateLimited } from "@/lib/ratelimit";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, clampInt, isYoutubeId, validateFilters, validateQuery } from "@/lib/limits";
import { errorResponse, jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** GET /api/search?q=&limit=&video_id=&date_from=&date_to= → ranked transcript segments. */
export async function GET(request: NextRequest) {
  const limited = rateLimited(request);
  if (limited) return limited;
  const sp = request.nextUrl.searchParams;
  if (!(sp.get("q") || "").trim()) return Response.json({ items: [] });

  const q = validateQuery(sp.get("q"));
  if (!q.ok) return jsonError(400, { error: q.error, message: q.detail });
  const videoId = sp.get("video_id") || undefined;
  if (videoId && !isYoutubeId(videoId)) return jsonError(400, { error: "invalid_video_id" });
  const f = validateFilters({
    ...(sp.get("date_from") ? { date_from: sp.get("date_from") } : {}),
    ...(sp.get("date_to") ? { date_to: sp.get("date_to") } : {}),
  });
  if (!f.ok) return jsonError(400, { error: f.error, message: f.detail });

  try {
    const items = await searchSegments(q.value, {
      client: clientIdentity(request),
      limit: clampInt(sp.get("limit"), DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT),
      videoId,
      from: f.value.scope.from,
      to: f.value.scope.to,
    });
    return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
