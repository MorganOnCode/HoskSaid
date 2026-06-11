#!/usr/bin/env npx tsx
/**
 * Classify each video into a content type: AMA | Whiteboard | Fireside | Keynote
 * | Interview. Title/description heuristics first, gpt-4o-mini as a fallback.
 * Writes videos.video_type. No YouTube access — runs on the VPS.
 *
 *   npx tsx src/scripts/classify-video-type.ts --limit=200 [--force]
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

const TYPES = ["AMA", "Whiteboard", "Fireside", "Keynote", "Interview"];

function heuristic(title: string): string | null {
  const t = title.toLowerCase();
  if (/\bama\b|ask me anything|surprise ama|monthly ama/.test(t)) return "AMA";
  if (/whiteboard/.test(t)) return "Whiteboard";
  if (/fireside/.test(t)) return "Fireside";
  if (/keynote|summit|consensus|conference|state of/.test(t)) return "Keynote";
  if (/interview|sits down|in conversation|podcast|with @|talks to/.test(t)) return "Interview";
  return null;
}

async function classify() {
  const limit = parseInt(getArg("limit") || "100", 10);
  const force = hasFlag("force");

  const videos = await sql<{ id: string; title: string; description: string | null }[]>`
    SELECT id, title, description FROM videos
    WHERE status = 'completed' ${force ? sql`` : sql`AND video_type IS NULL`}
    ORDER BY published_at DESC NULLS LAST
    LIMIT ${limit}
  `;
  console.log(`🎛️  Classifying video_type for ${videos.length} videos...`);

  const openai = getClient();
  let done = 0;

  for (const v of videos) {
    let type = heuristic(v.title);
    if (!type) {
      try {
        const resp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          max_tokens: 10,
          messages: [
            {
              role: "system",
              content: `Classify this Charles Hoskinson video as exactly one of: ${TYPES.join(", ")}. Reply with only the single word.`,
            },
            { role: "user", content: `${v.title}\n\n${(v.description || "").slice(0, 400)}` },
          ],
        });
        const guess = (resp.choices[0]?.message?.content || "").trim();
        type = TYPES.find((t) => guess.toLowerCase().startsWith(t.toLowerCase())) || "Keynote";
      } catch {
        type = "Keynote";
      }
    }
    await sql`UPDATE videos SET video_type = ${type} WHERE id = ${v.id}`;
    done++;
    console.log(`   ✅ ${type.padEnd(11)} ${v.title.slice(0, 60)}`);
  }

  console.log(`\n✅ Classified ${done} videos.`);
  await sql.end({ timeout: 5 });
}

classify().catch(async (e) => {
  console.error("Fatal error:", e);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
