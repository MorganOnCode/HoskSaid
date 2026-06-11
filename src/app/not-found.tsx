import Link from "next/link";

export default function NotFound() {
  return (
    <div className="wrap" style={{ paddingTop: 80 }}>
      <div className="state-card" style={{ maxWidth: 620, margin: "0 auto" }}>
        <span className="glyph">?</span>
        <h3>That page isn&apos;t in the index</h3>
        <p>The link may be broken, or the video moved. The archive is right here — ask it something, or jump back in.</p>
        <div className="row">
          <Link className="pill" href="/">Ask</Link>
          <Link className="pill" href="/library">Library</Link>
          <Link className="pill" href="/topics">Topics</Link>
          <Link className="pill" href="/timeline">Timeline</Link>
          <Link className="pill" href="/agents">Agents</Link>
        </div>
        <span className="mono">LOST? THE FULL CATALOGUE LIVES IN THE LIBRARY</span>
      </div>
    </div>
  );
}
