/**
 * Error types that cross the API boundary (server-only), and their mapping to
 * HTTP responses. Messages are fixed strings: provider error bodies, request
 * headers and keys are never echoed to clients or logs.
 */
import { BudgetExceededError, BusyError, secondsUntilUtcMidnight, type SiteCallKind } from "./usage";

export interface ErrorBody {
  error: string;
  message?: string;
  request_id?: string;
  [k: string]: unknown;
}

export function jsonError(status: number, body: ErrorBody, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/**
 * Cap-specific advice. The embedding budget pays for finding transcript
 * segments, which every Ask and semantic search needs, so its message must not
 * suggest any route around it; Library keyword search needs neither budget.
 */
const BUDGET_MESSAGES: Record<SiteCallKind, string> = {
  answer:
    "Today's site-funded answer allowance is used up. Semantic segment search and Library keyword search still work. Answers resume at 00:00 UTC.",
  embedding:
    "Today's site-funded search allowance is used up, so neither answers nor semantic segment search can run until 00:00 UTC. Library keyword search still works.",
};

/** Classify pipeline failures into a status + safe body. Unknown errors become 500. */
export function describeError(e: unknown): { status: number; body: ErrorBody; headers: Record<string, string> } {
  if (e instanceof BudgetExceededError) {
    const retry = secondsUntilUtcMidnight();
    return {
      status: 503,
      body: {
        error: "site_budget_exhausted",
        budget: e.kind,
        message: BUDGET_MESSAGES[e.kind],
        retry_after: retry,
      },
      headers: { "Retry-After": String(retry) },
    };
  }
  if (e instanceof BusyError) {
    return { status: 503, body: { error: "busy", message: "The archive is busy. Retry in a few seconds." }, headers: { "Retry-After": "5" } };
  }
  return { status: 500, body: { error: "internal" }, headers: {} };
}

export function errorResponse(e: unknown, requestId?: string): Response {
  const d = describeError(e);
  if (d.status === 500) {
    // Log the class and message only; never request bodies or headers.
    console.error(`[api ${requestId ?? "-"}]`, e instanceof Error ? `${e.name}: ${e.message}` : "unknown error");
  }
  return jsonError(d.status, { ...d.body, ...(requestId ? { request_id: requestId } : {}) }, d.headers);
}
