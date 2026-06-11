/** Shared footer. The "not affiliated" disclaimer + takedown contact are
 *  required on every page (HANDOFF §10). */
export function SiteFooter() {
  return (
    <footer className="foot">
      <span className="mono">
        <b>hosksaid</b> · an independent transcript index of Charles Hoskinson&apos;s public videos<br />
        Not affiliated with IOG, the Cardano Foundation, or Charles Hoskinson. Answers are
        AI-synthesized from public transcripts.{" "}
        <a className="mono" href="mailto:morganic.thailand@gmail.com?subject=hosksaid%20correction%2Ftakedown" style={{ color: "var(--ink-faint)", textDecoration: "underline" }}>
          Corrections &amp; takedowns
        </a>.
      </span>
      <span className="mono">BUILT ON <b>tubechat</b> · v0.2</span>
    </footer>
  );
}
