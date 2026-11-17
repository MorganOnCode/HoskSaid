import { listPublishedPosts } from "@/lib/posts";
import { escapeHtml, postFeedHtml } from "@/lib/render/post";

export const dynamic = "force-dynamic";

/** Keep CDATA intact even if text contains its terminator. */
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

/** GET /blog/feed.xml — RSS 2.0 of published monthly posts only. */
export async function GET() {
  const base = process.env.PUBLIC_BASE_URL || "https://thehosksaid.com";
  const posts = await listPublishedPosts(24).catch(() => []);
  const items = posts.map(
    (p) => `    <item>
      <title>${escapeHtml(p.title)}</title>
      <link>${escapeHtml(`${base}/blog/${p.slug}`)}</link>
      <guid isPermaLink="true">${escapeHtml(`${base}/blog/${p.slug}`)}</guid>
      <pubDate>${new Date(p.published_at ?? Date.now()).toUTCString()}</pubDate>
${p.dek ? `      <description>${escapeHtml(p.dek)}</description>\n` : ""}      <content:encoded>${cdata(postFeedHtml(p, base))}</content:encoded>
    </item>`
  );
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>thehosksaid: monthly digest</title>
    <link>${escapeHtml(`${base}/blog`)}</link>
    <atom:link href="${escapeHtml(`${base}/blog/feed.xml`)}" rel="self" type="application/rss+xml" />
    <description>Monthly, source-linked digests of Charles Hoskinson's public videos. Independent; not affiliated with IOG, the Cardano Foundation or Charles Hoskinson.</description>
${items.join("\n")}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
