import Link from "next/link";
import "../browse.css";

export const metadata = { title: "Privacy", alternates: { canonical: "/privacy" } };
export const dynamic = "force-dynamic";

/**
 * Plain statement of what this deployment stores. Keep it in step with the
 * code: answers persistence (retrieval.ts), rate limiting (ratelimit.ts),
 * browser storage (EngineProvider, theme script) and subscriptions
 * (newsletter/*). It describes storage as it is, not as it might be.
 */
export default function PrivacyPage() {
  const persist = process.env.PERSIST_ASK_QUESTIONS !== "false";
  const newsletter = process.env.NEWSLETTER_ENABLED === "true";
  const contact = process.env.CONTACT_EMAIL || "morganic.thailand@gmail.com";
  return (
    <div className="wrap">
      <div className="page-head">
        <span className="eyebrow"><span className="dot" />PRIVACY</span>
        <h1>What this site <em>keeps</em></h1>
        <p className="sub">thehosksaid is a small independent project. This page lists what it stores and where your text goes.</p>
      </div>
      <div className="prose">
        <h2>Questions you ask with the site&apos;s model</h2>
        {persist ? (
          <p>
            When the site&apos;s own model answers a question (on this site, through <code>POST /api/ask</code>, or the MCP
            tool <code>search_archive</code>), the question text, the generated answer, its citations, any scope filters, a random request
            id and the time are stored in the site&apos;s database. They are kept with no expiry date and are included in the
            nightly backups. They are not linked to your IP address, an account, or a cookie. Stored answers are used to count how often
            each video is cited.
          </p>
        ) : (
          <p>Questions answered by the site&apos;s model are not stored in this deployment.</p>
        )}
        <p>
          To answer, the question text is sent to OpenAI to compute a search embedding and generate the answer, under OpenAI&apos;s API terms.
          The home page&apos;s &ldquo;Most cited&rdquo; list only appears once at least five questions were asked in the past week.
        </p>

        <h2>Questions answered with your own key or local model</h2>
        <p>
          If you choose <b>Your API key</b>, your key and question pass through this site&apos;s server for that one request and are sent only to
          the provider you picked. The key is not stored, logged or cached on the server, and neither the question nor the answer is saved.
          If you choose <b>Local model</b>, your browser sends the question to this site only to find transcript segments (not saved), then your
          browser talks to the model server on your own computer directly. In both cases the site still pays for and computes the search
          embedding with OpenAI.
        </p>
        <p>
          In your browser, a provider key is kept in memory by default and is gone when you close or reload the tab. If you tick
          &ldquo;remember for this tab&rdquo; it is kept in that tab&apos;s session storage until the tab closes or you press &ldquo;Forget key&rdquo;.
          Local-model settings (address and model name, never keys) and your theme choice are kept in local storage. To revoke a key, delete it in
          your provider&apos;s dashboard.
        </p>

        <h2>Searches</h2>
        <p>
          Library keyword searches run in the site&apos;s database and are not stored. Semantic segment searches (<code>/api/search</code>,
          the MCP tool <code>search_segments</code>) send the query text to OpenAI to compute an embedding and are not stored.
        </p>

        <h2>Network and abuse protection</h2>
        <p>
          Traffic reaches this site through Cloudflare, which processes requests under its own policies. To enforce rate limits, the site keeps
          your IP address in memory for a few minutes. It is not written to the database. Application logs record errors but not the content of requests.
          The site sets no cookies of its own and runs no analytics or advertising scripts. Video pages embed YouTube&apos;s player, which loads
          from youtube.com under Google&apos;s policies.
        </p>

        <h2>Newsletter</h2>
        {newsletter ? (
          <p>
            If you subscribe, the site stores your email address, whether you have confirmed, when and under which consent wording you agreed, and
            hashed one-time tokens for confirming and unsubscribing. It does not store your IP address or browser details. Every email has a one-click
            unsubscribe link. Unsubscribing stops all mail. Your address is kept only so that it stays unsubscribed.
          </p>
        ) : (
          <p>The newsletter is not open yet. No email addresses are collected.</p>
        )}

        <h2>Requests</h2>
        <p>
          To ask about or remove something you submitted, email <a href={`mailto:${contact}?subject=hosksaid%20privacy`}>{contact}</a>. Because
          stored questions are not linked to any identity, include the exact question text and roughly when you asked it. See also the{" "}
          <Link href="/agents">agent &amp; API documentation</Link>.
        </p>
      </div>
    </div>
  );
}
