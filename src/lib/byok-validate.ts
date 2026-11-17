/**
 * Input validation for POST /api/converse (client-safe, no server imports).
 * Every bound here is explicit: unknown providers, unnamed models, oversized
 * history or malformed ids are 400s, never silently corrected.
 */
import {
  MAX_HISTORY_ANSWER_CHARS, MAX_HISTORY_TURNS, MAX_SEGMENT_IDS_PER_TURN, PROVIDER_KEY_RE,
  isByokProvider, isValidModelId, type ByokProviderId, type HistoryTurn,
} from "./byok-catalog";
import { validateFilters, validateQuery, type Scope, type Validated } from "./limits";
import type { AskFilters } from "./ask-types";

const SEGMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConverseRequest {
  provider: ByokProviderId;
  model: string;
  query: string;
  filters: AskFilters | undefined;
  scope: Scope;
  history: HistoryTurn[];
}

export function validateConverseBody(raw: unknown): Validated<ConverseRequest> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_body" };
  const b = raw as Record<string, unknown>;

  if (b.provider === undefined) return { ok: false, error: "provider_required", detail: "choose a provider: openai, anthropic or openrouter" };
  if (!isByokProvider(b.provider)) {
    return { ok: false, error: "unsupported_provider", detail: "provider must be one of openai, anthropic, openrouter" };
  }
  if (b.model === undefined || b.model === "") return { ok: false, error: "model_required", detail: "choose a model explicitly" };
  if (!isValidModelId(b.model)) return { ok: false, error: "invalid_model", detail: "model must be a provider model id" };

  const q = validateQuery(b.query);
  if (!q.ok) return q;
  const f = validateFilters(b.filters);
  if (!f.ok) return f;

  const history: HistoryTurn[] = [];
  if (b.history !== undefined) {
    if (!Array.isArray(b.history)) return { ok: false, error: "invalid_history", detail: "history must be an array" };
    if (b.history.length > MAX_HISTORY_TURNS) {
      return { ok: false, error: "history_too_long", detail: `send at most ${MAX_HISTORY_TURNS} earlier turns` };
    }
    for (const t of b.history) {
      if (!t || typeof t !== "object" || Array.isArray(t)) return { ok: false, error: "invalid_history", detail: "each turn must be an object" };
      const turn = t as Record<string, unknown>;
      const tq = validateQuery(turn.question);
      if (!tq.ok) return { ok: false, error: "invalid_history", detail: "each turn needs a question of at most 1000 characters" };
      if (typeof turn.answer !== "string" || turn.answer.length > MAX_HISTORY_ANSWER_CHARS) {
        return { ok: false, error: "invalid_history", detail: `each earlier answer must be a string of at most ${MAX_HISTORY_ANSWER_CHARS} characters` };
      }
      let ids: string[] = [];
      if (turn.segment_ids !== undefined) {
        if (
          !Array.isArray(turn.segment_ids) ||
          turn.segment_ids.length > MAX_SEGMENT_IDS_PER_TURN ||
          !turn.segment_ids.every((s) => typeof s === "string" && SEGMENT_ID_RE.test(s))
        ) {
          return { ok: false, error: "invalid_history", detail: `segment_ids must be up to ${MAX_SEGMENT_IDS_PER_TURN} segment ids` };
        }
        ids = turn.segment_ids as string[];
      }
      history.push({ question: tq.value, answer: turn.answer, segment_ids: ids });
    }
  }

  return {
    ok: true,
    value: { provider: b.provider, model: b.model, query: q.value, filters: f.value.filters, scope: f.value.scope, history },
  };
}

export function validateProviderKey(raw: string | null): Validated<string> {
  if (!raw) return { ok: false, error: "provider_key_required", detail: "send your provider key in the x-provider-key header" };
  const k = raw.trim();
  if (!PROVIDER_KEY_RE.test(k)) return { ok: false, error: "invalid_provider_key", detail: "the key has an unexpected format" };
  return { ok: true, value: k };
}
