/**
 * Visitor-key provider calls (server-only).
 *
 * The visitor's key arrives in the x-provider-key header and is used for one
 * provider call, then dropped. This module:
 *  - calls only the provider's fixed official endpoint through its official SDK,
 *    and a guarded transport refuses any other URL, method or redirect;
 *  - passes the key explicitly and rebuilds the outgoing headers from an
 *    allow-list, so no site credential, organisation/project id, workspace id
 *    or custom header from this server's environment can reach the provider;
 *  - disables SDK logging, telemetry and retries (exactly one attempt);
 *  - maps every failure to a fixed ProviderError code. Provider error bodies,
 *    the key and request bodies are never logged or echoed.
 * There is no fallback: a failed or refused visitor call never retries on
 * another model, another provider or the site's own key.
 */
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { BYOK_PROVIDERS, PROVIDER_MESSAGES, type ByokProviderId, type ProviderErrorCode } from "./byok-catalog";

export { PROVIDER_MESSAGES };
import type { ChatMessage } from "./ask-core";
import { Semaphore } from "./usage";

/** The only URL the server ever requests for each provider. */
export const FIXED_ENDPOINTS: Record<ByokProviderId, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

const BASE_URLS: Record<ByokProviderId, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  openrouter: "https://openrouter.ai/api/v1",
};

/** Output bound for one visitor-funded answer (thinking models count reasoning here too). */
export const BYOK_MAX_OUTPUT_TOKENS = 6000;
const DEFAULT_TIMEOUT_MS = 90_000;

/** A visitor-selected provider failed. Never retried, never replaced by the site model. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: ByokProviderId;
  constructor(provider: ByokProviderId, code: ProviderErrorCode) {
    super(`provider ${provider} failed: ${code}`);
    this.name = "ProviderError";
    this.code = code;
    this.provider = provider;
  }
}

function timeoutMs(): number {
  const raw = process.env.BYOK_PROVIDER_TIMEOUT_MS;
  if (raw && /^\d+$/.test(raw)) return Math.min(180_000, Math.max(50, parseInt(raw, 10)));
  return DEFAULT_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Guarded transport
// ---------------------------------------------------------------------------

type Transport = (url: string, init: RequestInit) => Promise<Response>;
let testTransport: Transport | undefined;

/** Test hook: replace the network under the guard (the guard still runs). */
export function setProviderTransportForTests(t: Transport | undefined): void {
  testTransport = t;
}

class BlockedDestinationError extends Error {
  constructor() {
    super("blocked provider destination");
    this.name = "BlockedDestinationError";
  }
}

/** Headers the provider may receive, rebuilt from scratch for every request. */
function outgoingHeaders(provider: ByokProviderId, key: string, from: Headers): Headers {
  const h = new Headers();
  h.set("content-type", "application/json");
  h.set("accept", "application/json");
  const ua = from.get("user-agent");
  if (ua && /^[\x20-\x7e]{1,200}$/.test(ua)) h.set("user-agent", ua);
  if (provider === "anthropic") {
    h.set("x-api-key", key);
    const version = from.get("anthropic-version");
    if (version && /^\d{4}-\d{2}-\d{2}$/.test(version)) h.set("anthropic-version", version);
  } else {
    h.set("authorization", `Bearer ${key}`);
  }
  if (provider === "openrouter") {
    h.set("http-referer", process.env.PUBLIC_BASE_URL || "https://thehosksaid.com");
    h.set("x-openrouter-title", "thehosksaid");
  }
  return h;
}

