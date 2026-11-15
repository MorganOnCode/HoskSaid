import { parseArgs } from "../args";
import { emit, emitHelp, RUN, type Command } from "../runtime";
import { sql } from "../../lib/db";
import { migrationStatus } from "../../lib/migrations";
import { usageToday } from "../../lib/usage";

/** Live state for the no-argument home view. Never throws: reports what it can. */
export async function homeSummary(): Promise<Record<string, unknown>> {
  if (!process.env.DATABASE_URL) {
    return { database: "not configured", help: ["Set DATABASE_URL (or .env) to see live state"] };
  }
  try {
    const status = await migrationStatus(sql);
    const pending = status.filter((m) => m.state !== "applied").length;
    const out: Record<string, unknown> = { migrations: pending ? `${pending} pending or modified of ${status.length}` : `all ${status.length} applied` };
    const has = async (table: string) => (await sql`SELECT to_regclass(${table}) AS t`)[0].t !== null;
    if (await has("public.posts")) {
      const rows = await sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM posts GROUP BY status`;
      out.posts = rows.length ? rows.map((r) => `${r.n} ${r.status}`).join(", ") : "none";
    }
    if (await has("public.newsletter_issues")) {
      const rows = await sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM newsletter_issues GROUP BY status`;
      out.newsletter_issues = rows.length ? rows.map((r) => `${r.n} ${r.status}`).join(", ") : "none";
      const [s] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM subscribers WHERE status = 'confirmed'`;
      out.confirmed_subscribers = s.n;
    }
    if (await has("public.site_usage_daily")) {
      const u = await usageToday();
      out.site_calls_today = `answers ${u.answer.used}/${u.answer.cap}, embeddings ${u.embedding.used}/${u.embedding.cap}`;
    }
    return out;
  } catch (e) {
    return { database: "unreachable", detail: e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : "unknown" };
  }
}

const COVERAGE_USAGE = `${RUN} coverage [--price-per-mtok <usd>]
Read-only report of what Ask can and cannot see, plus an estimate for embedding
the videos that have no chunks. The price defaults to text-embedding-3-small's
list price of $0.02 per million tokens; re-check current pricing before approving.
example:
  ${RUN} coverage --price-per-mtok 0.02`;

export const coverageCommand: Command = {
  name: "coverage",
  summary: "Read-only archive coverage report and costed embedding-backfill estimate",
  usage: COVERAGE_USAGE,
  async run(argv) {
    const { flags } = parseArgs(argv, { "price-per-mtok": "string" }, COVERAGE_USAGE);
    if (flags.help) {
      emit({ usage: COVERAGE_USAGE });
      return 0;
    }
    const price = flags["price-per-mtok"] === undefined ? 0.02 : Number(flags["price-per-mtok"]);
    if (!Number.isFinite(price) || price < 0) {
      emit({ error: "--price-per-mtok must be a non-negative number", help: COVERAGE_USAGE });
      return 2;
    }
    const [c] = await sql<Record<string, number>[]>`
      WITH v AS (SELECT id FROM videos WHERE status = 'completed'),
      chunked AS (SELECT DISTINCT video_id FROM transcript_chunks WHERE video_id IN (SELECT id FROM v))
      SELECT
        (SELECT count(*)::int FROM v) AS completed_videos,
        (SELECT count(*)::int FROM chunked) AS ask_searchable_videos,
        (SELECT count(*)::int FROM transcript_chunks) AS chunks,
        (SELECT count(*)::int FROM transcript_chunks WHERE start_time IS NOT NULL) AS timed_chunks,
        (SELECT count(*)::int FROM transcripts t JOIN v ON v.id = t.video_id WHERE t.summary IS NULL OR t.summary = '') AS videos_without_summary,
        (SELECT count(*)::int FROM transcripts t JOIN v ON v.id = t.video_id WHERE t.cleaned_text IS NULL OR t.cleaned_text = t.raw_text) AS uncleaned_transcripts,
        (SELECT count(*)::int FROM transcript_chunks WHERE content ~ '&(amp;)?#?[a-z0-9]+;') AS entity_escaped_chunks,
        (SELECT count(DISTINCT video_id)::int FROM video_topics) AS topic_assigned_videos,
        (SELECT count(*)::int FROM videos WHERE status = 'completed' AND video_type IS NOT NULL) AS typed_videos,
        (SELECT COALESCE(sum(char_length(COALESCE(t.cleaned_text, t.raw_text, ''))), 0)::bigint FROM transcripts t
           JOIN v ON v.id = t.video_id WHERE t.video_id NOT IN (SELECT video_id FROM chunked)) AS unchunked_chars
    `;
    const chars = Number(c.unchunked_chars);
    const keywordOnly = c.completed_videos - c.ask_searchable_videos;
    // generate-embeddings windows untimed text into 1000-char chunks with 100 overlap.
    const estChunks = Math.ceil(chars / 900);
    const estTokens = Math.ceil((chars * (1000 / 900)) / 4);
    emit({
      coverage: { ...c, unchunked_chars: undefined, keyword_only_videos: keywordOnly },
      backfill_estimate: {
        videos: keywordOnly,
        transcript_chars: chars,
        est_chunks: estChunks,
        est_embedding_tokens: estTokens,
        price_per_mtok_usd: price,
        est_cost_usd: Math.round(((estTokens / 1_000_000) * price) * 10000) / 10000,
        basis: "chars/4 tokens incl. 10% chunk overlap; embedding only, no enrichment",
      },
    });
    emitHelp(keywordOnly ? [`Dry run (no API calls): npx tsx src/scripts/generate-embeddings.ts --dry-run --limit=${keywordOnly}`] : []);
    return 0;
  },
};

const USAGE_USAGE = `${RUN} usage    today's site-funded model calls against the daily caps (UTC day)`;

export const usageCommand: Command = {
  name: "usage",
  summary: "Today's site-funded call counts vs SITE_DAILY_*_CAP",
  usage: USAGE_USAGE,
  async run(argv) {
    const { flags } = parseArgs(argv, {}, USAGE_USAGE);
    if (flags.help) {
      emit({ usage: USAGE_USAGE });
      return 0;
    }
    const u = await usageToday();
    emit({ day_utc: new Date().toISOString().slice(0, 10), answers: u.answer, embeddings: u.embedding });
    return 0;
  },
};
