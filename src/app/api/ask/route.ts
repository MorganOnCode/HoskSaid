import { NextRequest } from "next/server";
import { askArchive } from "@/lib/retrieval";
import type { AskFilters, AskResponse } from "@/lib/ask-types";
import { rateLimited, cacheGet, cacheSet } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ask — synthesized, citation-backed answer.
 * Body: { query: string, filters?: {...}, with_citations?: boolean }
 * 200: { query, answer, lede, citations[], sources[] }
 * 422: { matched: 0, suggestions: [] }   (nothing cleared the relevance threshold)
 * 400/500: { error, request_id }
 */
export async function POST(request: NextRequest) {
  const limited = rateLimited(request);
  if (limited) return limited;

  const requestId = crypto.randomUUID().slice(0, 8);

  let body: { query?: string; filters?: AskFilters; with_citations?: boolean };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_body", request_id: requestId }, { status: 400 });
  }

  const query = (body.query ?? "").trim();
  if (!query) {
    return Response.json({ error: "query_required", request_id: requestId }, { status: 400 });
  }

  // Hot-query cache (normalized query + filters), short TTL.
  const cacheKey = `ask:${query.toLowerCase()}:${JSON.stringify(body.filters ?? {})}:${body.with_citations ?? true}`;
  const cached = cacheGet<AskResponse>(cacheKey);
  if (cached) {
    return Response.json(cached, { status: 200, headers: { "x-request-id": requestId, "x-cache": "hit" } });
  }

  try {
    const result = await askArchive(query.slice(0, 1000), body.filters, {
      withCitations: body.with_citations ?? true,
      persist: true,
      requestId,
    });

    if ("matched" in result) {
      return Response.json(result, { status: 422 });
    }
    cacheSet(cacheKey, result, 300);
    return Response.json(result, { status: 200, headers: { "x-request-id": requestId } });
  } catch (error) {
    console.error(`[ask ${requestId}]`, error);
    return Response.json({ error: "internal", request_id: requestId }, { status: 500 });
  }
}
