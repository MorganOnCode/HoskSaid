/**
 * Ask pipeline (server-only): retrieval → grounded synthesis → handoff contract.
 * Shared by /api/ask, the REST API, and the MCP search_archive tool.
 */
import { sql, matchTranscriptChunks, type SemanticChunk } from "./db";
import { generateEmbedding, getClient } from "./llm";
import { formatTimecode, isoDate } from "./format";
import { bestQuote } from "./transcript-utils";
import type { AskResponse, AskEmpty, AskFilters, AskCitation, AskSource } from "./ask-types";

// Cast a wide net for retrieval, then enforce a stricter quality gate so we never
// synthesize from weak matches (no hallucinated answers — HANDOFF acceptance).
const RETRIEVE_THRESHOLD = 0.3;
const QUALITY_THRESHOLD = 0.4;
const RETRIEVE_COUNT = 30;
const CONTEXT_CHUNKS = 12;

const BROADEN_SUGGESTIONS = [
  "Where does Charles stand on Cardano governance and Voltaire?",
  "What has Charles said about Midnight and the Glacier Drop?",
  "What are the latest Hydra throughput numbers Charles has cited?",
];

interface VideoMeta {
  id: string;
  youtube_id: string;
  title: string;
  published_at: string | null;
  topic_slugs: string[];
}

function slugifyTopic(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "-");
}

const SYSTEM_PROMPT = `You are the answer engine for thehosksaid, an independent index of Charles Hoskinson's public videos (talks, AMAs, whiteboards).

Answer the user's question USING ONLY the supplied transcript segments. Rules:
- Cite every claim with the segment's bracket index exactly as shown: [1], [2], etc. Always include at least one citation.
- Never invent facts, quotes, dates, names, or numbers that are not in the segments.
- If the segments do not support an answer, say so plainly rather than guessing.
- Write 2–4 short, direct paragraphs. No preamble, no "based on the transcripts" throat-clearing.
- Attribute uncertainty honestly ("the transcripts suggest…") when the segments are thin.

Return ONLY a JSON object: {"lede": "<one-sentence takeaway, no citation markers>", "answer": "<the answer with inline [n] citation markers>"}.`;

