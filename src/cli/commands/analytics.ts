import { parseArgs } from "../args";
import { CliError, emit, emitHelp, RUN, type Command } from "../runtime";
import { sql } from "../../lib/db";
import { METHOD } from "../../lib/analytics/method";
import { refreshAnalytics, RefreshError } from "../../lib/analytics/refresh";
import { getSnapshotStatus } from "../../lib/analytics/data";

const USAGE = `${RUN} analytics [status]                          show the published /analytics rankings snapshot
${RUN} analytics refresh [--dry-run] [--max-rss-mb <n>] [--max-phrase-candidates <n>]
    recompute phrase/keyword rankings from transcripts and publish one snapshot
    (reads transcripts only; writes only analytics_snapshots/analytics_rankings; no model calls)
flags (refresh):
  --dry-run                    compute and report, write nothing
  --max-rss-mb <n>             abort, writing nothing, above this process RSS (default 768)
  --max-phrase-candidates <n>  abort, writing nothing, above this many exact phrase counters (default 400000)
examples:
  ${RUN} analytics
  ${RUN} analytics refresh --dry-run
  ${RUN} analytics refresh --max-rss-mb 512`;

const posInt = (v: unknown, flag: string, def: number): number => {
  if (v === undefined) return def;
  if (typeof v !== "string" || !/^\d+$/.test(v) || parseInt(v, 10) < 1) throw new CliError(`--${flag} must be a positive integer`, USAGE, 2);
  return parseInt(v, 10);
};

async function status(): Promise<number> {
  const [{ t }] = await sql<{ t: string | null }[]>`SELECT to_regclass('public.analytics_snapshots')::text AS t`;
  if (!t) {
    emit({ analytics: "tables missing (migration 010 not applied)" });
    emitHelp([`Run \`${RUN} migrate apply\`, then \`${RUN} analytics refresh\``]);
    return 0;
  }
  const st = await getSnapshotStatus();
  if (st.state === "missing") {
    emit({ analytics: "no rankings snapshot published; /analytics says rankings are not computed (queries still work)" });
    emitHelp([`Run \`${RUN} analytics refresh --dry-run\` to measure, then \`${RUN} analytics refresh\``]);
    return 0;
  }
  const snap = st.snapshot;
  const [{ rows }] = await sql<{ rows: number }[]>`SELECT count(*)::int AS rows FROM analytics_rankings WHERE snapshot_id = ${snap.id}`;
  const stale =
    st.state === "outdated_method" ? `method ${snap.method} != current ${METHOD}`
    : st.state === "stale" && st.reason === "video_count" ? `archive now has ${st.current_videos} rankable transcripts (snapshot counted ${snap.videos_computed})`
    : st.state === "stale" ? "transcripts updated since the snapshot"
    : "no";
  const yrs = snap.years.map((y) => y.year);
  emit({
    snapshot: {
      id: snap.id,
      method: snap.method,
      generated_at: new Date(snap.generated_at).toISOString(),
      videos: snap.videos_computed,
      words: Number(snap.words_computed),
      years: yrs.length ? `${yrs[0]}-${yrs[yrs.length - 1]} (${yrs.length})` : "none",
      rows,
      stale,
    },
  });
  emitHelp(stale !== "no" ? [`Run \`${RUN} analytics refresh\` to recompute`] : []);
  return 0;
}

export const analyticsCommand: Command = {
  name: "analytics",
  summary: "Show or refresh the /analytics phrase and keyword rankings snapshot (no model calls)",
  usage: USAGE,
  async run(argv) {
    const { positionals, flags } = parseArgs(
      argv,
      { "dry-run": "boolean", "max-rss-mb": "string", "max-phrase-candidates": "string" },
      USAGE
    );
    if (flags.help) {
      emit({ usage: USAGE });
      return 0;
    }
    const sub = positionals[0] ?? "status";
    if (positionals.length > 1) {
      emit({ error: `unexpected argument ${positionals[1]}`, help: USAGE });
      return 2;
    }
    if (sub === "status") {
      if (Object.keys(flags).length) {
        emit({ error: "--dry-run, --max-rss-mb and --max-phrase-candidates apply only to `analytics refresh`", help: USAGE });
        return 2;
      }
      return status();
    }
    if (sub !== "refresh") {
      emit({ error: `unknown analytics subcommand ${sub}`, help: USAGE });
      return 2;
    }
    const maxRssMb = posInt(flags["max-rss-mb"], "max-rss-mb", 768);
    const maxPhraseCandidates = posInt(flags["max-phrase-candidates"], "max-phrase-candidates", 400_000);
    try {
      const r = await refreshAnalytics(sql, {
        dryRun: !!flags["dry-run"],
        maxRssMb,
        maxPhraseCandidates,
        progress: (m) => process.stderr.write(`${m}\n`),
      });
      const yrs = r.years.map((y) => y.year);
      emit({
        refresh: r.published ? `published snapshot ${r.snapshot_id}` : "dry run (nothing written)",
        method: r.method,
        videos: r.videos,
        words: r.words,
        years: yrs.length ? `${yrs[0]}-${yrs[yrs.length - 1]} (${yrs.length})` : "none",
        keywords_tracked: r.keywords_tracked,
        phrase_candidates: r.phrase_candidates,
        ranking_rows: r.rows,
        measured: r.measured,
      });
      emitHelp(r.published ? [`Run \`${RUN} analytics\` to check the published snapshot`] : [`Run \`${RUN} analytics refresh\` to publish`]);
      return 0;
    } catch (e) {
      if (e instanceof RefreshError) throw new CliError(e.message, e.help, 1);
      throw e;
    }
  },
};
