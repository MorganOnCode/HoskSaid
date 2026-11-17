/**
 * Post rendering shared by the blog pages, the RSS feed and the operator CLI.
 * Post text is plain text; everything is escaped here. Links are built only
 * from validated YouTube ids and integer seconds taken from the database.
 */
import { formatTimecode } from "../format";
import { monthLabel } from "../digest/period";
import { YOUTUBE_ID_RE, type Post, type PostCoverage, type PostParagraph, type PostSource, type PublicPost } from "../posts";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface CiteLink {
  id: string;
  /** "3" or "3 · 12:34" */
  label: string;
  /** Site video page (with ?t= for a timed moment), absolute when `base` is given. */
  href: string;
  /** The same moment on YouTube. */
  youtube: string;
  title: string;
}

const validSeconds = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

export function videoHref(videoId: string, base = "", seconds?: number): string {
  return `${base}/video/${encodeURIComponent(videoId)}${seconds !== undefined ? `?t=${seconds}` : ""}`;
}

export function youtubeHref(videoId: string, seconds?: number): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}${seconds !== undefined ? `&t=${seconds}s` : ""}`;
}

export function resolveCite(id: string, sources: PostSource[], base = ""): CiteLink | null {
  const [vid, moment] = id.split(".");
  const s = sources.find((x) => x.id === vid);
  if (!s || !YOUTUBE_ID_RE.test(s.video_id)) return null;
  const n = vid.slice(1);
  if (moment) {
    const m = s.moments.find((x) => x.id === id);
    if (!m || !validSeconds(m.start_seconds)) return null;
    return {
      id,
      label: `${n} · ${formatTimecode(m.start_seconds)}`,
      href: videoHref(s.video_id, base, m.start_seconds),
      youtube: youtubeHref(s.video_id, m.start_seconds),
      title: s.title,
    };
  }
  return { id, label: n, href: videoHref(s.video_id, base), youtube: youtubeHref(s.video_id), title: s.title };
}

export function postPeriodLabel(post: Pick<Post, "period">): string {
  return monthLabel(post.period);
}

const REASON: Record<string, string> = {
  not_processed: "not processed yet",
  no_text: "no transcript or summary stored",
  model_failed: "drafting failed",
  no_grounded_notes: "no statement passed the source check",
  not_attempted: "not drafted (budget)",
};

export function missingReason(r: string): string {
  return REASON[r] ?? r;
}

/** One honest sentence about what the post covers. */
export function coverageSentence(c: PostCoverage, period: string): string {
  const month = monthLabel(period);
  const zone = c.timezone === "UTC" ? "UTC" : c.timezone;
  if (c.complete) return `Covers all ${c.videos_covered} video${c.videos_covered === 1 ? "" : "s"} published in ${month} (${zone}).`;
  return `Covers ${c.videos_covered} of ${c.videos_in_period} videos published in ${month} (${zone}); ${c.missing.length} not included.`;
}

function citesText(p: PostParagraph, sources: PostSource[], base: string): string {
  return p.cites
    .map((c) => resolveCite(c, sources, base))
    .filter((c): c is CiteLink => !!c)
    .map((c) => `[${c.label}]`)
    .join(" ");
}

/** Plain-text rendering (CLI preview). */
export function postText(post: PublicPost, base: string): string {
  const lines: string[] = [post.title, "=".repeat(Math.min(post.title.length, 72))];
  if (post.dek) lines.push("", post.dek);
  lines.push("", coverageSentence(post.coverage, post.period));
  for (const p of post.body.intro) lines.push("", `${p.text} ${citesText(p, post.sources, base)}`);
  for (const s of post.body.sections) {
    lines.push("", s.heading, "-".repeat(Math.min(s.heading.length, 72)));
    for (const p of s.paragraphs) lines.push("", `${p.text} ${citesText(p, post.sources, base)}`);
  }
  if (post.coverage.missing.length) {
    lines.push("", "Not included");
    for (const m of post.coverage.missing) lines.push(`- ${m.title} (${missingReason(m.reason)}) ${youtubeHref(m.video_id)}`);
  }
  lines.push("", "Sources");
  for (const s of post.sources) {
    const n = s.id.slice(1);
    lines.push(`[${n}] ${s.title} (${s.published_at.slice(0, 10)}) ${videoHref(s.video_id, base)}`);
    for (const m of s.moments) {
      const c = resolveCite(m.id, post.sources, base);
      if (c) lines.push(`    [${c.label}] ${c.href}`);
    }
  }
  return lines.join("\n");
}

function paraHtml(p: PostParagraph, sources: PostSource[], base: string): string {
  const cites = p.cites
    .map((c) => resolveCite(c, sources, base))
    .filter((c): c is CiteLink => !!c)
    .map((c) => `<a href="${escapeHtml(c.href)}" title="${escapeHtml(c.title)}">[${escapeHtml(c.label)}]</a>`)
    .join(" ");
  return `<p>${escapeHtml(p.text)} ${cites}</p>`;
}

/** HTML fragment for the RSS feed's content:encoded, with absolute links. */
export function postFeedHtml(post: PublicPost, base: string): string {
  const parts: string[] = [];
  if (post.dek) parts.push(`<p><em>${escapeHtml(post.dek)}</em></p>`);
  parts.push(`<p><small>${escapeHtml(coverageSentence(post.coverage, post.period))}</small></p>`);
  for (const p of post.body.intro) parts.push(paraHtml(p, post.sources, base));
  for (const s of post.body.sections) {
    parts.push(`<h3>${escapeHtml(s.heading)}</h3>`);
    for (const p of s.paragraphs) parts.push(paraHtml(p, post.sources, base));
  }
  parts.push("<h3>Sources</h3><ol>");
  for (const s of post.sources) {
    if (!YOUTUBE_ID_RE.test(s.video_id)) continue;
    parts.push(`<li><a href="${escapeHtml(videoHref(s.video_id, base))}">${escapeHtml(s.title)}</a> · ${escapeHtml(s.published_at.slice(0, 10))} · <a href="${escapeHtml(youtubeHref(s.video_id))}">YouTube</a></li>`);
  }
  parts.push("</ol>");
  return parts.join("\n");
}

/**
 * Standalone review page for the operator: the draft, each paragraph's cited
 * evidence, coverage, and statements the evidence check rejected. Private:
 * written to a local file by the CLI, never served by the site.
 */
export function postReviewHtml(post: Post, base: string): string {
  const e = escapeHtml;
  const para = (p: PostParagraph) => {
    const ev = p.cites
      .map((c) => {
        const [vid] = c.split(".");
        const s = post.sources.find((x) => x.id === vid);
        if (!s) return `<li><b>${e(c)}</b>: missing source</li>`;
        const m = c.includes(".") ? s.moments.find((x) => x.id === c) : null;
        const link = resolveCite(c, post.sources, base);
        const text = m ? m.excerpt : [s.summary ?? "", ...s.excerpts].filter(Boolean).join(" … ") || "(timed excerpts only)";
        return `<li><b>${e(c)}</b> <a href="${e(link?.href ?? "#")}">${e(s.title)}${m ? ` @ ${e(formatTimecode(m.start_seconds))}` : ""}</a><br><span class="ev">${e(text.slice(0, 1200))}</span></li>`;
      })
      .join("");
    return `<div class="para"><p>${e(p.text)} <code>${e(p.cites.join(" "))}</code></p><details><summary>evidence</summary><ul>${ev}</ul></details></div>`;
  };
  const c = post.coverage;
  const g = post.generation;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review ${e(post.period)} r${post.revision}</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1a1d24;background:#fff}code{font-size:12px;color:#3a6fd8}
