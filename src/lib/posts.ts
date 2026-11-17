/**
 * Monthly posts: types, strict validation and data access (server-only).
 *
 * A post body is structured data, never HTML: paragraphs of plain text, each
 * citing source ids. Rendering escapes everything, so model output cannot
 * inject markup. Public routes read only `published` posts
 * and only public columns; generation metadata never leaves the operator CLI.
 */
import { sql } from "./db";

export type PostStatus = "draft" | "published" | "withdrawn";

export interface PostParagraph {
  text: string;
  /** Source ids: "S3" (a whole video) or "S3.2" (a timed moment in it). */
  cites: string[];
}

export interface PostSection {
  heading: string;
  paragraphs: PostParagraph[];
}

export interface PostBody {
  intro: PostParagraph[];
  sections: PostSection[];
}

export interface PostMoment {
  id: string;
  segment_id: string;
  start_seconds: number;
  excerpt: string;
}

export interface PostSource {
  id: string;
  video_id: string; // youtube id
  title: string;
  published_at: string;
  /** Stored ingestion summary used as evidence (AI-generated at ingestion). */
  summary: string | null;
  /** Untimed transcript excerpts used as evidence when no timed moments exist. */
  excerpts: string[];
  moments: PostMoment[];
}

export type MissingReason = "not_processed" | "no_text" | "model_failed" | "no_grounded_notes" | "not_attempted";

/** Public-safe completeness summary shown with the post. */
export interface PostCoverage {
  timezone: string;
  period_start: string;
  period_end: string;
  /** Every video published in the window, whatever its processing state. */
  videos_in_period: number;
  /** Videos that this post summarises and cites. */
  videos_covered: number;
  missing: { video_id: string; title: string; reason: MissingReason }[];
  /** Videos whose transcript was sampled rather than read in full. */
  sampled: { video_id: string; chars_used: number; chars_total: number }[];
  complete: boolean;
}

export interface RejectedStatement {
  stage: "notes" | "reduce" | "final";
  text: string;
  cites: string[];
  reason: string;
}

/** Private generation record (operator CLI only). */
export interface PostGeneration {
  provider: string;
  model: string;
  prompt_version: string;
  generated_at: string;
  trigger: "cli" | "schedule";
  ingestion_cutoff: string | null;
  limits: Record<string, unknown>;
  calls: { notes: number; reduce: number; final: number; cached_videos: number };
  rejected: RejectedStatement[];
  rejected_total: number;
  deterministic_section: boolean;
}

export interface Post {
  id: string;
  kind: "monthly";
  period: string;
  slug: string;
  status: PostStatus;
  revision: number;
  title: string;
  dek: string | null;
  body: PostBody;
  sources: PostSource[];
  coverage: PostCoverage;
  generation: PostGeneration;
  input_hash: string;
  published_at: string | null;
  published_by: string | null;
  withdrawn_at: string | null;
  withdrawn_by: string | null;
  created_at: string;
  updated_at: string;
}

/** What public pages may see. */
export type PublicPost = Pick<Post, "id" | "period" | "slug" | "title" | "dek" | "body" | "sources" | "coverage" | "published_at">;

export const LIMITS = {
  title: 140,
  dek: 300,
  heading: 120,
  paragraph: 1500,
  sections: 12,
  paragraphsPerSection: 40,
  intro: 4,
  citesPerParagraph: 12,
} as const;

export const CITE_RE = /^S\d{1,3}(\.\d{1,3})?$/;
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const OPERATOR_RE = /^[A-Za-z0-9][A-Za-z0-9._@ -]{0,79}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function allSourceIds(sources: PostSource[]): Set<string> {
  const ids = new Set<string>();
  for (const s of sources) {
    ids.add(s.id);
    for (const m of s.moments) ids.add(m.id);
  }
  return ids;
}

export function allParagraphs(body: PostBody): PostParagraph[] {
  return [...body.intro, ...body.sections.flatMap((s) => s.paragraphs)];
}

export function paragraphCount(body: PostBody): number {
  return allParagraphs(body).length;
}

/** Video-level ids cited anywhere in the body. */
export function citedVideoIds(body: PostBody): Set<string> {
  const out = new Set<string>();
  for (const p of allParagraphs(body)) for (const c of p.cites) out.add(c.split(".")[0]);
  return out;
}

// ---------------------------------------------------------------- strict validation

