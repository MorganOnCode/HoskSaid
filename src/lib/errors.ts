/**
 * Error types that cross the API boundary (server-only), and their mapping to
 * HTTP responses. Messages are fixed strings: provider error bodies, request
 * headers and keys are never echoed to clients or logs.
 */
import { BudgetExceededError, BusyError, secondsUntilUtcMidnight } from "./usage";

export type ProviderErrorCode =
  | "invalid_key"
  | "rate_limited"
  | "insufficient_quota"
  | "model_not_found"
  | "unavailable"
  | "timeout"
  | "bad_response";

/** A visitor-selected provider failed. There is never a fallback to the site key. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  constructor(provider: string, code: ProviderErrorCode) {
    super(`provider ${provider} failed: ${code}`);
    this.name = "ProviderError";
    this.code = code;
    this.provider = provider;
  }
}

const PROVIDER_MESSAGES: Record<ProviderErrorCode, string> = {
  invalid_key: "The provider rejected this API key. Check the key or create a new one.",
  rate_limited: "The provider is rate-limiting this key. Wait a moment and retry.",
  insufficient_quota: "The provider reports this key has no remaining credit or quota.",
  model_not_found: "The provider does not offer that model for this key.",
  unavailable: "The provider did not respond successfully. Retry, or choose another engine.",
  timeout: "The provider took too long to answer.",
  bad_response: "The provider returned a response this site could not read.",
};

export interface ErrorBody {
  error: string;
  message?: string;
  request_id?: string;
  [k: string]: unknown;
}

export function jsonError(status: number, body: ErrorBody, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/** Classify pipeline failures into a status + safe body. Unknown errors become 500. */
export function describeError(e: unknown): { status: number; body: ErrorBody; headers: Record<string, string> } {
  if (e instanceof BudgetExceededError) {
    const retry = secondsUntilUtcMidnight();
    return {
      status: 503,
      body: {
        error: "site_budget_exhausted",
        message: `Today's site-funded ${e.kind === "answer" ? "answer" : "search"} allowance is used up. It resets at 00:00 UTC.`,
        retry_after: retry,
      },
      headers: { "Retry-After": String(retry) },
    };
  }
  if (e instanceof BusyError) {
    return { status: 503, body: { error: "busy", message: "The archive is busy. Retry in a few seconds." }, headers: { "Retry-After": "5" } };
  }
  if (e instanceof ProviderError) {
    return {
      status: 502,
      body: { error: "provider_error", code: e.code, provider: e.provider, message: PROVIDER_MESSAGES[e.code] },
      headers: {},
    };
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