function guardedFetch(provider: ByokProviderId, key: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url !== FIXED_ENDPOINTS[provider] || method !== "POST") throw new BlockedDestinationError();
    const headers = outgoingHeaders(provider, key, new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
    const out: RequestInit = {
      method: "POST",
      headers,
      body: init?.body,
      signal: init?.signal,
      redirect: "error",
      cache: "no-store",
    };
    const transport: Transport = testTransport ?? ((u, i) => globalThis.fetch(u, i));
    return transport(url, out);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

function splitMessages(messages: ChatMessage[]): { system: string; user: string } {
  return {
    system: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"),
    user: messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n"),
  };
}

async function callOpenAICompatible(provider: "openai" | "openrouter", key: string, model: string, messages: ChatMessage[]): Promise<string> {
  const client = new OpenAI({
    apiKey: key,
    baseURL: BASE_URLS[provider],
    organization: null,
    project: null,
    webhookSecret: null,
    maxRetries: 0,
    timeout: timeoutMs(),
    logLevel: "off",
    fetch: guardedFetch(provider, key),
  });
  const res = await client.chat.completions.create({
    model,
    messages,
    ...(provider === "openai" ? { max_completion_tokens: BYOK_MAX_OUTPUT_TOKENS } : { max_tokens: BYOK_MAX_OUTPUT_TOKENS }),
  });
  const choice = res.choices?.[0];
  const msg = choice?.message as { content?: unknown; refusal?: unknown } | undefined;
  if (typeof msg?.refusal === "string" && msg.refusal.trim()) throw new ProviderError(provider, "refused");
  if (choice?.finish_reason === "content_filter") throw new ProviderError(provider, "refused");
  const text = typeof msg?.content === "string" ? msg.content.trim() : "";
  if (!text) throw new ProviderError(provider, choice?.finish_reason === "length" ? "output_limit" : "bad_response");
  return text;
}

async function callAnthropic(key: string, model: string, messages: ChatMessage[]): Promise<string> {
  const client = new Anthropic({
    apiKey: key,
    baseURL: BASE_URLS.anthropic,
    maxRetries: 0,
    timeout: timeoutMs(),
    logLevel: "off",
    openTelemetry: false,
    fetch: guardedFetch("anthropic", key),
  });
  const { system, user } = splitMessages(messages);
  // The visitor chose this exact model; no server-side refusal fallback is
  // requested, so a refusal is reported rather than answered by another model.
  const res = await client.messages.create({
    model,
    max_tokens: BYOK_MAX_OUTPUT_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
  });
  if (res.stop_reason === "refusal") throw new ProviderError("anthropic", "refused");
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new ProviderError("anthropic", res.stop_reason === "max_tokens" ? "output_limit" : "bad_response");
  return text;
}

function mapError(provider: ByokProviderId, e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError || e instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderError(provider, "timeout");
  }
  if (e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError) {
    return new ProviderError(provider, "unavailable");
  }
  const err = e as { status?: unknown; code?: unknown; type?: unknown; error?: { type?: unknown; code?: unknown; error?: { type?: unknown } } };
  const status = typeof err?.status === "number" ? err.status : undefined;
  const code = String(err?.code ?? err?.error?.code ?? err?.error?.type ?? err?.error?.error?.type ?? "");
  if (status === 401 || status === 403) return new ProviderError(provider, "invalid_key");
  if (status === 402 || code === "insufficient_quota") return new ProviderError(provider, "insufficient_quota");
  if (status === 429) return new ProviderError(provider, "rate_limited");
  if (status === 404) return new ProviderError(provider, "model_not_found");
  if (status === 400 || status === 413 || status === 422) return new ProviderError(provider, "rejected");
  if (status === 408 || status === 504) return new ProviderError(provider, "timeout");
  if (status !== undefined && status >= 500) return new ProviderError(provider, "unavailable");
  return new ProviderError(provider, "bad_response");
}

// ---------------------------------------------------------------------------
// Concurrency bounds (separate from the site-funded gate)
// ---------------------------------------------------------------------------

function envInt(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw)) return def;
  return Math.min(max, Math.max(min, parseInt(raw, 10)));
}

declare global {
  var __hosksaidByokGate: Semaphore | undefined;
  var __hosksaidByokInFlight: Map<string, number> | undefined;
}

/** Process-wide gate for visitor-key provider calls. */
export function byokGate(): Semaphore {
  if (!globalThis.__hosksaidByokGate) {
    globalThis.__hosksaidByokGate = new Semaphore(envInt("BYOK_MAX_CONCURRENT_CALLS", 4, 1, 64), 16, 15_000);
  }
  return globalThis.__hosksaidByokGate;
}

/** Test hook: rebuild the gate from the current environment. */
export function resetByokGatesForTests(): void {
  globalThis.__hosksaidByokGate = undefined;
  globalThis.__hosksaidByokInFlight = undefined;
}

/** Visitor-key requests one client identity may have open at once. */
export function perClientInFlightLimit(): number {
  return envInt("BYOK_MAX_IN_FLIGHT_PER_CLIENT", 2, 1, 16);
}

/**
 * Claim one in-flight slot for a limiter identity (never the provider key).
 * Returns a release function, or null when the client is at its limit.
 */
export function claimClientSlot(client: string): (() => void) | null {
  const map = (globalThis.__hosksaidByokInFlight ??= new Map());
  const n = map.get(client) ?? 0;
  if (n >= perClientInFlightLimit()) return null;
  map.set(client, n + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (map.get(client) ?? 1) - 1;
    if (left <= 0) map.delete(client);
    else map.set(client, left);
  };
}

/** Run `fn` holding one slot of the process-wide visitor-key gate (BusyError when saturated). */
export async function withByokSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await byokGate().acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * One visitor-key completion: exactly one attempt. Throws ProviderError only,
 * never a raw SDK error (which could carry provider text). Callers hold a
 * withByokSlot slot.
 */
export async function callVisitorProvider(provider: ByokProviderId, key: string, model: string, messages: ChatMessage[]): Promise<string> {
  if (!Object.hasOwn(BYOK_PROVIDERS, provider)) throw new ProviderError(provider, "rejected");
  try {
    return provider === "anthropic" ? await callAnthropic(key, model, messages) : await callOpenAICompatible(provider, key, model, messages);
  } catch (e) {
    const mapped = mapError(provider, e);
    // Provider and code only: never the key, the provider's message or the body.
    console.warn(`[byok] ${provider} call failed: ${mapped.code}`);
    throw mapped;
  }
}