export interface PostContent {
  title: string;
  dek: string | null;
  body: PostBody;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function checkKeys(o: Obj, allowed: string[], path: string, errors: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${path}: unknown field "${k}"`);
}

function checkText(v: unknown, max: number, path: string, errors: string[], opts: { nullable?: boolean } = {}): string | null {
  if (v === null && opts.nullable) return null;
  if (typeof v !== "string") {
    errors.push(`${path}: must be a string${opts.nullable ? " or null" : ""}`);
    return null;
  }
  const t = v.trim();
  if (!t) {
    if (opts.nullable) return null;
    errors.push(`${path}: must not be empty`);
    return null;
  }
  if (CONTROL_RE.test(t)) errors.push(`${path}: contains control characters or line breaks`);
  if (t.length > max) errors.push(`${path}: ${t.length} characters exceeds the ${max} limit`);
  return t;
}

function checkParagraph(v: unknown, ids: Set<string>, path: string, errors: string[]): PostParagraph | null {
  if (!isObj(v)) {
    errors.push(`${path}: must be an object {text, cites}`);
    return null;
  }
  checkKeys(v, ["text", "cites"], path, errors);
  const text = checkText(v.text, LIMITS.paragraph, `${path}.text`, errors);
  if (!Array.isArray(v.cites) || v.cites.length === 0) {
    errors.push(`${path}.cites: must be a non-empty array of source ids`);
    return null;
  }
  if (v.cites.length > LIMITS.citesPerParagraph) errors.push(`${path}.cites: more than ${LIMITS.citesPerParagraph} citations`);
  const cites: string[] = [];
  v.cites.forEach((c, i) => {
    if (typeof c !== "string" || !CITE_RE.test(c)) errors.push(`${path}.cites[${i}]: "${String(c).slice(0, 20)}" is not a source id like S3 or S3.2`);
    else if (!ids.has(c)) errors.push(`${path}.cites[${i}]: ${c} is not one of this post's sources`);
    else if (cites.includes(c)) errors.push(`${path}.cites[${i}]: duplicate ${c}`);
    else cites.push(c);
  });
  return text ? { text, cites } : null;
}

/**
 * Validate post content against the post's own sources. Every problem is
 * reported; nothing is trimmed, truncated or dropped to make content fit.
 */
export function validatePostContent(raw: unknown, sources: PostSource[]): { ok: true; content: PostContent } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["post content must be an object {title, dek, body}"] };
  checkKeys(raw, ["title", "dek", "body"], "post", errors);
  for (const k of ["title", "dek", "body"]) if (!(k in raw)) errors.push(`post: missing field "${k}"`);
  const ids = allSourceIds(sources);
  const title = checkText(raw.title, LIMITS.title, "title", errors);
  const dek = checkText(raw.dek, LIMITS.dek, "dek", errors, { nullable: true });
  const body: PostBody = { intro: [], sections: [] };
  if (!isObj(raw.body)) errors.push("body: must be an object {intro, sections}");
  else {
    checkKeys(raw.body, ["intro", "sections"], "body", errors);
    const { intro, sections } = raw.body;
    if (!Array.isArray(intro)) errors.push("body.intro: must be an array");
    else {
      if (intro.length > LIMITS.intro) errors.push(`body.intro: ${intro.length} paragraphs exceeds the ${LIMITS.intro} limit`);
      intro.forEach((p, i) => {
        const v = checkParagraph(p, ids, `body.intro[${i}]`, errors);
        if (v) body.intro.push(v);
      });
    }
    if (!Array.isArray(sections)) errors.push("body.sections: must be an array");
    else {
      if (sections.length > LIMITS.sections) errors.push(`body.sections: ${sections.length} sections exceeds the ${LIMITS.sections} limit`);
      sections.forEach((s, i) => {
        const path = `body.sections[${i}]`;
        if (!isObj(s)) {
          errors.push(`${path}: must be an object {heading, paragraphs}`);
          return;
        }
        checkKeys(s, ["heading", "paragraphs"], path, errors);
        const heading = checkText(s.heading, LIMITS.heading, `${path}.heading`, errors);
        if (!Array.isArray(s.paragraphs) || !s.paragraphs.length) {
          errors.push(`${path}.paragraphs: must be a non-empty array`);
          return;
        }
        if (s.paragraphs.length > LIMITS.paragraphsPerSection) {
          errors.push(`${path}.paragraphs: ${s.paragraphs.length} paragraphs exceeds the ${LIMITS.paragraphsPerSection} limit`);
        }
        const paragraphs: PostParagraph[] = [];
        s.paragraphs.forEach((p, j) => {
          const v = checkParagraph(p, ids, `${path}.paragraphs[${j}]`, errors);
          if (v) paragraphs.push(v);
        });
        if (heading) body.sections.push({ heading, paragraphs });
      });
    }
    if (Array.isArray(intro) && Array.isArray(sections) && intro.length + sections.length === 0) errors.push("body: has no paragraphs");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, content: { title: title!, dek, body } };
}

