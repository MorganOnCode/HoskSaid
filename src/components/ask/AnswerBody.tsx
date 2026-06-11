"use client";

import { Fragment } from "react";

// Matches the handoff's bare [n] markers (and tolerates [[n]] / [Source n]).
const CITE_RE = /\[\[(\d+)\]\]|\[Source\s+(\d+)\]|\[(\d+)\]/g;

export interface CiteHandlers {
  enter: (n: number) => void;
  leave: () => void;
  click: (n: number) => void;
}

function Cite({ n, active, handlers }: { n: number; active: boolean; handlers?: CiteHandlers }) {
  if (!handlers) return <span className="cite">{n}</span>;
  return (
    <button
      className={"cite" + (active ? " on" : "")}
      onMouseEnter={() => handlers.enter(n)}
      onMouseLeave={handlers.leave}
      onFocus={() => handlers.enter(n)}
      onBlur={handlers.leave}
      onClick={() => handlers.click(n)}
      type="button"
      aria-label={`Source ${n}`}
    >
      {n}
    </button>
  );
}

function renderLine(
  line: string,
  activeCite: number | null,
  handlers: CiteHandlers | undefined,
  keyBase: string
) {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null = CITE_RE.exec(line);
  let i = 0;
  while (m !== null) {
    if (m.index > last) nodes.push(line.slice(last, m.index));
    const n = parseInt(m[1] || m[2] || m[3], 10);
    nodes.push(<Cite key={`${keyBase}-c${i}`} n={n} active={activeCite === n} handlers={handlers} />);
    last = m.index + m[0].length;
    i += 1;
    m = CITE_RE.exec(line);
  }
  if (last < line.length) nodes.push(line.slice(last));
  return nodes;
}

/**
 * Renders an answer with inline [n] citation pills. Each pill drives the
 * citation↔source hover relationship via `handlers`/`activeCite`. The first
 * paragraph is styled as the lede when `lede` is provided.
 */
export function AnswerBody({
  lede,
  text,
  activeCite = null,
  handlers,
}: {
  lede?: string;
  text: string;
  activeCite?: number | null;
  handlers?: CiteHandlers;
}) {
  const paras = text.split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean);
  return (
    <div className="answer-body">
      {lede ? <p className="lede">{lede}</p> : null}
      {paras.map((para, li) => (
        <Fragment key={li}>
          <p>{renderLine(para, activeCite, handlers, `l${li}`)}</p>
        </Fragment>
      ))}
    </div>
  );
}
