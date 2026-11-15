/**
 * Ask pipeline (server-only): scoped retrieval -> grounded synthesis -> handoff contract.
 * Shared by /api/ask, /api/ask/context, /api/search and the MCP tools.
 *
 * Every site-funded call (query embedding, site-model answer) goes through
 * usage.withSiteCall, which applies the process concurrency gate and the daily
 * cap. Visitor-key answers use the visitor's provider and are never cached or
 * persisted; their retrieval embedding is still site-funded and capped.
 */
import { createHash } from "node:crypto";
import { sql, matchChunksScoped, type ScopedChunk } from "./db";
import { getClient } from "./llm";
import { isoDate } from "./format";
import { decodeEntities } from "./text";
import { withSiteCall } from "./usage";
import { cacheGet, cacheSet } from "./ratelimit";
import {
  ANSWER_MAX_TOKENS, CONTEXT_SEGMENTS, assembleAnswer, buildMessages, parseModelOutput, type ChatMessage,
} from "./ask-core";
import type { Scope } from "./limits";
import type { AskContextItem, AskEmpty, AskFilters, AskGeneratedBy, AskResponse } from "./ask-types";

// Cast a wide net for retrieval, then enforce a stricter quality gate so we never
// synthesize from weak matches (no hallucinated answers — HANDOFF acceptance).
export const RETRIEVE_THRESHOLD = 0.3;
export const QUALITY_THRESHOLD = 0.4;
export const RETRIEVE_COUNT = 30;
export const SITE_MODEL = "gpt-4o-mini";
const SITE_CALL_TIMEOUT_MS = 45_000;
const ANSWER_CACHE_TTL_S = 300;

export const BROADEN_SUGGESTIONS = [
  "Where does Charles stand on Cardano governance and Voltaire?",
  "What has Charles said about Midnight and the Glacier Drop?",
  "What are the latest Hydra throughput numbers Charles has cited?",
];

// ---------------------------------------------------------------------------
// Query embeddings (site-funded, cached in memory so repeats cost nothing)
// ---------------------------------------------------------------------------

const EMBED_CACHE_MAX = 500;
const EMBED_CACHE_TTL_MS = 6 * 60 * 60_000;
const embedCache = new Map<string, { v: number[]; exp: number }>();

function normaliseQuery(q: string): string {
  return q.replace(/\s+/g, " ").trim();
}

export async function embedQuery(query: string): Promise<number[]> {
  const text = normaliseQuery(query);
  if (!text) return [];
  const key = createHash("sha256").update(text).digest("hex");
  const hit = embedCache.get(key);
  if (hit && hit.exp > Date.now()) {
    embedCache.delete(key); // refresh LRU position
    embedCache.set(key, hit);
    return hit.v;
  }
  const v = await withSiteCall("embedding", async () => {
    const res = await getClient().embeddings.create(
      { model: "text-embedding-3-small", input: text, dimensions: 1536 },
      { timeout: SITE_CALL_TIMEOUT_MS, maxRetries: 0 }
    );
    return res.data[0]?.embedding ?? [];
  });
  if (v.length) {
    if (embedCache.size >= EMBED_CACHE_MAX) embedCache.delete(embedCache.keys().next().value!);
    embedCache.set(key, { v, exp: Date.now() + EMBED_CACHE_TTL_MS });
  }
  return v;
}

