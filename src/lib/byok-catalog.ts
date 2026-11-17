/**
 * Visitor-key ("bring your own key") catalogue and conversation bounds.
 * Client-safe: no server imports, so the UI and the API share one contract.
 *
 * The visitor chooses a provider from this fixed list and names a model
 * explicitly. Each provider has exactly one fixed official API host; nothing a
 * request carries can change where the server connects.
 */
export type ByokProviderId = "openai" | "anthropic" | "openrouter";

export interface ByokModelOption {
  id: string;
  label: string;
}

export interface ByokProviderInfo {
  id: ByokProviderId;
  label: string;
  /** The only host the server contacts for this provider (shown to visitors). */
  host: string;
  /** Suggestions only; any id matching MODEL_ID_RE may be chosen explicitly. */
  models: ByokModelOption[];
  keyHint: string;
  keysUrl: string;
}

export const BYOK_PROVIDERS: Record<ByokProviderId, ByokProviderInfo> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    host: "api.openai.com",
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
      { id: "gpt-6-luna", label: "GPT-6 Luna (smallest)" },
      { id: "gpt-6-astra", label: "GPT-6 Astra (largest)" },
    ],
    keyHint: "sk-…",
    keysUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    host: "api.anthropic.com",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (smallest)" },
    ],
    keyHint: "sk-ant-…",
    keysUrl: "https://console.anthropic.com/settings/keys",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    host: "openrouter.ai",
    models: [
      { id: "~anthropic/claude-opus-latest", label: "Claude Opus (latest, via OpenRouter)" },
      { id: "openai/gpt-4o", label: "GPT-4o (via OpenRouter)" },
    ],
    keyHint: "sk-or-…",
    keysUrl: "https://openrouter.ai/settings/keys",
  },
};

export const BYOK_PROVIDER_IDS = Object.keys(BYOK_PROVIDERS) as ByokProviderId[];

export function isByokProvider(v: unknown): v is ByokProviderId {
  return typeof v === "string" && Object.hasOwn(BYOK_PROVIDERS, v);
}

/** Model ids: letters, digits and . _ : / ~ - only (no spaces, no URLs, no schemes). */
export const MODEL_ID_RE = /^[A-Za-z0-9~][A-Za-z0-9._:/~-]{0,99}$/;

export function isValidModelId(v: unknown): v is string {
  return typeof v === "string" && MODEL_ID_RE.test(v) && !v.includes("//") && !v.includes("..");
}

/** Provider keys: printable ASCII, no whitespace, bounded length. */
export const PROVIDER_KEY_RE = /^[\x21-\x7e]{8,512}$/;

/** The request header that carries the visitor's key (never a body field or URL parameter). */
export const PROVIDER_KEY_HEADER = "x-provider-key";

// ---------------------------------------------------------------------------
// Conversation bounds
// ---------------------------------------------------------------------------

/** Earlier turns sent with a follow-up. Older turns stay on screen but are excluded. */
export const MAX_HISTORY_TURNS = 4;
/** Each earlier answer is sent as at most this many characters. */
export const MAX_HISTORY_ANSWER_CHARS = 2000;
/** Earlier cited segment ids re-fetched (and re-checked against scope) per follow-up. */
export const MAX_CARRIED_SEGMENTS = 6;
/** Segment ids sent per earlier turn. */
export const MAX_SEGMENT_IDS_PER_TURN = 12;
/** Turns kept on screen in one conversation before the visitor must start a new one. */
export const MAX_THREAD_TURNS = 12;
/** Body bound for POST /api/converse. */
export const MAX_CONVERSE_BODY_BYTES = 48 * 1024;

export interface HistoryTurn {
  question: string;
  answer: string;
  /** Segment ids cited by that answer: pointers only, re-fetched by the server. */
  segment_ids?: string[];
}

/** Who generated an answer. */
export interface GeneratedBy {
  engine: "site" | "visitor_key";
  provider: string;
  model: string;
}

// ---------------------------------------------------------------------------
// Provider failures (fixed text; provider messages are never passed through)
// ---------------------------------------------------------------------------

export type ProviderErrorCode =
  | "invalid_key"
  | "insufficient_quota"
  | "rate_limited"
  | "model_not_found"
  | "rejected"
  | "refused"
  | "output_limit"
  | "timeout"
  | "unavailable"
  | "bad_response";

/** Fixed visitor-facing messages (no provider text is ever passed through). */
export const PROVIDER_MESSAGES: Record<ProviderErrorCode, string> = {
  invalid_key: "The provider rejected this API key. Check the key, or create a new one.",
  insufficient_quota: "The provider reports that this key has no remaining credit or quota.",
  rate_limited: "The provider is rate-limiting this key. Wait a moment, then retry.",
  model_not_found: "The provider does not offer that model to this key. Choose another model.",
  rejected: "The provider rejected the request. Check that this key's account can use the chosen model.",
  refused: "The chosen model declined to answer this question. No other model was tried.",
  output_limit: "The model used up its output allowance before writing an answer. Try a shorter question or another model.",
  timeout: "The provider took too long to answer.",
  unavailable: "The provider could not be reached or returned an error. Retry later.",
  bad_response: "The provider returned a response this site could not read.",
};

