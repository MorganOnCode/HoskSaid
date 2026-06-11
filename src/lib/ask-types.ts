/** Client-safe types for the Ask flow + handoff API contract (no db imports). */

/** A citation: maps an inline [n] marker to the segment it grounds. */
export interface AskCitation {
  n: number;
  segment_id: string; // transcript_chunks.id
  video_id: string; // youtube_id
  timestamp: string; // human h:mm:ss
  quote: string;
}

/** A source card: the video a cited segment belongs to. sources[].n === citations[].n. */
export interface AskSource {
  n: number;
  video_id: string; // youtube_id
  title: string;
  date: string | null; // YYYY-MM-DD
  timestamp: string; // human h:mm:ss
  cite_count: number;
  url: string; // /video/{id}?t={seconds}
  // UI conveniences (additive to the handoff Source schema):
  start_seconds: number | null;
  similarity: number;
}

/** POST /api/ask 200 response (also the search_archive MCP tool result). */
export interface AskResponse {
  query: string;
  answer: string;
  lede: string;
  citations: AskCitation[];
  sources: AskSource[];
}

/** 422 — nothing cleared the relevance threshold. */
export interface AskEmpty {
  matched: 0;
  suggestions: string[];
}

export interface AskFilters {
  date_from?: string;
  date_to?: string;
  video_ids?: string[]; // youtube_ids
  topics?: string[]; // topic slugs or names
}

/** Loading-state status labels, cycled client-side while the request is in flight. */
export const ASK_STAGES = [
  "Searching the transcripts…",
  "Ranking matching segments…",
  "Reading the top clips…",
  "Synthesizing a cited answer…",
] as const;
