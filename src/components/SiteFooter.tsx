import Link from "next/link";

/** Shared footer. The "not affiliated" disclaimer + takedown contact are
 *  required on every page (HANDOFF §10). */
export function SiteFooter() {
  const contact = process.env.CONTACT_EMAIL || "morganic.thailand@gmail.com";
  return (
    <footer className="foot">
      <span className="mono">
        <b>hosksaid</b> · an independent transcript index of Charles Hoskinson&apos;s public videos<br />
        Not affiliated with IOG, the Cardano Foundation, or Charles Hoskinson. Answers are
        AI-synthesized from public transcripts.{" "}
        <Link className="mono" href="/privacy" style={{ color: "var(--ink-faint)", textDecoration: "underline" }}>
          Privacy
        </Link>{" · "}
        <a className="mono" href={`mailto:${contact}?subject=hosksaid%20correction%2Ftakedown`} style={{ color: "var(--ink-faint)", textDecoration: "underline" }}>
          Corrections &amp; takedowns
        </a>.
      </span>
      <span className="mono">BUILT ON <b>tubechat</b> · v0.3</span>
    </footer>
  );
}