.ev{color:#4c515c;font-size:14px}.para{border-left:3px solid #e3e5ea;padding-left:12px;margin:12px 0}.warn{background:#fff4d6;padding:8px 12px;border-radius:6px}
table{border-collapse:collapse;font-size:14px}td,th{border:1px solid #e3e5ea;padding:4px 8px;text-align:left}</style></head><body>
<p><b>PRIVATE REVIEW</b> · ${e(post.period)} · status ${e(post.status)} · revision ${post.revision} · ${e(g.model)} · prompt ${e(g.prompt_version)} · cutoff ${e(g.ingestion_cutoff ?? "n/a")}</p>
<p class="${c.complete ? "" : "warn"}">${e(coverageSentence(c, post.period))} Window ${e(c.period_start)} to ${e(c.period_end)} (exclusive).</p>
${c.missing.length ? `<h3>Not included</h3><table><tr><th>video</th><th>reason</th></tr>${c.missing.map((m) => `<tr><td><a href="${e(youtubeHref(m.video_id))}">${e(m.title)}</a></td><td>${e(missingReason(m.reason))}</td></tr>`).join("")}</table>` : ""}
${c.sampled.length ? `<h3>Sampled transcripts</h3><table><tr><th>video</th><th>chars used / total</th></tr>${c.sampled.map((s) => `<tr><td>${e(s.video_id)}</td><td>${s.chars_used} / ${s.chars_total}</td></tr>`).join("")}</table>` : ""}
<p>Calls: notes ${g.calls.notes}, reduce ${g.calls.reduce}, final ${g.calls.final}; cached videos ${g.calls.cached_videos}. ${g.deterministic_section ? `“Also this month” lists videos the synthesis did not cite, using their own notes.` : ""}</p>
<hr><h1>${e(post.title)}</h1>${post.dek ? `<p><i>${e(post.dek)}</i></p>` : ""}
${post.body.intro.map(para).join("")}
${post.body.sections.map((s) => `<h2>${e(s.heading)}</h2>${s.paragraphs.map(para).join("")}`).join("")}
<hr><h3>Rejected by citation/evidence checks (${g.rejected_total})</h3>
${g.rejected.length ? `<table><tr><th>stage</th><th>text</th><th>cites</th><th>reason</th></tr>${g.rejected.map((r) => `<tr><td>${e(r.stage)}</td><td>${e(r.text)}</td><td>${e(r.cites.join(" "))}</td><td>${e(r.reason)}</td></tr>`).join("")}</table>` : "<p>none</p>"}
<p class="ev">The evidence check is lexical (numbers, names and wording must appear in the cited text). It catches invented specifics, not every distortion: read the evidence.</p>
</body></html>
`;
}
