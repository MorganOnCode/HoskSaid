import "../agents.css";
import manifest from "@/lib/contracts/mcp.json";
import { CopyInline } from "@/components/CopyInline";

export const metadata = { title: "Agents — MCP & API" };

const BASE = process.env.PUBLIC_BASE_URL || "https://thehosksaid.com";

const REST = [
  { m: "POST", p: "/api/ask", d: "Synthesized, citation-backed answer." },
  { m: "GET", p: "/api/search?q=", d: "Raw semantic search over segments." },
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
        <div className="sec-head"><h2>MCP <em>tools</em></h2><span className="ln" /><span className="more">{manifest.tools.length} READ-ONLY</span></div>
        <p className="intro">All tools are read-only and return JSON. <code>search_archive</code> returns the same shape as <code>POST /api/ask</code> — an answer with <code>citations[]</code> and <code>sources[]</code>.</p>
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
              <li><span className="dot">◆</span><span>Read-only access to every tool &amp; endpoint.</span></li>
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
