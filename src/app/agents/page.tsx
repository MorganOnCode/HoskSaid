import "../agents.css";
import manifest from "@/lib/contracts/mcp.json";
import { CopyInline } from "@/components/CopyInline";

export const metadata = { title: "Agents — MCP & API" };

const BASE = process.env.PUBLIC_BASE_URL || "https://thehosksaid.com";

/** Retrieval-only workflow for a client that runs its own model. */
const WORKFLOW = `// 1. Find passages. search_segments = semantic (1 site-funded embedding, daily-capped);
//    search_keyword = keyword over full transcripts (no model, no embedding).
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_segments",
  "arguments":{"query":"What has Charles said about Hydra throughput?","limit":8,
               "date_from":"2025-01-01"}}}

{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_keyword",
  "arguments":{"query":"hydra \\"transactions per second\\"","limit":10}}}

// 2. Optionally widen one hit: neighbours or the full transcript.
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_segment",
  "arguments":{"segment_id":"<segment_id from step 1>"}}}

// 3. Your client gives the passages (text, citation, url) to YOUR model,
//    with your own OpenAI / Anthropic / local credentials, and asks it to cite
//    only those passages. HoskSaid never sees or stores your model key.`;

const REST = [
  { m: "POST", p: "/api/ask", d: "Synthesized, citation-backed answer (query ≤ 1000 chars)." },
  { m: "GET", p: "/api/search?q=", d: "Raw semantic search over segments (one site-funded embedding, no answer)." },
  { m: "GET", p: "/api/search/keyword?q=", d: "Keyword search over titles, tags and full transcripts (no model call, no embedding)." },
  { m: "GET", p: "/api/videos", d: "Paginated catalogue (type, topic, sort, cursor)." },
  { m: "GET", p: "/api/videos/{id}", d: "One video: chapters, topics, counts." },
  { m: "GET", p: "/api/topics", d: "Clustered topics with counts." },
  { m: "GET", p: "/api/openapi.json", d: "The full REST spec." },
];

const FILES = [
  { nm: "/llms.txt", ds: "LLM site index" },
  { nm: "/llms-full.txt", ds: "Expanded index, one line per video" },
  { nm: "/.well-known/mcp.json", ds: "MCP manifest + tool schemas" },
  { nm: "/sitemap.xml", ds: "All public pages" },
  { nm: "/robots.txt", ds: "Crawl policy" },
  { nm: "/api/openapi.json", ds: "REST OpenAPI spec" },
];

const SNIPPET = `# Add the MCP server (Claude Code example)
claude mcp add --transport http thehosksaid ${BASE}/mcp

# Retrieval only: passages + citations for your own model
curl -s ${BASE}/api/search?q=hydra+throughput&limit=8

# Or call the REST Ask API directly
curl -s ${BASE}/api/ask \\
  -H 'content-type: application/json' \\
  -d '{"query":"Where does Charles stand on Voltaire timing?"}'`;

