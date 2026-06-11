"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { formatTimecode } from "@/lib/format";

/** Lets components inside the video page (chapters, summary) drive + follow the player. */
interface PlayerCtx {
  seek: (seconds: number) => void;
  currentTime: number;
}
const PlayerContext = createContext<PlayerCtx>({ seek: () => {}, currentTime: 0 });
export const usePlayer = () => useContext(PlayerContext);

interface YTPlayer {
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  getCurrentTime(): number;
  destroy(): void;
}
interface YTPlayerOptions {
  videoId: string;
  width?: string | number;
  height?: string | number;
  playerVars?: Record<string, string | number>;
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: YTPlayerOptions) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytReady: Promise<NonNullable<Window["YT"]>> | null = null;
function loadYT(): Promise<NonNullable<Window["YT"]>> {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (window.YT) resolve(window.YT);
    };
    if (!document.getElementById("yt-iframe-api")) {
      const s = document.createElement("script");
      s.id = "yt-iframe-api";
      s.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(s);
    }
  });
  return ytReady;
}

export interface TimedSeg {
  start: number;
  text: string;
}

function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const out: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  let idx = lower.indexOf(ql, i);
  while (idx !== -1) {
    if (idx > i) out.push(text.slice(i, idx));
    out.push(<mark key={idx}>{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
    idx = lower.indexOf(ql, i);
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

/**
 * Player (YouTube IFrame API) + synced transcript. Timed `segments` make lines
 * clickable (seek) with the active line following the playhead; otherwise it
 * falls back to a search-only paragraph transcript.
 */
export function VideoDetailClient({
  youtubeId,
  startSeconds = 0,
  segments,
  paragraphs,
  children,
}: {
  youtubeId: string;
  startSeconds?: number;
  segments?: TimedSeg[];
  paragraphs?: string[];
  children?: React.ReactNode;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [currentTime, setCurrentTime] = useState(startSeconds);
  const [q, setQ] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const segRefs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    loadYT().then((YT) => {
      if (cancelled || !mountRef.current) return;
      playerRef.current = new YT.Player(mountRef.current, {
        videoId: youtubeId,
        width: "100%",
        height: "100%",
        playerVars: { start: Math.floor(startSeconds), rel: 0, modestbranding: 1 },
      });
      poll = setInterval(() => {
        const p = playerRef.current;
        if (p && typeof p.getCurrentTime === "function") {
          const t = p.getCurrentTime();
          if (typeof t === "number" && !Number.isNaN(t)) setCurrentTime(t);
        }
      }, 500);
    });
    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
      try { playerRef.current?.destroy(); } catch { /* ignore */ }
      playerRef.current = null;
    };
  }, [youtubeId, startSeconds]);

  const seek = useCallback((s: number) => {
    const p = playerRef.current;
    if (p) { p.seekTo(s, true); p.playVideo(); }
    setCurrentTime(s);
  }, []);

  const timed = segments && segments.length > 0 ? segments : null;
  const items: { text: string; start?: number }[] = useMemo(
    () => (timed ? timed.map((s) => ({ text: s.text, start: s.start })) : (paragraphs ?? []).map((p) => ({ text: p }))),
    [timed, paragraphs]
  );

  const activeIdx = useMemo(() => {
    if (!timed) return -1;
    let idx = 0;
    for (let i = 0; i < timed.length; i++) if (timed[i].start <= currentTime + 0.25) idx = i;
    return idx;
  }, [timed, currentTime]);

  useEffect(() => {
    if (activeIdx < 0) return;
    const el = segRefs.current[activeIdx];
    const list = listRef.current;
    if (el && list) {
      const top = el.offsetTop - list.offsetTop;
      if (top < list.scrollTop + 8 || top > list.scrollTop + list.clientHeight - 60) {
        list.scrollTo({ top: top - 16, behavior: "smooth" });
      }
    }
  }, [activeIdx]);

  const needle = q.trim().toLowerCase();
  const visible = (text: string) => !needle || text.toLowerCase().includes(needle);
  const matchCount = needle ? items.filter((it) => visible(it.text)).length : items.length;

  const ctx = useMemo<PlayerCtx>(() => ({ seek, currentTime }), [seek, currentTime]);

  return (
    <PlayerContext.Provider value={ctx}>
      <div className="vlayout">
        <div className="vmain">
          <div className="player">
            <div className="stage"><div ref={mountRef} /></div>
          </div>
          {children}
        </div>

        <aside className="tx">
          <div className="tx-hd">
            <span className="t">Transcript</span>
            <span className="m">{timed ? `${items.length} lines` : items.length ? "AI-cleaned" : "processing"}</span>
          </div>
          <div className="tx-search">
            <span className="ic">⌕</span>
            <input
              placeholder="Search this transcript…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              spellCheck={false}
              aria-label="Search transcript"
            />
          </div>
          <div className="tx-body" ref={listRef}>
            {items.length === 0 && (
              <div style={{ padding: 16, color: "var(--ink-3)", fontSize: 13.5 }}>Transcript is still processing.</div>
            )}
            {items.map((it, i) => {
              if (!visible(it.text)) return null;
              const cls = "tx-line" + (i === activeIdx ? " active" : "") + (it.start == null ? " noseek" : "");
              const inner = (
                <>
                  <span className="tt">{it.start != null ? formatTimecode(it.start) : ""}</span>
                  <span className="tc">{highlight(it.text, needle)}</span>
                </>
              );
              if (it.start == null) {
                return <div key={i} ref={(el) => { segRefs.current[i] = el; }} className={cls}>{inner}</div>;
              }
              const at = it.start;
              return (
                <button key={i} ref={(el) => { segRefs.current[i] = el; }} className={cls} onClick={() => seek(at)} type="button">
                  {inner}
                </button>
              );
            })}
          </div>
          <div className="tx-foot">
            <span>{needle ? `${matchCount} match${matchCount === 1 ? "" : "es"}` : "MACHINE-GENERATED"}</span>
            <a href={`https://www.youtube.com/watch?v=${youtubeId}`} target="_blank" rel="noopener noreferrer">SOURCE ↗</a>
          </div>
        </aside>
      </div>
    </PlayerContext.Provider>
  );
}
