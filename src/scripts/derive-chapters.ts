#!/usr/bin/env npx tsx
/**
 * Derive chapter markers for videos from their timed transcript segments.
 * Feeds a downsampled [mm:ss] timeline to gpt-4o-mini and stores the result in
 * videos.chapters ([{t_seconds, title}]). No YouTube access — runs on the VPS.
 *
 *   npx tsx src/scripts/derive-chapters.ts --limit=50 [--force] [--video=<uuid>]
 */
import { config } from "dotenv";
config();

import { sql } from "../lib/db";
import { getClient } from "../lib/llm";

const getArg = (n: string): string | null => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : null;
};
const hasFlag = (n: string) => process.argv.includes(`--${n}`);

interface TimedSegment { text: string; offset: number; duration: number }

function normalizeSegments(value: unknown): TimedSegment[] | null {
  let segs: unknown = value;
  if (typeof segs === "string") { try { segs = JSON.parse(segs); } catch { return null; } }
  return Array.isArray(segs) && segs.length ? (segs as TimedSegment[]) : null;
}

function fmt(s: number): string {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + ":" + String(x).padStart(2, "0");
}

async function deriveChapters() {
  const limit = parseInt(getArg("limit") || "20", 10);
  const force = hasFlag("force");
  const videoArg = getArg("video");

  const videos = await sql<{ id: string; title: string }[]>`
    SELECT v.id, v.title
    FROM videos v
    JOIN transcripts t ON t.video_id = v.id AND t.segments IS NOT NULL
    WHERE v.status = 'completed'
      ${videoArg ? sql`AND v.id = ${videoArg}` : sql``}
      ${force ? sql`` : sql`AND v.chapters IS NULL`}
    ORDER BY v.published_at DESC NULLS LAST
    LIMIT ${limit}
  `;
  console.log(`📖 Deriving chapters for ${videos.length} videos...`);

  const openai = getClient();
  let done = 0;

  for (const video of videos) {
    const [row] = await sql<{ segments: unknown }[]>`SELECT segments FROM transcripts WHERE video_id = ${video.id}`;
    const segments = normalizeSegments(row?.segments);
    if (!segments) { console.log(`   ⏭️  ${video.title} — no timed segments`); continue; }

    // Downsample to keep the prompt small: ~120 evenly-spaced cues.
    const step = Math.max(1, Math.floor(segments.length / 120));
    const timeline = segments
      .filter((_s, i) => i % step === 0)
      .map((s) => `[${fmt(Math.floor(s.offset / 1000))}] ${s.text}`)
      .join("\n")
      .slice(0, 12000);

    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.3,
        max_tokens: 600,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You segment a video transcript into chapters. Given a timestamped transcript, return 5–12 chapter markers covering the whole video. Each chapter: a t_seconds (integer, matching where the topic begins, in seconds) and a short title (3–7 words). The first chapter must start at 0. Chapters must be in ascending time order. Return JSON: {\"chapters\":[{\"t_seconds\":0,\"title\":\"...\"}]}.",
          },
          { role: "user", content: `Title: ${video.title}\n\nTranscript:\n${timeline}` },
        ],
      });
      const parsed = JSON.parse(resp.choices[0]?.message?.content || "{}");
      const chapters = Array.isArray(parsed.chapters)
        ? parsed.chapters
            .filter((c: { t_seconds?: unknown; title?: unknown }) => typeof c.t_seconds === "number" && typeof c.title === "string")
            .map((c: { t_seconds: number; title: string }) => ({ t_seconds: Math.max(0, Math.floor(c.t_seconds)), title: c.title.trim() }))
            .sort((a: { t_seconds: number }, b: { t_seconds: number }) => a.t_seconds - b.t_seconds)
        : [];
      if (!chapters.length) { console.log(`   ⚠️  ${video.title} — no chapters returned`); continue; }

      await sql`UPDATE videos SET chapters = ${sql.json(chapters as unknown as Parameters<typeof sql.json>[0])} WHERE id = ${video.id}`;
      done++;
      console.log(`   ✅ ${video.title} — ${chapters.length} chapters`);
    } catch (e) {
      console.error(`   ❌ ${video.title}:`, e);
    }
  }

  console.log(`\n✅ Chapters derived for ${done} videos.`);
  await sql.end({ timeout: 5 });
}

deriveChapters().catch(async (e) => {
  console.error("Fatal error:", e);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
