import { NextRequest } from "next/server";
import { MAX_KEYWORD_QUERY, keywordSearchApi } from "@/lib/api";
import { rateLimited } from "@/lib/ratelimit";
import { MAX_FILTER_VIDEO_IDS, isYoutubeId, validateFilters } from "@/lib/limits";
import { errorResponse, jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/search/keyword?q=&video_id=&video_id=&date_from=&date_to=&limit=&offset=
 * Keyword matches in titles, tags and full transcripts, with excerpts and deep
 * links. No model call and no embedding: it needs no provider key and no daily
 * allowance, and it also finds videos that semantic search cannot reach.
 */
export async function GET(request: NextRequest) {
  const limited = rateLimited(request);
  if (limited) return limited;
  const sp = request.nextUrl.searchParams;
  const q = (sp.get("q") || "").trim();
  if (!q) return Response.json({ items: [], total: 0, mode: "keyword", model_calls: 0 });
  if (q.length > MAX_KEYWORD_QUERY) {
    return jsonError(400, { error: "query_too_long", message: `keyword queries must be at most ${MAX_KEYWORD_QUERY} characters` });
  }
  const ids = sp.getAll("video_id");
  if (ids.length > MAX_FILTER_VIDEO_IDS || !ids.every(isYoutubeId)) return jsonError(400, { error: "invalid_video_id" });
  const f = validateFilters({
    ...(sp.get("date_from") ? { date_from: sp.get("date_from") } : {}),
    ...(sp.get("date_to") ? { date_to: sp.get("date_to") } : {}),
  });
  if (!f.ok) return jsonError(400, { error: f.error, message: f.detail });

  try {
    const result = await keywordSearchApi(q, {
      youtubeIds: ids.length ? [...new Set(ids)] : null,
      from: f.value.scope.from,
      to: f.value.scope.to,
      limit: Number(sp.get("limit") ?? undefined),
      offset: Number(sp.get("offset") ?? undefined),
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
