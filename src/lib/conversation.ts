/**
 * Client-side conversation window (client-safe, pure). The browser keeps the
 * thread in memory; each follow-up sends only the last MAX_HISTORY_TURNS
 * answered turns, each answer trimmed, plus the segment ids that answer cited
 * (pointers the server re-fetches and re-checks; never evidence by themselves).
 */
import { MAX_HISTORY_ANSWER_CHARS, MAX_HISTORY_TURNS, MAX_SEGMENT_IDS_PER_TURN, type HistoryTurn } from "./byok-catalog";
import type { AskResponse } from "./ask-types";

export interface AnsweredTurn {
  query: string;
  response: AskResponse;
}

export interface HistoryWindow {
  history: HistoryTurn[];
  /** Answered turns that exist but are no longer sent to the model. */
  excluded: number;
}

export function buildHistory(answered: AnsweredTurn[]): HistoryWindow {
  const sent = answered.slice(-MAX_HISTORY_TURNS);
  return {
    excluded: answered.length - sent.length,
    history: sent.map((t) => ({
      question: t.query,
      answer: t.response.answer.slice(0, MAX_HISTORY_ANSWER_CHARS),
      segment_ids: [...new Set(t.response.citations.map((c) => c.segment_id))].slice(0, MAX_SEGMENT_IDS_PER_TURN),
    })),
  };
}
