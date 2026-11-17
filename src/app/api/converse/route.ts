import { NextRequest } from "next/server";
import { converse } from "@/lib/converse";
import { clientIdentity, rateLimited } from "@/lib/ratelimit";
import { readJsonBody } from "@/lib/body";
import { describeError, jsonError } from "@/lib/errors";
import { isSameOriginRequest } from "@/lib/security";
import { MAX_CONVERSE_BODY_BYTES, PROVIDER_KEY_HEADER } from "@/lib/byok-catalog";
import { validateConverseBody, validateProviderKey } from "@/lib/byok-validate";
import { PROVIDER_MESSAGES, ProviderError, claimClientSlot } from "@/lib/byok-providers";
import { BudgetExceededError } from "@/lib/usage";
import type { AskFilters } from "@/lib/ask-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where to find the same question by keyword (no model call, no embedding). */
function keywordSearchPath(query: string, filters: AskFilters | undefined): string {
  const p = new URLSearchParams({ q: query.slice(0, 200) });
  for (const id of filters?.video_ids ?? []) p.append("video_id", id);
  if (filters?.date_from) p.set("date_from", filters.date_from);
  if (filters?.date_to) p.set("date_to", filters.date_to);
  return `/api/search/keyword?${p.toString()}`;
}

/**
 * POST /api/converse: a grounded answer written by the visitor's own provider.
 * Browser same-origin only. Key: `x-provider-key` header (never body or URL).
 * Body: { provider, model, query, filters?, history?: [{question, answer, segment_ids?}] }
 * 200: AskResponse + { generated_by, grounded, retrieval, conversation }
 * 422: { matched: 0, suggestions, insufficient_evidence: true, keyword_search }
 * 400/413/415: invalid input · 403: cross-origin · 401/429: limiter, client allowance or in-flight limit
 * 502/504: provider_error (provider_error: code) · 503: retrieval budget or busy
 *
 * Nothing here is stored or cached, and no site-funded answer is ever made.
 */
export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const noStore = { "Cache-Control": "no-store", "x-request-id": requestId };

  if (
    !isSameOriginRequest(
      {
        origin: request.headers.get("origin"),
        host: request.headers.get("host"),
        secFetchSite: request.headers.get("sec-fetch-site"),
      },
      process.env.PUBLIC_BASE_URL || "https://thehosksaid.com"
    )
  ) {
    return jsonError(403, { error: "cross_origin_forbidden", message: "This endpoint only serves the thehosksaid.com website.", request_id: requestId });
  }

  const limited = rateLimited(request);
  if (limited) return limited;

  const body = await readJsonBody(request, MAX_CONVERSE_BODY_BYTES);
  if (!body.ok) return jsonError(body.status, { error: body.error, request_id: requestId });
  const v = validateConverseBody(body.value);
  if (!v.ok) return jsonError(400, { error: v.error, message: v.detail, request_id: requestId });
  const key = validateProviderKey(request.headers.get(PROVIDER_KEY_HEADER));
  if (!key.ok) return jsonError(400, { error: key.error, message: key.detail, request_id: requestId });

  const client = clientIdentity(request);
  const releaseSlot = claimClientSlot(client);
  if (!releaseSlot) {
    return jsonError(429, { error: "too_many_in_flight", message: "Wait for your current answer before asking again.", request_id: requestId }, { "Retry-After": "5" });
  }

  const { provider, model, query, filters, scope, history } = v.value;
  try {
    const result = await converse({ provider, model, key: key.value, query, scope, history, client });
    if ("matched" in result) {
      return Response.json({ ...result, keyword_search: keywordSearchPath(query, filters) }, { status: 422, headers: noStore });
    }
    return Response.json(result, { status: 200, headers: noStore });
  } catch (e) {
    if (e instanceof ProviderError) {
      return jsonError(e.code === "timeout" ? 504 : 502, {
        error: "provider_error",
        provider: e.provider,
        provider_error: e.code,
        message: PROVIDER_MESSAGES[e.code],
        site_model_used: false,
        request_id: requestId,
      });
    }
    const d = describeError(e);
    if (d.status === 500) console.error(`[converse ${requestId}]`, e instanceof Error ? e.name : "unknown error");
    const retrievalLimited = e instanceof BudgetExceededError && e.kind === "embedding";
    return jsonError(
      d.status,
      {
        ...d.body,
        ...(retrievalLimited
          ? {
              retrieval_limited: true,
              message:
                e.scope === "client"
                  ? "Your daily semantic-search allowance on this site is used up until 00:00 UTC. Your API key pays only for the answer and cannot raise this allowance. Keyword search still works and costs nothing."
                  : "This site's shared daily semantic-search allowance is used up until 00:00 UTC. Your API key pays only for the answer and cannot raise this allowance. Keyword search still works and costs nothing.",
              keyword_search: keywordSearchPath(query, filters),
            }
          : {}),
        request_id: requestId,
      },
      d.headers
    );
  } finally {
    releaseSlot();
  }
}
