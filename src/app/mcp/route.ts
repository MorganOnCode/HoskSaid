import { NextRequest } from "next/server";
import manifest from "@/lib/contracts/mcp.json";
import { askArchive } from "@/lib/retrieval";
import {
  searchSegments, keywordSearchApi, MAX_KEYWORD_QUERY, getVideoApi, getTranscriptApi, getSegmentApi, listVideosApi, listTopicsApi,
} from "@/lib/api";
import { clientIdentity, rateLimited } from "@/lib/ratelimit";
import { readJsonBody } from "@/lib/body";
import {
  DEFAULT_SEARCH_LIMIT, MAX_FILTER_VIDEO_IDS, MAX_MCP_BATCH, MAX_MCP_BODY_BYTES, MAX_SEARCH_LIMIT, clampInt, isYoutubeId,
  validateFilters, validateQuery,
} from "@/lib/limits";
import { describeError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROTOCOL_VERSION = "2025-06-18";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

/** A tool's argument problem, reported to the client as an isError tool result. */
class ToolInputError extends Error {}

function requireQuery(a: Args): string {
  const q = validateQuery(a.query);
  if (!q.ok) throw new ToolInputError(q.detail ?? q.error);
  return q.value;
}

function optionalVideoIds(a: Args): string[] | undefined {
  if (a.video_ids === undefined) return undefined;
  if (!Array.isArray(a.video_ids) || a.video_ids.length > MAX_FILTER_VIDEO_IDS || !a.video_ids.every(isYoutubeId)) {
    throw new ToolInputError(`video_ids must be an array of up to ${MAX_FILTER_VIDEO_IDS} video ids`);
  }
  return a.video_ids.length ? [...new Set(a.video_ids as string[])] : undefined;
}

function dateScope(a: Args) {
  const f = validateFilters({
    ...(a.date_from ? { date_from: a.date_from } : {}),
    ...(a.date_to ? { date_to: a.date_to } : {}),
  });
  if (!f.ok) throw new ToolInputError(f.detail ?? f.error);
  return f.value.scope;
}

function requireVideoId(a: Args): string {
  if (!isYoutubeId(a.video_id)) throw new ToolInputError("video_id must be a YouTube video id");
  return a.video_id;
}

/**
 * Tool implementations → plain JSON (wrapped as MCP text content by the caller).
 * `client` is the caller's limiter identity, charged for paid tools.
 */
const TOOLS: Record<string, (a: Args, client: string) => Promise<unknown>> = {
  search_archive: async (a, client) => {
    const query = requireQuery(a);
    const f = validateFilters(a.filters);
    if (!f.ok) throw new ToolInputError(f.detail ?? f.error);
    if (a.with_citations !== undefined && typeof a.with_citations !== "boolean") {
      throw new ToolInputError("with_citations must be a boolean");
    }
    const result = await askArchive(query, f.value.scope, f.value.filters, {
      client,
      withCitations: a.with_citations ?? true,
      persist: true,
    });
    if ("cached" in result) {
      const { cached: _cached, ...rest } = result;
      return rest;
    }
    return result;
  },
  // Retrieval only: one site-funded query embedding (per-client and site
  // embedding allowances apply), never an answer-model call.
  search_segments: async (a, client) => {
    const query = requireQuery(a);
    const videoId = a.video_id === undefined ? undefined : requireVideoId(a);
    const scope = dateScope(a);
    return searchSegments(query, {
      client,
      limit: clampInt(a.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT),
      videoId,
      from: scope.from,
      to: scope.to,
    });
  },
  // Keyword retrieval: no model call and no embedding at all.
  search_keyword: async (a) => {
    if (typeof a.query !== "string" || !a.query.trim()) throw new ToolInputError("query is required");
    if (a.query.trim().length > MAX_KEYWORD_QUERY) throw new ToolInputError(`query must be at most ${MAX_KEYWORD_QUERY} characters`);
    const videoIds = optionalVideoIds(a);
    const scope = dateScope(a);
    return keywordSearchApi(a.query, {
      youtubeIds: videoIds ?? null,
      from: scope.from,
      to: scope.to,
      limit: a.limit,
      offset: a.offset,
    });
  },
  get_video: async (a) => (await getVideoApi(requireVideoId(a))) ?? { error: "not_found" },
  get_transcript: async (a) => {
    const format = a.format ?? "segments";
    if (!["segments", "text", "vtt"].includes(format)) throw new ToolInputError("format must be segments, text or vtt");
    return (await getTranscriptApi(requireVideoId(a), format)) ?? { error: "not_found" };
  },
  get_segment: async (a) => (await getSegmentApi(String(a.segment_id || ""))) ?? { error: "not_found" },
  list_videos: (a) =>
    listVideosApi({
      type: typeof a.type === "string" ? a.type.slice(0, 40) : undefined,
      topic: typeof a.topic === "string" ? a.topic.slice(0, 60) : undefined,
      sort: typeof a.sort === "string" ? a.sort : undefined,
      cursor: typeof a.cursor === "string" ? a.cursor.slice(0, 32) : undefined,
      limit: a.limit,
    }),
  list_topics: () => listTopicsApi(),
};

interface RpcReq { jsonrpc?: string; id?: string | number | null; method?: string; params?: Args }

function isRpcObject(m: unknown): m is RpcReq {
  return !!m && typeof m === "object" && !Array.isArray(m);
}

async function dispatch(msg: unknown, client: string): Promise<object | null> {
  if (!isRpcObject(msg)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  const id = msg.id ?? null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const toolError = (text: string) => reply({ content: [{ type: "text", text }], isError: true });

  // Notifications (no id) get no response.
  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: manifest.name || "thehosksaid", version: manifest.version || "0.1.0" },
      });
    case "notifications/initialized":
    case "initialized":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: manifest.tools });
    case "tools/call": {
      const name = msg.params?.name;
      const impl = typeof name === "string" && Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
      if (!impl) return toolError(`Unknown tool: ${String(name).slice(0, 60)}`);
      const args = msg.params?.arguments;
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
        return toolError("arguments must be an object");
      }
      try {
        const data = await impl((args || {}) as Args, client);
        return reply({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false });
      } catch (e) {
        if (e instanceof ToolInputError) return toolError(`Invalid arguments: ${e.message}`);
        const d = describeError(e);
        if (d.status === 500) {
          console.error(`[mcp tools/call ${name}]`, e instanceof Error ? `${e.name}: ${e.message}` : "unknown error");
          return toolError("Tool execution failed.");
        }
        return toolError(JSON.stringify(d.body));
      }
    }
    default:
      if (isNotification) return null;
      return fail(-32601, `Method not found: ${String(msg.method).slice(0, 60)}`);
  }
}