/** Evidence text for a citation: a moment's excerpt, or every excerpt of a video. */
export function evidenceFor(cites: string[], sources: PostSource[]): string[] {
  const out: string[] = [];
  for (const c of cites) {
    const [vid] = c.split(".");
    const s = sources.find((x) => x.id === vid);
    if (!s) continue;
    if (c.includes(".")) {
      const m = s.moments.find((x) => x.id === c);
      if (m) out.push(m.excerpt);
    } else {
      out.push(s.title, s.summary ?? "", ...s.excerpts, ...s.moments.map((m) => m.excerpt));
    }
  }
  return out;
}

// ---------------------------------------------------------------- queries

const json = <T,>(v: T) => sql.json(v as unknown as Parameters<typeof sql.json>[0]);

export async function getPostByPeriod(period: string): Promise<Post | null> {
  const rows = await sql<Post[]>`SELECT * FROM posts WHERE kind = 'monthly' AND period = ${period} LIMIT 1`;
  return rows[0] ?? null;
}

export async function listPosts(status?: PostStatus): Promise<Post[]> {
  return await sql<Post[]>`
    SELECT * FROM posts ${status ? sql`WHERE status = ${status}` : sql``}
    ORDER BY period DESC
  `;
}

/** Public: published posts, public columns only. */
export async function listPublishedPosts(limit = 50): Promise<PublicPost[]> {
  return await sql<PublicPost[]>`
    SELECT id, period, slug, title, dek, body, sources, coverage, published_at
    FROM posts WHERE status = 'published' ORDER BY period DESC LIMIT ${limit}
  `;
}

/** Public: one published post by slug (drafts and withdrawn posts are a 404). */
export async function getPublishedPost(slug: string): Promise<PublicPost | null> {
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(slug)) return null;
  const rows = await sql<PublicPost[]>`
    SELECT id, period, slug, title, dek, body, sources, coverage, published_at
    FROM posts WHERE slug = ${slug} AND status = 'published' LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function postEvents(postId: string): Promise<{ action: string; actor: string; revision: number; at: string }[]> {
  return await sql`SELECT action, actor, revision, at FROM post_events WHERE post_id = ${postId} ORDER BY at, id`;
}

// ---------------------------------------------------------------- operator transitions

export type TransitionResult =
  | { changed: true; post: Post }
  | { changed: false; post: Post | null; reason: "not_found" | "already_published" | "already_withdrawn" | "revision_mismatch" | "incomplete" | "wrong_status" };

/**
 * draft|withdrawn -> published. The operator names the revision they reviewed;
 * a draft that changed since then is not published. An incomplete month needs
 * `acceptIncomplete`. Idempotent when that revision is already published.
 */
export async function publishPost(period: string, opts: { by: string; revision: number; acceptIncomplete?: boolean }): Promise<TransitionResult> {
  return await sql.begin(async (tx) => {
    const [post] = await tx<Post[]>`SELECT * FROM posts WHERE kind = 'monthly' AND period = ${period} FOR UPDATE`;
    if (!post) return { changed: false, post: null, reason: "not_found" } as const;
    if (post.revision !== opts.revision) return { changed: false, post, reason: "revision_mismatch" } as const;
    if (post.status === "published") return { changed: false, post, reason: "already_published" } as const;
    if (!post.coverage.complete && !opts.acceptIncomplete) return { changed: false, post, reason: "incomplete" } as const;
    const [updated] = await tx<Post[]>`
      UPDATE posts SET status = 'published', published_at = now(), published_by = ${opts.by}, updated_at = now()
      WHERE id = ${post.id} RETURNING *
    `;
    await tx`INSERT INTO post_events (post_id, action, actor, revision, detail)
             VALUES (${post.id}, 'published', ${opts.by}, ${post.revision}, ${json({ accept_incomplete: !post.coverage.complete })})`;
    return { changed: true, post: updated } as const;
  });
}

/** published -> withdrawn (kept, no longer public). Idempotent. */
export async function withdrawPost(period: string, by: string): Promise<TransitionResult> {
  return await sql.begin(async (tx) => {
    const [post] = await tx<Post[]>`SELECT * FROM posts WHERE kind = 'monthly' AND period = ${period} FOR UPDATE`;
    if (!post) return { changed: false, post: null, reason: "not_found" } as const;
    if (post.status === "withdrawn") return { changed: false, post, reason: "already_withdrawn" } as const;
    if (post.status !== "published") return { changed: false, post, reason: "wrong_status" } as const;
    const [updated] = await tx<Post[]>`
      UPDATE posts SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = ${by}, updated_at = now()
      WHERE id = ${post.id} RETURNING *
    `;
    await tx`INSERT INTO post_events (post_id, action, actor, revision) VALUES (${post.id}, 'withdrawn', ${by}, ${post.revision})`;
    return { changed: true, post: updated } as const;
  });
}
