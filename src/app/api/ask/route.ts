import { NextRequest } from "next/server";
import { askArchive } from "@/lib/retrieval";
import { rateLimited } from "@/lib/ratelimit";
import { readJsonBody } from "@/lib/body";
import { MAX_ASK_BODY_BYTES, validateFilters, validateQuery } from "@/lib/limits";
import { errorResponse, jsonError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ask — synthesized, citation-backed answer.
 * Body: { query: string (<=1000 chars), filters?: {...}, with_citations?: boolean }
 *       (unknown body and filter keys are ignored, as before)
 * 200: { query, answer, lede, citations[], sources[] }
 * 422: { matched: 0, suggestions: [] }   (nothing cleared the relevance threshold)
 * 400/413/415: invalid input · 401/429: limiter
 * 503: site budget exhausted (budget: answer|embedding) or busy · 500: { error, request_id }
 */
export async function POST(request: NextRequest) {
  const limited = rateLimited(request);
  if (limited) return limited;

  const requestId = crypto.randomUUID().slice(0, 8);
  const noStore = { "Cache-Control": "no-store", "x-request-id": requestId };

  const body = await readJsonBody(request, MAX_ASK_BODY_BYTES);
  if (!body.ok) return jsonError(body.status, { error: body.error, request_id: requestId });
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return jsonError(400, { error: "invalid_body", request_id: requestId });
  }
  const b = body.value as Record<string, unknown>;

  const q = validateQuery(b.query);
  if (!q.ok) return jsonError(400, { error: q.error, message: q.detail, request_id: requestId });
  const f = validateFilters(b.filters);
  if (!f.ok) return jsonError(400, { error: f.error, message: f.detail, request_id: requestId });
  if (b.with_citations !== undefined && typeof b.with_citations !== "boolean") {
    return jsonError(400, { error: "invalid_body", message: "with_citations must be a boolean", request_id: requestId });
  }

  try {
    const result = await askArchive(q.value, f.value.scope, f.value.filters, {
      withCitations: (b.with_citations as boolean | undefined) ?? true,
      persist: true,
      requestId,
    });

    if ("matched" in result) return Response.json(result, { status: 422, headers: noStore });
    const { cached, ...payload } = result;
    return Response.json(payload, { status: 200, headers: { ...noStore, ...(cached ? { "x-cache": "hit" } : {}) } });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
