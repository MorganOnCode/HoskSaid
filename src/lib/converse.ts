/**
 * Visitor-key conversation pipeline (server-only), behind POST /api/converse.
 *
 *  1. Retrieval runs on this site: one site-funded query embedding, charged to
 *     the caller's and the site's embedding allowances exactly like any other
 *     semantic search. A visitor key never funds or bypasses that allowance.
 *  2. Segment ids cited in earlier turns are re-fetched from the database and
 *     re-checked against the conversation's scope; ids that do not resolve
 *     inside the scope are dropped. Earlier answers are passed to the model as
 *     context only and are never treated as evidence.
 *  3. The visitor's provider writes the answer (one attempt, their key).
 *     Nothing is reserved from, or blocked by, the site-funded answer budget.
 *  4. Nothing is cached or stored: no answer cache entry, no saved answer, no
 *     cached query embedding.
 */
import { MAX_QUERY_CHARS, type Scope } from "./limits";
import { getSegmentsInScope } from "./db";
import { BROADEN_SUGGESTIONS, QUALITY_THRESHOLD, RETRIEVE_COUNT, retrieveChunks, toContextItem } from "./retrieval";
import { CONTEXT_SEGMENTS, assembleAnswer, buildConverseMessages, parseModelOutput } from "./ask-core";
import { MAX_CARRIED_SEGMENTS, type ByokProviderId, type GeneratedBy, type HistoryTurn } from "./byok-catalog";
import { ProviderError, callVisitorProvider, withByokSlot } from "./byok-providers";
import type { AskEmpty, AskResponse } from "./ask-types";

export interface ConverseResponse extends AskResponse {
  generated_by: GeneratedBy;
  /** False when the model cited none of the supplied segments (no sources are attached then). */
  grounded: boolean;
  retrieval: {
    mode: "semantic";
    funded_by: "site";
    fresh_segments: number;
    carried_segments: number;
    carried_dropped: number;
  };
  conversation: { history_turns_used: number };
}

export interface ConverseEmpty extends AskEmpty {
  insufficient_evidence: true;
}

export interface ConverseInput {
  provider: ByokProviderId;
  model: string;
  key: string;
  query: string;
  scope: Scope;
  history: HistoryTurn[];
  client: string;
}

/** The text embedded for retrieval: the new question first, then the previous one for reference resolution. */
export function retrievalText(query: string, history: HistoryTurn[]): string {
  const prev = history.length ? history[history.length - 1].question : "";
  return (prev ? `${query}\n${prev}` : query).slice(0, MAX_QUERY_CHARS);
}

/** Cited segment ids from earlier turns, most recent first, deduplicated and bounded. */
export function carriedSegmentIds(history: HistoryTurn[]): string[] {
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < MAX_CARRIED_SEGMENTS; i--) {
    for (const id of history[i].segment_ids ?? []) {
      const k = id.toLowerCase();
      if (!out.includes(k)) out.push(k);
      if (out.length >= MAX_CARRIED_SEGMENTS) break;
    }
  }
  return out;
}

export async function converse(input: ConverseInput): Promise<ConverseResponse | ConverseEmpty> {
  // Take the visitor-call slot before paying for retrieval, so a saturated
  // gate refuses the request without spending a site-funded embedding.
  return withByokSlot(async () => {
    const carriedIds = carriedSegmentIds(input.history);
    const fresh = await retrieveChunks(retrievalText(input.query, input.history), input.scope, input.client, RETRIEVE_COUNT, {
      cacheWrite: false,
    });
    const freshOk = (fresh[0]?.similarity ?? 0) >= QUALITY_THRESHOLD;
    const carried = carriedIds.length ? await getSegmentsInScope(carriedIds, input.scope) : [];

    const seen = new Set(carried.map((c) => c.id));
    const freshUse = (freshOk ? fresh : [])
      .filter((c) => !seen.has(c.id) && seen.add(c.id))
      .slice(0, Math.max(0, CONTEXT_SEGMENTS - carried.length));
    const chunks = [...freshUse, ...carried].slice(0, CONTEXT_SEGMENTS);
    if (!chunks.length) return { matched: 0, suggestions: BROADEN_SUGGESTIONS, insufficient_evidence: true };

    const context = chunks.map((c, i) => toContextItem(c, i + 1));
    const messages = buildConverseMessages(
      input.query,
      context,
      input.history.map((t) => ({ question: t.question, answer: t.answer }))
    );
    const raw = await callVisitorProvider(input.provider, input.key, input.model, messages);
    const result = assembleAnswer(input.query, context, parseModelOutput(raw), { uncitedFallback: false });
    if (!result) throw new ProviderError(input.provider, "bad_response");

    return {
      ...result,
      generated_by: { engine: "visitor_key", provider: input.provider, model: input.model },
      grounded: result.sources.length > 0,
      retrieval: {
        mode: "semantic",
        funded_by: "site",
        fresh_segments: freshUse.length,
        carried_segments: chunks.length - freshUse.length,
        carried_dropped: carriedIds.length - carried.length,
      },
      conversation: { history_turns_used: input.history.length },
    };
  });
}