/** Resolve internal video ids for a set of youtube_ids. */
async function resolveVideoIds(youtubeIds: string[]): Promise<Set<string>> {
  if (!youtubeIds.length) return new Set();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM videos WHERE youtube_id IN ${sql(youtubeIds)}
  `;
  return new Set(rows.map((r) => r.id));
}

/** Fetch metadata + topic slugs for the candidate videos. */
async function fetchVideoMeta(videoIds: string[]): Promise<Map<string, VideoMeta>> {
  if (!videoIds.length) return new Map();
  const rows = await sql<VideoMeta[]>`
    SELECT v.id, v.youtube_id, v.title, v.published_at,
      COALESCE(
        (SELECT array_agg(t.slug) FROM video_topics vt JOIN topics t ON t.id = vt.topic_id WHERE vt.video_id = v.id),
        '{}'
      ) AS topic_slugs
    FROM videos v
    WHERE v.id IN ${sql(videoIds)}
  `;
  return new Map(rows.map((v) => [v.id, v]));
}

/**
 * Retrieve the top context chunks for a query, honouring scope filters.
 * Returns the chunks (with start/end) + a metadata map keyed by internal video id.
 */
export async function retrieveContext(
  query: string,
  filters?: AskFilters
): Promise<{ chunks: SemanticChunk[]; meta: Map<string, VideoMeta> }> {
  const embedding = await generateEmbedding(query);
  if (!embedding.length) return { chunks: [], meta: new Map() };

  let chunks = await matchTranscriptChunks(embedding, RETRIEVE_THRESHOLD, RETRIEVE_COUNT);
  if (!chunks.length) return { chunks: [], meta: new Map() };

  const meta = await fetchVideoMeta([...new Set(chunks.map((c) => c.video_id))]);

  // Scope filters.
  const scopeIds = filters?.video_ids?.length ? await resolveVideoIds(filters.video_ids) : null;
  const topicSlugs = filters?.topics?.length ? new Set(filters.topics.map(slugifyTopic)) : null;
  const from = filters?.date_from ? new Date(filters.date_from).getTime() : null;
  const to = filters?.date_to ? new Date(filters.date_to).getTime() : null;

  chunks = chunks.filter((c) => {
    const v = meta.get(c.video_id);
    if (scopeIds && !scopeIds.has(c.video_id)) return false;
    if (topicSlugs && !(v?.topic_slugs ?? []).some((s) => topicSlugs.has(s))) return false;
    if ((from || to) && v?.published_at) {
      const t = new Date(v.published_at).getTime();
      if (from && t < from) return false;
      if (to && t > to) return false;
    }
    return true;
  });

  return { chunks: chunks.slice(0, CONTEXT_CHUNKS), meta };
}

/** Renumber inline [n] markers to clean sequential 1..M (order of first appearance). */
function renumberCitations(answer: string, maxIndex: number): { text: string; order: number[] } {
  const order: number[] = [];
  const re = /\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const k = parseInt(m[1], 10);
    if (k >= 1 && k <= maxIndex && !order.includes(k)) order.push(k);
  }
  const remap = new Map(order.map((oldN, i) => [oldN, i + 1]));
  const text = answer.replace(/\[(\d+)\]/g, (_full, d) => {
    const k = parseInt(d, 10);
    return remap.has(k) ? `[${remap.get(k)}]` : "";
  });
  return { text, order };
}

/**
 * Full Ask pipeline. Returns the handoff contract on success, or AskEmpty when
 * nothing clears the quality threshold (caller maps that to HTTP 422).
 */
export async function askArchive(
  query: string,
  filters?: AskFilters,
  opts?: { withCitations?: boolean; persist?: boolean; requestId?: string }
): Promise<AskResponse | AskEmpty> {
  const withCitations = opts?.withCitations ?? true;
  const { chunks, meta } = await retrieveContext(query, filters);

  // Quality gate: don't synthesize from weak matches.
  const best = chunks[0]?.similarity ?? 0;
  if (!chunks.length || best < QUALITY_THRESHOLD) {
    return { matched: 0, suggestions: BROADEN_SUGGESTIONS };
  }

  // Build numbered context for the model.
  const context = chunks
    .map((c, i) => {
      const v = meta.get(c.video_id);
      const date = v?.published_at ? isoDate(v.published_at) : "unknown date";
      const label = v ? `[${i + 1}] "${v.title}" (${date})` : `[${i + 1}]`;
      return `${label}\n${c.content}`;
    })
    .join("\n\n---\n\n");

  const openai = getClient();
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1100,
    temperature: 0.4,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Question: ${query}\n\n--- TRANSCRIPT SEGMENTS ---\n\n${context}` },
    ],
  });

  let lede = "";
  let rawAnswer = "";
  try {
    const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
    lede = typeof parsed.lede === "string" ? parsed.lede.trim() : "";
    rawAnswer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  } catch {
    rawAnswer = completion.choices[0]?.message?.content?.trim() || "";
  }
  if (!rawAnswer) {
    return { matched: 0, suggestions: BROADEN_SUGGESTIONS };
  }

  const { text: answer, order } = renumberCitations(rawAnswer, chunks.length);

  // Build citations + sources from the cited chunks, in clean 1..M order.
  const citedIdx = order.length ? order : chunks.slice(0, 4).map((_c, i) => i + 1);
  const citations: AskCitation[] = [];
  const sources: AskSource[] = [];
  citedIdx.forEach((oldN, i) => {
    const c = chunks[oldN - 1];
    const v = meta.get(c.video_id);
    if (!v) return;
    const n = i + 1;
    const start = c.start_time;
    const ts = formatTimecode(start);
    citations.push({
      n,
      segment_id: c.id,
      video_id: v.youtube_id,
      timestamp: ts,
      quote: bestQuote(c.content, query),
    });
    sources.push({
      n,
      video_id: v.youtube_id,
      title: v.title,
      date: isoDate(v.published_at),
      timestamp: ts,
      cite_count: 0, // filled below
      url: `/video/${v.youtube_id}${start != null ? `?t=${start}` : ""}`,
      start_seconds: start,
      similarity: Math.round((c.similarity ?? 0) * 100),
    });
  });

  // cite_count within this answer = how many sources share the same video.
  const perVideo = new Map<string, number>();
  for (const s of sources) perVideo.set(s.video_id, (perVideo.get(s.video_id) ?? 0) + 1);
  for (const s of sources) s.cite_count = perVideo.get(s.video_id) ?? 1;

  const result: AskResponse = {
    query,
    answer,
    lede,
    citations: withCitations ? citations : [],
    sources,
  };

  if (opts?.persist) {
    try {
      await sql`
        INSERT INTO answers (question, answer, lede, citations, sources, scope, request_id)
        VALUES (
          ${query}, ${answer}, ${lede || null},
          ${sql.json(citations as unknown as Parameters<typeof sql.json>[0])},
          ${sql.json(sources as unknown as Parameters<typeof sql.json>[0])},
          ${filters ? sql.json(filters as unknown as Parameters<typeof sql.json>[0]) : null},
          ${opts.requestId ?? null}
        )
      `;
    } catch (e) {
      console.error("Failed to persist answer:", e);
    }
  }

  return result;
}
