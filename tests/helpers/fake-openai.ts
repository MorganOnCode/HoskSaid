/**
 * A loopback HTTP server that speaks the small subset of the OpenAI API this
 * app uses (embeddings, chat completions). Tests point the SDK at it with
 * OPENAI_BASE_URL, so no test ever calls a real provider or spends money.
 * Every call is counted, which is what the paid-call accounting tests assert.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOpenAI {
  url: string;
  calls: { embeddings: number; chat: number; maxConcurrentChat: number };
  requests: { path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }[];
  embeddingFor: (input: string) => number[];
  chatReply: (body: Record<string, unknown>) => string;
  chatDelayMs: number;
  close(): Promise<void>;
}

export async function startFakeOpenAI(opts: { embeddingFor: (input: string) => number[]; chatReply?: (body: Record<string, unknown>) => string }): Promise<FakeOpenAI> {
  let activeChat = 0;
  const state: FakeOpenAI = {
    url: "",
    calls: { embeddings: 0, chat: 0, maxConcurrentChat: 0 },
    requests: [],
    embeddingFor: opts.embeddingFor,
    chatReply: opts.chatReply ?? (() => JSON.stringify({ lede: "A grounded takeaway.", answer: "Charles discussed this [1] and expanded on it [2]." })),
    chatDelayMs: 0,
    close: async () => {},
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* ignore */ }
      state.requests.push({ path: req.url || "", body, headers: req.headers });
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/embeddings")) {
        state.calls.embeddings++;
        const input = String(body.input ?? "");
        const v = state.embeddingFor(input);
        // Like the real API: the SDK asks for base64 (little-endian float32) by default.
        const embedding = body.encoding_format === "base64" ? Buffer.from(new Float32Array(v).buffer).toString("base64") : v;
        res.end(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding }], model: "text-embedding-3-small", usage: { prompt_tokens: 1, total_tokens: 1 } }));
        return;
      }
      if (req.url?.endsWith("/chat/completions")) {
        state.calls.chat++;
        activeChat++;
        state.calls.maxConcurrentChat = Math.max(state.calls.maxConcurrentChat, activeChat);
        if (state.chatDelayMs) await new Promise((r) => setTimeout(r, state.chatDelayMs));
        activeChat--;
        res.end(JSON.stringify({
          id: "chatcmpl-test", object: "chat.completion", created: 0, model: String(body.model ?? ""),
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: state.chatReply(body) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}/v1`;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  process.env.OPENAI_BASE_URL = state.url;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  return state;
}
