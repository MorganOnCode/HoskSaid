"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAsk } from "./AskProvider";
import { AnswerBody } from "./AnswerBody";
import { SourceCard } from "./SourceCard";
import { ASK_STAGES } from "@/lib/ask-types";

function LoadingCard() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % ASK_STAGES.length), 620);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="answer-card">
      <div className="answer-q">
        <span className="skel av" />
        <span className="skel q" />
      </div>
      <div className="thinking"><span className="orb" /><span>{ASK_STAGES[i]}</span></div>
      <div className="answer-body" style={{ paddingTop: 6 }}>
        <span className="skel l w-90" /><span className="skel l w-80" />
        <span className="skel l w-60" /><span className="skel l w-70" /><span className="skel l w-40" />
      </div>
      <div className="sources-head"><span className="lab">Sources</span><span className="ln" /><span className="eyebrow" style={{ fontSize: 11 }}>ALIGNING TIMESTAMPS</span></div>
      <div className="skel-sources">
        {Array.from({ length: 4 }).map((_, k) => (
          <div className="skel-src" key={k}>
            <span className="skel sth" />
            <div className="stb"><span className="skel l w-40" style={{ marginTop: 0 }} /><span className="skel l w-90" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Renders whichever Ask state is active. Hidden entirely when idle. */
export function AnswerShell() {
  const { state, query, response, empty, errorReqId, activeCite, setActiveCite, submit, retry } = useAsk();
  const router = useRouter();

  return (
    <section className="answer-shell" id="answer-shell">
      {state === "loading" && (
        <div className="answer-state on">
          <LoadingCard />
        </div>
      )}

      {state === "answered" && response && (
        <div className="answer-state on">
          <div className="answer-card">
            <div className="answer-q">
              <span className="avatar sm">CH<span className="live" /></span>
              <span className="qtext">{query}</span>
            </div>

            <AnswerBody
              lede={response.lede}
              text={response.answer}
              activeCite={activeCite}
              handlers={{
                enter: setActiveCite,
                leave: () => setActiveCite(null),
                click: (n) => {
                  const src = response.sources.find((s) => s.n === n);
                  if (src) router.push(src.url);
                },
              }}
            />

            {response.sources.length > 0 && (
              <>
                <div className="sources-head">
                  <span className="lab">{response.sources.length} {response.sources.length === 1 ? "Source" : "Sources"}</span>
                  <span className="ln" />
                  <span className="eyebrow" style={{ fontSize: 11 }}>SYNTHESIZED FROM TRANSCRIPTS</span>
                </div>
                <div className="source-row">
                  {response.sources.map((s) => (
                    <SourceCard
                      key={s.n}
                      source={s}
                      active={activeCite === s.n}
                      onEnter={() => setActiveCite(s.n)}
                      onLeave={() => setActiveCite(null)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {state === "empty" && (
        <div className="answer-state on">
          <div className="state-card">
            <span className="glyph">⌕</span>
            <h3>Nothing in the archive — yet</h3>
            <p>No transcript segment clears the relevance bar for that question. The index keeps growing as new videos publish — try again later, or broaden what you&apos;re asking.</p>
            <div className="row">
              {(empty?.suggestions ?? []).slice(0, 2).map((q) => (
                <button key={q} type="button" className="suggest" onClick={() => submit(q)}>
                  {q} <span className="arr">→</span>
                </button>
              ))}
            </div>
            <span className="mono">0 SEGMENTS MATCHED</span>
          </div>
        </div>
      )}

      {state === "error" && (
        <div className="answer-state on">
          <div className="state-card error">
            <span className="glyph">!</span>
            <h3>The index didn&apos;t respond</h3>
            <p>We couldn&apos;t reach the search service to synthesize an answer. Your question is fine — this one&apos;s on us. Give it another go in a moment.</p>
            <div className="row">
              <button className="btn accent" onClick={retry}>↻ Retry</button>
            </div>
            <span className="mono">ERR · SYNTHESIS{errorReqId ? ` · REQ ${errorReqId}` : ""}</span>
          </div>
        </div>
      )}
    </section>
  );
}
