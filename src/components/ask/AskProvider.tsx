"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { AskResponse, AskEmpty, AskFilters } from "@/lib/ask-types";
import { describeAskFailure, describeConverseFailure, type AskFailure } from "@/lib/ask-errors";
import { MAX_THREAD_TURNS, PROVIDER_KEY_HEADER, type GeneratedBy } from "@/lib/byok-catalog";
import { buildHistory } from "@/lib/conversation";
import { engineProblem, getEngine } from "./engine-store";

export type TurnState = "loading" | "answered" | "empty" | "error";

/** Extra fields a visitor-key answer carries (absent on site answers). */
export interface ConverseMeta {
  generated_by?: GeneratedBy;
  grounded?: boolean;
  retrieval?: { fresh_segments: number; carried_segments: number; carried_dropped: number };
  conversation?: { history_turns_used: number };
}

export interface Turn {
  id: number;
  query: string;
  state: TurnState;
  response: (AskResponse & ConverseMeta) | null;
  empty: (AskEmpty & { insufficient_evidence?: boolean }) | null;
  failure: AskFailure | null;
  errorReqId: string | null;
  /** Who was asked to answer this turn. */
  engine: { mode: "site" } | { mode: "byok"; provider: string; model: string };
  /** Earlier answered turns that were not sent with this question. */
  excluded: number;
}

interface AskContextValue {
  turns: Turn[];
  /** Scope every turn of the current conversation uses. */
  filters: AskFilters | undefined;
  /** Start a new conversation (any answer engine). */
  submit: (q: string, filters?: AskFilters) => void;
  /** Ask a follow-up in the current conversation (visitor-key engine only). */
  followUp: (q: string) => void;
  retry: (turnId: number) => void;
  clear: () => void;
  busy: boolean;
}

const AskContext = createContext<AskContextValue | null>(null);

export function useAsk(): AskContextValue {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error("useAsk must be used within <AskProvider>");
  return ctx;
}

let nextTurnId = 1;

/**
 * Drives the Ask flow and the in-memory conversation thread.
 * `fixedFilters` scopes every question (used by the Video page's "ask this video").
 * The thread lives in React state only: nothing is persisted, and a reload or
 * "New conversation" discards it.
 */
export function AskProvider({
  children,
  fixedFilters,
}: {
  children: React.ReactNode;
  fixedFilters?: AskFilters;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [filters, setFilters] = useState<AskFilters | undefined>(fixedFilters);
  const turnsRef = useRef<Turn[]>([]);
  const filtersRef = useRef<AskFilters | undefined>(fixedFilters);
  const generation = useRef(0);

  const commit = useCallback((next: Turn[]) => {
    turnsRef.current = next;
    setTurns(next);
  }, []);

  const patchTurn = useCallback(
    (id: number, patch: Partial<Turn>) => {
      commit(turnsRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    },
    [commit]
  );

  const scrollTo = (id: number) =>
    requestAnimationFrame(() => {
      const el = document.getElementById(`turn-${id}`) ?? document.getElementById("answer-shell");
      if (el) {
        const top = el.getBoundingClientRect().top + window.scrollY - 80;
        window.scrollTo({ top, behavior: "smooth" });
      }
    });

  /** Run one turn. `prior` are the earlier turns of this conversation. */
  const runTurn = useCallback(
    async (q: string, prior: Turn[], scope: AskFilters | undefined, reuseId?: number) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      const gen = generation.current;
      const engine = getEngine();
      const id = reuseId ?? nextTurnId++;
      const answered = prior.filter((t) => t.state === "answered" && t.response).map((t) => ({ query: t.query, response: t.response! }));
      const hist = engine.mode === "byok" ? buildHistory(answered) : { history: [], excluded: 0 };
      const turn: Turn = {
        id,
        query: trimmed,
        state: "loading",
        response: null,
        empty: null,
        failure: null,
        errorReqId: null,
        engine: engine.mode === "byok" ? { mode: "byok", provider: engine.provider, model: engine.model } : { mode: "site" },
        excluded: hist.excluded,
      };
      commit([...prior, turn]);
      scrollTo(id);

      const finish = (patch: Partial<Turn>) => {
        if (gen === generation.current) patchTurn(id, patch);
      };

      if (engine.mode === "byok") {
        const problem = engineProblem(engine);
        if (problem) {
          finish({ state: "error", failure: { code: "SETUP", title: "Finish setting up your key", message: problem, retryable: false } });
          return;
        }
      }

      try {
        const res =
          engine.mode === "byok"
            ? await fetch("/api/converse", {
                method: "POST",
                headers: { "Content-Type": "application/json", [PROVIDER_KEY_HEADER]: engine.key },
                body: JSON.stringify({ provider: engine.provider, model: engine.model, query: trimmed, filters: scope, history: hist.history }),
                cache: "no-store",
                credentials: "omit",
              })
            : await fetch("/api/ask", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: trimmed, filters: scope }),
              });

        if (res.status === 422) {
          finish({ state: "empty", empty: (await res.json()) as AskEmpty });
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          finish({
            state: "error",
            errorReqId: body?.request_id ?? res.headers.get("x-request-id"),
            failure: engine.mode === "byok" ? describeConverseFailure(res.status, body) : describeAskFailure(res.status, body),
          });
          return;
        }
        finish({ state: "answered", response: (await res.json()) as AskResponse & ConverseMeta });
      } catch {
        finish({ state: "error", failure: describeAskFailure(null, null) });
      }
    },
    [commit, patchTurn]
  );

  const submit = useCallback(
    (q: string, extra?: AskFilters) => {
      generation.current++;
      const merged: AskFilters | undefined = fixedFilters || extra ? { ...fixedFilters, ...extra } : undefined;
      filtersRef.current = merged;
      setFilters(merged);
      runTurn(q, [], merged);
    },
    [fixedFilters, runTurn]
  );

  const followUp = useCallback(
    (q: string) => {
      const prior = turnsRef.current;
      if (getEngine().mode !== "byok" || prior.length >= MAX_THREAD_TURNS || prior.some((t) => t.state === "loading")) return;
      runTurn(q, prior, filtersRef.current);
    },
    [runTurn]
  );

  const retry = useCallback(
    (turnId: number) => {
      const all = turnsRef.current;
      const i = all.findIndex((t) => t.id === turnId);
      if (i < 0 || all[i].state === "loading") return;
      runTurn(all[i].query, all.slice(0, i), filtersRef.current, turnId);
    },
    [runTurn]
  );

  const clear = useCallback(() => {
    generation.current++;
    filtersRef.current = fixedFilters;
    setFilters(fixedFilters);
    commit([]);
  }, [commit, fixedFilters]);

  const busy = turns.some((t) => t.state === "loading");

  return (
    <AskContext.Provider value={{ turns, filters, submit, followUp, retry, clear, busy }}>
      {children}
    </AskContext.Provider>
  );
}