/**
 * MCP Streamable HTTP endpoint (JSON request/response mode).
 * Bounds: body <= 64 KiB, at most 8 JSON-RPC messages per POST, each message
 * charged to the caller's rate limit, and messages handled one at a time so a
 * batch never fans out into parallel paid calls. Paid tools are additionally
 * bound by the caller's per-client daily allowance, the site's daily caps and
 * the concurrency gate.
 */
export async function POST(request: NextRequest) {
  const parsed = await readJsonBody(request, MAX_MCP_BODY_BYTES);
  if (!parsed.ok) {
    const code = parsed.error === "invalid_body" ? -32700 : -32600;
    const message = parsed.error === "invalid_body" ? "Parse error" : parsed.error === "body_too_large" ? "Request too large" : "Unsupported media type";
    return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status: parsed.status });
  }
  const body = parsed.value;
  const batch = Array.isArray(body);
  const messages: unknown[] = batch ? body : [body];

  if (messages.length === 0 || messages.length > MAX_MCP_BATCH) {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: `Invalid Request: a batch must contain 1-${MAX_MCP_BATCH} messages` } },
      { status: 400 }
    );
  }

  const limited = rateLimited(request, messages.length);
  if (limited) return limited;

  const client = clientIdentity(request);
  const responses: object[] = [];
  for (const m of messages) {
    const r = await dispatch(m, client);
    if (r) responses.push(r);
  }

  if (responses.length === 0) {
    // Only notifications — acknowledge with 202, no body.
    return new Response(null, { status: 202 });
  }
  return Response.json(batch ? responses : responses[0], {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** This server does not offer the optional server→client GET SSE stream. */
export async function GET() {
  return new Response("Method Not Allowed — POST JSON-RPC to this endpoint.", {
    status: 405,
    headers: { Allow: "POST", "Content-Type": "text/plain" },
  });
}
