"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useAsk, type Turn } from "./AskProvider";
import { AnswerBody } from "./AnswerBody";
import { SourceCard } from "./SourceCard";
import { KeywordResults } from "./KeywordResults";
import { useEngine } from "./engine-store";
import Link from "next/link";
import { ASK_STAGES, type AskFilters } from "@/lib/ask-types";
import { describeAskFailure } from "@/lib/ask-errors";
import { BYOK_PROVIDERS, MAX_HISTORY_TURNS, MAX_THREAD_TURNS, isByokProvider } from "@/lib/byok-catalog";

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

function providerLabel(p: string): string {
  return isByokProvider(p) ? BYOK_PROVIDERS[p].label : p;
}

/** "Answered by …" line: always names who generated the answer. */
function EngineLabel({ turn }: { turn: Turn }) {
  const g = turn.response?.generated_by;
  if (g?.engine === "visitor_key") {
    return (
      <span className="engine-badge byok">
        Answered by {providerLabel(g.provider)} · <code>{g.model}</code> with your key
      </span>
    );
  }
  if (turn.engine.mode === "byok") {
    return (
      <span className="engine-badge byok">
        Asked {providerLabel(turn.engine.provider)} · <code>{turn.engine.model || "no model"}</code> with your key
      </span>
    );
  }
  return <span className="engine-badge">Answered by the site model · free, daily limit</span>;
}

function scopeLabel(f: AskFilters | undefined): string {
  if (f?.video_ids?.length) return f.video_ids.length === 1 ? "THIS VIDEO" : `${f.video_ids.length} VIDEOS`;
  if (f?.date_from || f?.date_to) return `${f.date_from ?? "…"} → ${f.date_to ?? "TODAY"}`;
  return "ALL VIDEOS";
}

function TurnView({ turn, last }: { turn: Turn; last: boolean }) {
  const { submit, retry, filters } = useAsk();
  const [activeCite, setActiveCite] = useState<number | null>(null);
  const router = useRouter();
  const fail = turn.failure ?? describeAskFailure(null, null);
  const response = turn.response;

  return (
    <div className="answer-state on turn" id={`turn-${turn.id}`}>
      {turn.excluded > 0 && (
        <p className="turn-note" role="note">
          {turn.excluded} earlier {turn.excluded === 1 ? "turn was" : "turns were"} not sent with this question: follow-ups carry only the last{" "}
          {MAX_HISTORY_TURNS} turns.
        </p>
      )}

      {turn.state === "loading" && <LoadingCard />}

      {turn.state === "answered" && response && (
        <div className="answer-card">
          <div className="answer-q">
            <span className="avatar sm">CH<span className="live" /></span>
            <span className="qtext">{turn.query}</span>
          </div>
          <div className="answer-meta"><EngineLabel turn={turn} /></div>

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

          {response.grounded === false && (
            <p className="turn-note warn" role="note">
              This answer cites none of the transcript excerpts it was given, so no sources are shown. Treat it as unsupported by the archive.
            </p>
          )}

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
      )}

      {turn.state === "empty" && (
        <div className="state-card">
          <span className="glyph">⌕</span>
          <h3>Nothing in the archive — yet</h3>
          <p className="qecho">“{turn.query}”</p>
          <p>
            No transcript segment clears the relevance bar for that question
            {turn.engine.mode === "byok" ? ", so it was not sent to your provider" : ""}. The index keeps growing as new videos publish — try
            again later, or broaden what you&apos;re asking.
          </p>
          {turn.engine.mode === "site" && last && (
            <div className="row">
              {(turn.empty?.suggestions ?? []).slice(0, 2).map((q) => (
                <button key={q} type="button" className="suggest" onClick={() => submit(q)}>
                  {q} <span className="arr">→</span>
                </button>
              ))}
            </div>
          )}
          <KeywordResults query={turn.query} filters={filters} />
          <span className="mono">0 SEGMENTS MATCHED</span>
        </div>
      )}

      {turn.state === "error" && (
        <div className="state-card error">
          <span className="glyph">!</span>
          <h3>{fail.title}</h3>
          <p className="qecho">“{turn.query}”</p>
          <p>{fail.message}</p>
          <div className="row">
            {fail.retryable && last ? (
              <button className="btn accent" onClick={() => retry(turn.id)}>↻ Retry</button>
            ) : fail.keyword ? null : (
              <Link className="btn" href="/library">Search the Library</Link>
            )}
          </div>
          {fail.keyword && <KeywordResults query={turn.query} filters={filters} />}
          <span className="mono">ERR · {fail.code}{turn.errorReqId ? ` · REQ ${turn.errorReqId}` : ""}</span>
        </div>
      )}
    </div>
  );
}

/** Follow-up box under a visitor-key conversation. */
function FollowUp() {
  const { turns, followUp, clear, busy, filters } = useAsk();
  const engine = useEngine();
  const [value, setValue] = useState("");
  const id = useId();
  const full = turns.length >= MAX_THREAD_TURNS;
  const byok = engine.mode === "byok";

  function send() {
    if (!value.trim() || busy || full || !byok) return;
    followUp(value);
    setValue("");
  }

  return (
    <div className="followup">
      {byok ? (
        <>
          <div className="followup-lab">
            <label htmlFor={`${id}-fu`}>
              Follow-up with {engine.provider ? providerLabel(engine.provider) : "your key"}
              {engine.model ? <> · <code>{engine.model}</code></> : null}
            </label>
            <span className="scope-chip" title="Every turn of this conversation keeps this scope"><span className="dotc" />{scopeLabel(filters)}</span>
          </div>
          <div className="fu-box">
            <textarea
              id={`${id}-fu`}
              className="fu-field"
              value={value}
              rows={1}
              maxLength={1000}
              disabled={full}
              placeholder={full ? "This conversation is full. Start a new one." : "Ask a follow-up — the same scope and cited excerpts carry over"}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="fu-bar">
              <div className="l">
                <span className="followup-hint">Earlier answers are context, not evidence: each follow-up searches the transcripts again.</span>
              </div>
              <button className="send" aria-label="Send follow-up" disabled={busy || full || !value.trim()} onClick={send}>→</button>
            </div>
          </div>
        </>
      ) : (
        <p className="followup-hint">Follow-up questions use your own API key. Switch “Answer with” to Your own API key to continue a conversation.</p>
      )}
      <div className="followup-actions">
        <button type="button" className="btn ghost" onClick={clear} disabled={busy}>
          {byok ? "New conversation" : "Clear answer"}
        </button>
      </div>
    </div>
  );
}

/** Renders the conversation thread. Hidden entirely when there are no turns. */
export function AnswerShell() {
  const { turns } = useAsk();
  return (
    <section className="answer-shell" id="answer-shell" aria-live="polite">
      {turns.map((t, i) => (
        <TurnView key={t.id} turn={t} last={i === turns.length - 1} />
      ))}
      {turns.length > 0 && turns[turns.length - 1].state !== "loading" && <FollowUp />}
    </section>
  );
}
