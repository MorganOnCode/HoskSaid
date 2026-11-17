/**
 * Client-safe mapping from a failed /api/ask response to what the visitor is
 * told. Budget errors name the cap that ran out (the server sends `budget`), so
 * the advice never suggests a route around the shared retrieval budget.
 */
import { BYOK_PROVIDERS, PROVIDER_MESSAGES, isByokProvider, type ProviderErrorCode } from "./byok-catalog";

export interface AskFailure {
  /** Short machine label shown in the state card footer. */
  code: string;
  title: string;
  message: string;
  /** Whether retrying the same question soon can help. */
  retryable: boolean;
  /** Offer keyword matches (no model call, no embedding) in place of an answer. */
  keyword?: boolean;
}

const GENERIC: AskFailure = {
  code: "SYNTHESIS",
  title: "The index didn’t respond",
  message: "We couldn’t reach the search service to synthesize an answer. Your question is fine — this one’s on us. Give it another go in a moment.",
  retryable: true,
};

const PROVIDER_TITLES: Record<ProviderErrorCode, string> = {
  invalid_key: "Your API key was rejected",
  insufficient_quota: "Your provider account has no credit left",
  rate_limited: "Your provider is rate-limiting this key",
  model_not_found: "That model isn’t available to your key",
  rejected: "Your provider rejected the request",
  refused: "The model declined to answer",
  output_limit: "The model ran out of output allowance",
  timeout: "Your provider timed out",
  unavailable: "Your provider didn’t respond",
  bad_response: "Your provider’s reply couldn’t be read",
};

const RETRYABLE_PROVIDER: ProviderErrorCode[] = ["rate_limited", "timeout", "unavailable", "bad_response"];

/**
 * Failure copy for a visitor-key answer (POST /api/converse). Provider and
 * retrieval failures are kept apart: a provider problem is about the visitor's
 * key or model, a retrieval cap is this site's shared search allowance, which
 * the key cannot raise.
 */
export function describeConverseFailure(status: number | null, body: unknown): AskFailure {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const error = typeof b.error === "string" ? b.error : "";
  if (error === "provider_error" && typeof b.provider_error === "string" && Object.hasOwn(PROVIDER_MESSAGES, b.provider_error)) {
    const code = b.provider_error as ProviderErrorCode;
    const label = isByokProvider(b.provider) ? BYOK_PROVIDERS[b.provider].label : "your provider";
    return {
      code: `PROVIDER · ${code.toUpperCase()}`,
      title: PROVIDER_TITLES[code],
      message: `${label}: ${PROVIDER_MESSAGES[code]} This site did not answer with its own model instead.`,
      retryable: RETRYABLE_PROVIDER.includes(code),
    };
  }
  if ((error === "site_budget_exhausted" || error === "client_quota_exhausted") && b.budget === "embedding") {
    return {
      code: error === "client_quota_exhausted" ? "YOUR SEARCHES" : "SEARCH BUDGET",
      title: error === "client_quota_exhausted" ? "You’ve used today’s semantic searches" : "Today’s semantic searches are used up",
      message:
        "Finding transcript excerpts uses this site’s shared daily search allowance, and your API key pays only for the answer, so it can’t raise that allowance. It resets at 00:00 UTC. Keyword matches below need no allowance and no model.",
      retryable: false,
      keyword: true,
    };
  }
  if (error === "too_many_in_flight") {
    return { code: "IN FLIGHT", title: "One answer at a time", message: "Wait for your current answer to finish, then ask again.", retryable: true };
  }
  if (error === "provider_key_required" || error === "invalid_provider_key") {
    return { code: "KEY", title: "Check your API key", message: "Enter the API key for the provider you chose. It stays in this page’s memory only.", retryable: false };
  }
  if (error === "model_required" || error === "invalid_model" || error === "unsupported_provider" || error === "provider_required") {
    return { code: "SETUP", title: "Choose a provider and model", message: "Pick a supported provider and name a model explicitly.", retryable: false };
  }
  if (error === "history_too_long" || error === "invalid_history") {
    return { code: "CONVERSATION", title: "This conversation can’t continue", message: "Start a new conversation and ask again.", retryable: false };
  }
  if (error === "cross_origin_forbidden") {
    return { code: "ORIGIN", title: "Request blocked", message: "Visitor-key answers only work from this website itself. Reload the page and try again.", retryable: false };
  }
  return describeAskFailure(status, body);
}

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
  if (status === 429 && error === "client_quota_exhausted") {
    if (b.budget === "answer") {
      return {
        code: "YOUR ANSWERS",
        title: "You’ve used today’s answers",
        message: "Your own daily answer allowance is used up. Semantic segment search and Library keyword search still work. Your answers resume at 00:00 UTC.",
        retryable: false,
      };
    }
    return {
      code: "YOUR SEARCHES",
      title: "You’ve used today’s archive searches",
      message: "Your own daily search allowance is used up, and every answer needs a search, so neither can run for you until 00:00 UTC. Library keyword search still works.",
      retryable: false,
    };
  }
  if (status === 429) {
    return { code: "RATE LIMIT", title: "Too many questions at once", message: "You’ve hit the per-visitor rate limit. Wait a minute, then retry.", retryable: true };
  }
  if (status === 400 && error === "query_too_long") {
    return { code: "TOO LONG", title: "That question is too long", message: "Questions can be up to 1,000 characters. Shorten it and ask again.", retryable: false };
  }
  return GENERIC;
}
