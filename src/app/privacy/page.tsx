import Link from "next/link";
import "../browse.css";

export const metadata = { title: "Privacy", alternates: { canonical: "/privacy" } };
export const dynamic = "force-dynamic";

/**
 * Plain statement of what this deployment stores. Keep it in step with the
 * code: answers persistence (retrieval.ts), rate limiting (ratelimit.ts),
 * per-client daily allowances (usage.ts), visitor-key answers (converse.ts,
 * byok-providers.ts, components/ask/engine-store.ts) and browser storage
 * (theme script). It describes storage as it is, not as it
 * might be.
 */
export default function PrivacyPage() {
  const persist = process.env.PERSIST_ASK_QUESTIONS !== "false";
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

        <h2>Questions you ask with your own API key</h2>
        <p>
          If you choose &ldquo;Your own API key&rdquo;, you pick the provider (OpenAI, Anthropic or OpenRouter) and the model. Your key is kept
          in that browser tab&apos;s memory only: it is not written to local or session storage, cookies or the URL, and it is gone when you
          press <em>Forget key</em>, reload or close the tab. It does leave your device: with each question it is sent over HTTPS to this
          site&apos;s server, which forwards it to that provider&apos;s official API host (<code>api.openai.com</code>,{" "}
          <code>api.anthropic.com</code> or <code>openrouter.ai</code>) for that one request and then drops it. The server does not store,
          log or cache the key, and does not use it to identify you.
        </p>
        <p>
          The provider you chose receives your question, up to four earlier questions and answers from the same conversation, and the public
          transcript excerpts the site found, under that provider&apos;s terms, and bills your account. These questions and answers are not
          stored in the site&apos;s database or answer cache, and are not counted in &ldquo;Most cited&rdquo;. The conversation exists only on
          your screen; <em>New conversation</em> or a reload discards it. To find the excerpts, the question text is still sent to OpenAI on the
          site&apos;s account to compute a search embedding, which counts against the shared daily search allowance described below.
        </p>

        <h2>Searches</h2>
        <p>
          Library keyword searches run in the site&apos;s database and are not stored. Semantic segment searches (<code>/api/search</code>,
          the MCP tool <code>search_segments</code>) send the query text to OpenAI to compute an embedding and are not stored.
        </p>

        <h2>Network and abuse protection</h2>
        <p>
          Traffic reaches this site through Cloudflare, which processes requests under its own policies. To enforce rate limits, the site keeps
          your IP address in memory for a few minutes. To enforce daily allowances for answers and semantic searches, the database keeps a
          count per client for the current UTC day under a keyed hash of the date and your IP address (or API key). The address or key itself
          is not stored, the hash changes every day, and earlier days&apos; counts are deleted from the database (nightly backups may still hold them). Application logs record errors but not the content of requests.
          The site sets no cookies of its own and runs no analytics or advertising scripts. Your theme choice is kept in your browser&apos;s
          local storage. Video pages embed YouTube&apos;s player, which loads
          from youtube.com under Google&apos;s policies.
        </p>

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
