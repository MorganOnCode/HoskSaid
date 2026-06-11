"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { AskResponse, AskEmpty, AskFilters } from "@/lib/ask-types";

type AskState = "idle" | "loading" | "answered" | "empty" | "error";

interface AskContextValue {
  state: AskState;
  query: string;
  response: AskResponse | null;
  empty: AskEmpty | null;
  errorReqId: string | null;
  activeCite: number | null;
  setActiveCite: (n: number | null) => void;
  submit: (q: string, filters?: AskFilters) => void;
  retry: () => void;
}

const AskContext = createContext<AskContextValue | null>(null);

export function useAsk(): AskContextValue {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error("useAsk must be used within <AskProvider>");
  return ctx;
}

/**
 * Drives the whole Ask flow: idle → loading → answered | empty | error.
 * `fixedFilters` scopes every question (used by the Video page's "ask this video").
 */
export function AskProvider({
  children,
  fixedFilters,
}: {
  children: React.ReactNode;
  fixedFilters?: AskFilters;
}) {
  const [state, setState] = useState<AskState>("idle");
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [empty, setEmpty] = useState<AskEmpty | null>(null);
  const [errorReqId, setErrorReqId] = useState<string | null>(null);
  const [activeCite, setActiveCite] = useState<number | null>(null);
  const lastRef = useRef<{ q: string; filters?: AskFilters }>({ q: "" });

  const run = useCallback(
    async (q: string, filters?: AskFilters) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      lastRef.current = { q: trimmed, filters };
      setQuery(trimmed);
      setActiveCite(null);
      setResponse(null);
      setEmpty(null);
      setErrorReqId(null);
      setState("loading");

      // Bring the answer into view.
      requestAnimationFrame(() => {
        const el = document.getElementById("answer-shell");
        if (el) {
          const top = el.getBoundingClientRect().top + window.scrollY - 80;
          window.scrollTo({ top, behavior: "smooth" });
        }
      });

      const merged: AskFilters | undefined =
        fixedFilters || filters ? { ...fixedFilters, ...filters } : undefined;

      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: trimmed, filters: merged }),
        });

        if (res.status === 422) {
          setEmpty((await res.json()) as AskEmpty);
          setState("empty");
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setErrorReqId(body?.request_id ?? res.headers.get("x-request-id"));
          setState("error");
          return;
        }
        setResponse((await res.json()) as AskResponse);
        setState("answered");
      } catch {
        setState("error");
      }
    },
    [fixedFilters]
  );

  const retry = useCallback(() => {
    if (lastRef.current.q) run(lastRef.current.q, lastRef.current.filters);
  }, [run]);

  return (
    <AskContext.Provider
      value={{ state, query, response, empty, errorReqId, activeCite, setActiveCite, submit: run, retry }}
    >
      {children}
    </AskContext.Provider>
  );
}
