import { NextRequest } from "next/server";
import manifest from "@/lib/contracts/mcp.json";
import { askArchive } from "@/lib/retrieval";
import {
  searchSegments, getVideoApi, getTranscriptApi, getSegmentApi, listVideosApi, listTopicsApi,
} from "@/lib/api";
import { rateLimited } from "@/lib/ratelimit";
import type { AskFilters } from "@/lib/ask-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROTOCOL_VERSION = "2025-06-18";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

/** Tool implementations → plain JSON (wrapped as MCP text content by the caller). */
const TOOLS: Record<string, (a: Args) => Promise<unknown>> = {
  search_archive: (a) =>
    askArchive(String(a.query || ""), a.filters as AskFilters | undefined, {
      withCitations: a.with_citations ?? true,
      persist: true,
    }),
  search_segments: (a) =>
    searchSegments(String(a.query || ""), {
      limit: a.limit, videoId: a.video_id, dateFrom: a.date_from, dateTo: a.date_to,
    }),
  get_video: async (a) => (await getVideoApi(String(a.video_id || ""))) ?? { error: "not_found" },
  get_transcript: async (a) =>
    (await getTranscriptApi(String(a.video_id || ""), (a.format as "segments" | "text" | "vtt") || "segments")) ?? { error: "not_found" },
  get_segment: async (a) => (await getSegmentApi(String(a.segment_id || ""))) ?? { error: "not_found" },
  list_videos: (a) =>
    listVideosApi({ type: a.type, topic: a.topic, sort: a.sort, cursor: a.cursor, limit: a.limit }),
  list_topics: () => listTopicsApi(),
};

interface RpcReq { jsonrpc?: string; id?: string | number | null; method?: string; params?: Args }

async function dispatch(msg: RpcReq): Promise<object | null> {
  const id = msg.id ?? null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

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
      const name = msg.params?.name as string;
      const impl = TOOLS[name];
      if (!impl) return reply({ content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
      try {
        const data = await impl((msg.params?.arguments || {}) as Args);
        return reply({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false });
      } catch (e) {
        console.error(`[mcp tools/call ${name}]`, e);
        return reply({ content: [{ type: "text", text: "Tool execution failed." }], isError: true });
      }
    }
    default:
      if (isNotification) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** MCP Streamable HTTP endpoint (JSON request/response mode). */
export async function POST(request: NextRequest) {
  const limited = rateLimited(request);
  if (limited) return limited;

  let body: RpcReq | RpcReq[];
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }

  const batch = Array.isArray(body);
  const messages: RpcReq[] = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(messages.map(dispatch))).filter(Boolean);

  if (responses.length === 0) {
    // Only notifications — acknowledge with 202, no body.
    return new Response(null, { status: 202 });
  }
  return Response.json(batch ? responses : responses[0], {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** This server does not offer the optional server→client GET SSE stream. */
export async function GET() {
  return new Response("Method Not Allowed — POST JSON-RPC to this endpoint.", {
    status: 405,
    headers: { Allow: "POST", "Content-Type": "text/plain" },
  });
}