export default function AgentsPage() {
  return (
    <div className="wrap">
      <section className="ag-hero">
        <div>
          <span className="eyebrow"><span className="dot" />MODEL CONTEXT PROTOCOL · RETRIEVAL API</span>
          <h1>Give your <em>agent</em> the archive.</h1>
          <p className="sub">Every transcript, searchable over MCP — citations and timestamps included.</p>
          <div className="endpoint">
            <span className="lbl">MCP endpoint (Streamable HTTP)</span>
            <div className="copybar">
              <code><span className="dim">{BASE.replace(/^https?:\/\//, "")}</span><span className="acc">/mcp</span></code>
              <CopyInline text={`${BASE}/mcp`} />
            </div>
          </div>
        </div>
        <div className="term">
          <div className="bar"><span className="d" /><span className="d" /><span className="d" /><span className="t">~ connect</span></div>
          <div className="body">{SNIPPET}</div>
        </div>
      </section>

      <section className="ag-sec">
        <div className="sec-head"><h2>MCP <em>tools</em></h2><span className="ln" /><span className="more">{manifest.tools.length} TOOLS</span></div>
        <p className="intro">All tools return JSON and never change the archive. <code>search_segments</code> and <code>search_keyword</code> are retrieval only: they return bounded source passages with titles, dates, timestamps, deep links and a ready-made <code>citation</code> string, and never generate an answer. <code>search_archive</code> is the optional answer tool: it returns the same shape as <code>POST /api/ask</code> — an answer with <code>citations[]</code> and <code>sources[]</code>. It runs a paid model call on the site&apos;s budget and stores the question and answer (see <a href="/privacy" style={{ textDecoration: "underline" }}>privacy</a>); <code>search_segments</code> spends one embedding call and stores nothing. Site-funded calls have a daily site-wide cap and a smaller daily allowance per client, so they can return a <code>site_budget_exhausted</code> or <code>client_quota_exhausted</code> error. A batch POST may hold at most 8 messages, and each one counts against your rate limit.</p>
        <div className="tool-grid">
          {manifest.tools.map((t) => {
            const args = Object.keys((t.inputSchema?.properties as object) || {});
            const required: string[] = (t.inputSchema?.required as string[]) || [];
            return (
              <div className="tool" key={t.name}>
                <div className="sig">
                  <b>{t.name}</b>
                  <span className="arg">({args.map((a) => (required.includes(a) ? a : `${a}?`)).join(", ")})</span>
                </div>
                <div className="desc">{t.description}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="ag-sec">
        <div className="sec-head"><h2>Use your <em>own model</em></h2><span className="ln" /><span className="more">RETRIEVAL ONLY</span></div>
        <p className="intro">
          Your MCP client (Claude Desktop, Claude Code, an OpenAI Agents app, or a script driving a local model) keeps its own model
          credentials. Call the retrieval tools, then let your model write the answer from the returned passages and cite their links.
          Never put a provider key in a tool argument: no HoskSaid tool accepts one. Semantic retrieval still spends this site&apos;s
          shared embedding allowance (per client and site-wide, reset 00:00 UTC), and your own model key does not raise it; when it runs
          out, <code>search_keyword</code> keeps working. On the website itself, &ldquo;Your own API key&rdquo; does the same for a
          browser visitor: you choose OpenAI, Anthropic or OpenRouter and a model, and that provider writes the answer on your account.
        </p>
        <div className="term">
          <div className="bar"><span className="d" /><span className="d" /><span className="d" /><span className="t">POST {BASE.replace(/^https?:\/\//, "")}/mcp</span></div>
          <div className="body">{WORKFLOW}</div>
        </div>
      </section>

      <section className="ag-sec">
        <div className="sec-head"><h2>REST <em>endpoints</em></h2><span className="ln" /><span className="more">NON-MCP FALLBACK</span></div>
        <div className="files">
          {REST.map((r) => (
            <a className="file" key={r.p} href={r.p.startsWith("/api/openapi") ? "/api/openapi.json" : undefined}>
              <span className="ic">{r.m}</span>
              <span><span className="nm">{r.p}</span><div className="ds">{r.d}</div></span>
              <span className="ar">→</span>
            </a>
          ))}
        </div>
      </section>

      <section className="ag-sec">
        <div className="sec-head"><h2>Access &amp; <em>limits</em></h2><span className="ln" /></div>
        <div className="authgrid">
          <div className="authcell">
            <div className="h">Anonymous <span className="tag">no key</span></div>
            <ul>
              <li><span className="dot">◆</span><span>Every tool &amp; endpoint; nothing modifies the archive.</span></li>
              <li><span className="dot">◆</span><span>Each MCP batch message counts as a request.</span></li>
              <li><span className="dot">◆</span><span><b>60 req/min</b> per IP (burst 120).</span></li>
              <li><span className="dot">◆</span><span>On throttle: <b>429</b> + <b>Retry-After</b>.</span></li>
            </ul>
          </div>
          <div className="authcell">
            <div className="h">API key <span className="tag">bearer</span></div>
            <ul>
              <li><span className="dot">◆</span><span>Send <b>Authorization: Bearer &lt;key&gt;</b>.</span></li>
              <li><span className="dot">◆</span><span><b>600 req/min</b>.</span></li>
              <li><span className="dot">◆</span><span>Contact the maintainer for a key.</span></li>
              <li><span className="dot">◆</span><span>Unrecognized or empty bearer keys return <b>401</b>.</span></li>
              <li><span className="dot">◆</span><span>This is a <b>HoskSaid access key</b>, not a model key: never send an OpenAI, Anthropic or OpenRouter key here.</span></li>
            </ul>
          </div>
        </div>
      </section>

      <section className="ag-sec">
        <div className="sec-head"><h2>Machine <em>files</em></h2><span className="ln" /></div>
        <div className="files">
          {FILES.map((f) => (
            <a className="file" key={f.nm} href={f.nm}>
              <span className="ic">↓</span>
              <span><span className="nm">{f.nm}</span><div className="ds">{f.ds}</div></span>
              <span className="ar">→</span>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
