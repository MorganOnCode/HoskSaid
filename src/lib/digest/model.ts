/**
 * Injectable text model and explicit limits for monthly draft generation.
 *
 * Production wires the site's OpenAI key, but only when an explicit per-month
 * call budget is configured: there is no default and no "unlimited". Tests pass
 * a fake model, so no automated test needs credentials or makes a paid call.
 * Provider errors are reduced to a status code; their messages (which can echo
 * part of a key) are never logged or returned.
 */
import OpenAI from "openai";

export interface DraftModel {
  provider: string;
  model: string;
  complete(input: { system: string; user: string; maxTokens: number }): Promise<string>;
}

/** Bounds on one generation run. Every one is enforced in code. */
export interface DraftLimits {
  /** Maximum model calls one run may plan; larger plans are refused before any call. */
  maxCallsPerRun: number;
  /** Characters of one video's material sent in its notes call. */
  videoInputChars: number;
  /** Characters of the stored summary included per video (within videoInputChars). */
  summaryChars: number;
  /** Characters per transcript excerpt. */
  excerptChars: number;
  /** Notes kept per video. */
  notesPerVideo: number;
  /** Maximum characters of one note. */
  noteChars: number;
  /** Characters of notes sent in one synthesis/reduce call. */
  synthesisInputChars: number;
  /** Reduce levels allowed before the final synthesis. */
  maxReduceLevels: number;
  /** Points kept from one reduce call. */
  reducePoints: number;
  outputTokens: { notes: number; reduce: number; final: number };
}

export const DEFAULT_LIMITS: DraftLimits = {
  maxCallsPerRun: 150,
  videoInputChars: 16_000,
  summaryChars: 2_000,
  excerptChars: 900,
  notesPerVideo: 4,
  noteChars: 450,
  synthesisInputChars: 60_000,
  maxReduceLevels: 2,
  reducePoints: 8,
  outputTokens: { notes: 700, reduce: 1_800, final: 3_000 },
};

export class ModelCallError extends Error {
  constructor(readonly detail: string) {
    super(`model call failed: ${detail}`);
    this.name = "ModelCallError";
  }
}

/** Reduce any provider failure to a short, secret-free description. */
export function describeModelError(e: unknown): string {
  if (e instanceof ModelCallError) return e.detail;
  const o = (e ?? {}) as { status?: unknown; name?: unknown; code?: unknown };
  if (typeof o.status === "number") return `HTTP ${o.status}`;
  if (o.name === "APIConnectionTimeoutError" || o.name === "AbortError") return "timeout";
  if (o.name === "APIConnectionError") return "connection error";
  return "provider error";
}

export interface ModelConfig {
  model: string;
  /** Model calls allowed per month across all runs (MONTHLY_DRAFT_CALL_BUDGET). */
  callBudget: number;
}

export type ModelConfigResult = { ok: true; config: ModelConfig } | { ok: false; missing: string[]; invalid: string[] };

const MAX_BUDGET = 1000;

/** Production model settings. Reports variable names only, never values. */
export function monthlyModelConfig(env: Record<string, string | undefined> = process.env): ModelConfigResult {
  const missing: string[] = [];
  const invalid: string[] = [];
  if (!env.OPENAI_API_KEY?.trim()) missing.push("OPENAI_API_KEY");
  const rawBudget = env.MONTHLY_DRAFT_CALL_BUDGET?.trim();
  let callBudget = 0;
  if (!rawBudget) missing.push("MONTHLY_DRAFT_CALL_BUDGET");
  else if (!/^\d+$/.test(rawBudget) || Number(rawBudget) < 1 || Number(rawBudget) > MAX_BUDGET) {
    invalid.push(`MONTHLY_DRAFT_CALL_BUDGET (integer 1-${MAX_BUDGET})`);
  } else callBudget = Number(rawBudget);
  const model = env.MONTHLY_DRAFT_MODEL?.trim() || "gpt-4o-mini";
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(model)) invalid.push("MONTHLY_DRAFT_MODEL");
  if (missing.length || invalid.length) return { ok: false, missing, invalid };
  return { ok: true, config: { model, callBudget } };
}

export function openAIDraftModel(model: string, apiKey = process.env.OPENAI_API_KEY ?? ""): DraftModel {
  // Explicit key, fixed host, no SDK retries: one attempt per budgeted call.
  const client = new OpenAI({ apiKey, baseURL: "https://api.openai.com/v1", maxRetries: 0, timeout: 120_000 });
  return {
    provider: "openai",
    model,
    async complete({ system, user, maxTokens }) {
      try {
        const res = await client.chat.completions.create({
          model,
          temperature: 0.2,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        });
        return res.choices[0]?.message?.content ?? "";
      } catch (e) {
        throw new ModelCallError(describeModelError(e));
      }
    },
  };
}
