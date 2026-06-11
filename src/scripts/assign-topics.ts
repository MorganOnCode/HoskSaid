#!/usr/bin/env npx tsx
/**
 * Classify each video into the curated topics (from its title + tags + summary).
 * Writes video_topics. No YouTube access — runs on the VPS.
 *
 *   npx tsx src/scripts/assign-topics.ts --limit=100 [--force]
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

async function assignTopics() {
  const limit = parseInt(getArg("limit") || "50", 10);
  const force = hasFlag("force");

  const topics = await sql<{ id: string; name: string }[]>`SELECT id, name FROM topics ORDER BY name`;
  const byName = new Map(topics.map((t) => [t.name.toLowerCase(), t.id]));
  const topicList = topics.map((t) => t.name).join(", ");

  const videos = await sql<{ id: string; title: string; summary: string | null; tags: string[] }[]>`
    SELECT v.id, v.title, t.summary,
      COALESCE((SELECT array_agg(tg.name) FROM video_tags vt JOIN tags tg ON tg.id = vt.tag_id WHERE vt.video_id = v.id), '{}') AS tags
    FROM videos v
    LEFT JOIN transcripts t ON t.video_id = v.id
    WHERE v.status = 'completed'
      ${force ? sql`` : sql`AND NOT EXISTS (SELECT 1 FROM video_topics vt2 WHERE vt2.video_id = v.id)`}
    ORDER BY v.published_at DESC NULLS LAST
    LIMIT ${limit}
  `;
  console.log(`🏷️  Assigning topics for ${videos.length} videos...`);

  const openai = getClient();
  let done = 0;

  for (const v of videos) {
    const context = `Title: ${v.title}\nTags: ${(v.tags || []).join(", ")}\nSummary: ${(v.summary || "").slice(0, 1500)}`;
    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 120,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Classify a Charles Hoskinson video into 1–4 of these curated topics (use the exact names): ${topicList}. Pick only clearly-relevant topics. Return JSON: {"topics":["Name", ...]}.`,
          },
          { role: "user", content: context },
        ],
      });
      const parsed = JSON.parse(resp.choices[0]?.message?.content || "{}");
      const picked: string[] = Array.isArray(parsed.topics) ? parsed.topics : [];
      const ids = picked.map((n) => byName.get(String(n).toLowerCase())).filter(Boolean) as string[];
      if (!ids.length) { console.log(`   ⏭️  ${v.title} — no topic match`); continue; }

      if (force) await sql`DELETE FROM video_topics WHERE video_id = ${v.id}`;
      for (const tid of ids) {
        await sql`INSERT INTO video_topics (video_id, topic_id) VALUES (${v.id}, ${tid}) ON CONFLICT DO NOTHING`;
      }
      done++;
      console.log(`   ✅ ${v.title} → ${picked.join(", ")}`);
    } catch (e) {
      console.error(`   ❌ ${v.title}:`, e);
    }
  }

  console.log(`\n✅ Assigned topics for ${done} videos.`);
  await sql.end({ timeout: 5 });
}

assignTopics().catch(async (e) => {
  console.error("Fatal error:", e);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