/** Test hook: forget cached query embeddings. */
export function clearEmbeddingCache(): void {
  embedCache.clear();
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

function toContextItem(c: ScopedChunk, n: number): AskContextItem {
  return {
    n,
    segment_id: c.id,
    video_id: c.youtube_id,
    title: decodeEntities(c.title),
    date: isoDate(c.published_at),
    start_seconds: c.start_time,
    similarity: Math.round((c.similarity ?? 0) * 100),
    text: decodeEntities(c.content),
  };
}

/** Ranked in-scope chunks for a query (exact search, scope applied before LIMIT). */
export async function retrieveChunks(query: string, scope: Scope, count = RETRIEVE_COUNT): Promise<ScopedChunk[]> {
  const embedding = await embedQuery(query);
  if (!embedding.length) return [];
  return await matchChunksScoped(embedding, RETRIEVE_THRESHOLD, count, scope);
}

/**
 * Grounding context for a question: the top CONTEXT_SEGMENTS in-scope chunks,
 * or null when nothing clears the quality threshold.
 */
export async function retrieveContext(query: string, scope: Scope): Promise<AskContextItem[] | null> {
  const chunks = await retrieveChunks(query, scope);
  const best = chunks[0]?.similarity ?? 0;
  if (!chunks.length || best < QUALITY_THRESHOLD) return null;
  return chunks.slice(0, CONTEXT_SEGMENTS).map((c, i) => toContextItem(c, i + 1));
}

// ---------------------------------------------------------------------------
// Synthesis engines
// ---------------------------------------------------------------------------

export interface Synthesizer {
  generatedBy: AskGeneratedBy;
  /** Site-funded engines are budgeted, cached and (optionally) persisted. */
  siteFunded: boolean;
  complete(messages: ChatMessage[]): Promise<string>;
}

export function siteSynthesizer(): Synthesizer {
  return {
    generatedBy: { engine: "site", provider: "openai", model: SITE_MODEL },
    siteFunded: true,
    complete: (messages) =>
      withSiteCall("answer", async () => {
        const completion = await getClient().chat.completions.create(
          {
            model: SITE_MODEL,
            max_tokens: ANSWER_MAX_TOKENS,
            temperature: 0.4,
            response_format: { type: "json_object" },
            messages,
          },
          { timeout: SITE_CALL_TIMEOUT_MS, maxRetries: 0 }
        );
        return completion.choices[0]?.message?.content ?? "";
      }),
  };
}

function persistEnabled(): boolean {
  return process.env.PERSIST_ASK_QUESTIONS !== "false";
}

/**
 * Full Ask pipeline. Returns the handoff contract on success, or AskEmpty when
 * nothing clears the quality threshold (callers map that to HTTP 422).
 * `query` and `scope` must already be validated (see limits.ts).
 */
export async function askArchive(
  query: string,
  scope: Scope,
  filters: AskFilters | undefined,
  opts: { withCitations?: boolean; persist?: boolean; requestId?: string; synthesizer?: Synthesizer } = {}
): Promise<(AskResponse & { cached?: boolean }) | AskEmpty> {
  const withCitations = opts.withCitations ?? true;
  const synth = opts.synthesizer ?? siteSynthesizer();

  const cacheKey = synth.siteFunded
    ? `ask:v2:${normaliseQuery(query).toLowerCase()}:${JSON.stringify(filters ?? {})}:${withCitations}`
    : null;
  if (cacheKey) {
    const cached = cacheGet<AskResponse>(cacheKey);
    if (cached) return { ...cached, cached: true };
  }

  const context = await retrieveContext(query, scope);
  if (!context) return { matched: 0, suggestions: BROADEN_SUGGESTIONS };

  const raw = await synth.complete(buildMessages(query, context));
  const result = assembleAnswer(query, context, parseModelOutput(raw), {
    withCitations,
    generatedBy: synth.generatedBy,
  });
  if (!result) return { matched: 0, suggestions: BROADEN_SUGGESTIONS };

  if (cacheKey) cacheSet(cacheKey, result, ANSWER_CACHE_TTL_S);

  if (opts.persist && synth.siteFunded && persistEnabled()) {
    try {
      await sql`
        INSERT INTO answers (question, answer, lede, citations, sources, scope, request_id)
        VALUES (
          ${query}, ${result.answer}, ${result.lede || null},
          ${sql.json(result.citations as unknown as Parameters<typeof sql.json>[0])},
          ${sql.json(result.sources as unknown as Parameters<typeof sql.json>[0])},
          ${filters ? sql.json(filters as unknown as Parameters<typeof sql.json>[0]) : null},
          ${opts.requestId ?? null}
        )
      `;
    } catch (e) {
      console.error("Failed to persist answer:", e instanceof Error ? e.message : "unknown error");
    }
  }

  return result;
}
