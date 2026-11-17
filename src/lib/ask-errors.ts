/**
 * Client-safe mapping from a failed /api/ask response to what the visitor is
 * told. Budget errors name the cap that ran out (the server sends `budget`), so
 * the advice never suggests a route around the shared retrieval budget.
 */
export interface AskFailure {
  /** Short machine label shown in the state card footer. */
  code: string;
  title: string;
  message: string;
  /** Whether retrying the same question soon can help. */
  retryable: boolean;
}

const GENERIC: AskFailure = {
  code: "SYNTHESIS",
  title: "The index didn’t respond",
  message: "We couldn’t reach the search service to synthesize an answer. Your question is fine — this one’s on us. Give it another go in a moment.",
  retryable: true,
};

export function describeAskFailure(status: number | null, body: unknown): AskFailure {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const error = typeof b.error === "string" ? b.error : "";
  if (status === 503 && error === "site_budget_exhausted") {
    if (b.budget === "answer") {
      return {
        code: "ANSWER BUDGET",
        title: "Today’s answers are used up",
        message: "The site pays for a fixed number of answers per day and today’s are gone. Library keyword search still works. Answers resume at 00:00 UTC.",
        retryable: false,
      };
    }
    return {
      code: "SEARCH BUDGET",
      title: "Today’s archive searches are used up",
      message: "The site pays for a fixed number of transcript searches per day, and every answer needs one. None can run until 00:00 UTC. Library keyword search still works.",
      retryable: false,
    };
  }
  if (status === 503 && error === "busy") {
    return { code: "BUSY", title: "The archive is busy", message: "Several questions are being answered right now. Retry in a few seconds.", retryable: true };
  }
  if (status === 429) {
    return { code: "RATE LIMIT", title: "Too many questions at once", message: "You’ve hit the per-visitor rate limit. Wait a minute, then retry.", retryable: true };
  }
  if (status === 400 && error === "query_too_long") {
    return { code: "TOO LONG", title: "That question is too long", message: "Questions can be up to 1,000 characters. Shorten it and ask again.", retryable: false };
  }
  return GENERIC;
}
