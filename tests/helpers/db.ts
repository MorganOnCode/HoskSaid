/**
 * Isolated fixture databases for integration tests.
 *
 * Requires TEST_DATABASE_URL pointing at a disposable Postgres with pgvector on
 * a loopback host (CI uses a service container; locally a throwaway container).
 * Each test file creates its own database, applies docker/init-db.sql and every
 * migration, and drops it afterwards. The guard below refuses anything that
 * does not look like a local test server, so a production URL can never be used.
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { applyMigrations } from "../../src/lib/migrations";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;
export const SKIP_DB = TEST_DB_URL ? false : "TEST_DATABASE_URL not set (DB integration test skipped)";

function assertSafe(url: URL) {
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  const looksTest = /test/i.test(url.pathname) || /test/i.test(url.username);
  if (!loopback || !looksTest) {
    throw new Error("Refusing TEST_DATABASE_URL: it must be a loopback host whose database or user name contains 'test'.");
  }
}

export type Sql = ReturnType<typeof postgres>;

export interface TestDb {
  url: string;
  sql: Sql;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  if (!TEST_DB_URL) throw new Error("TEST_DATABASE_URL not set");
  const admin = new URL(TEST_DB_URL);
  assertSafe(admin);
  const name = `hosk_t_${process.pid}_${randomBytes(3).toString("hex")}`;
  const adminSql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  await adminSql.unsafe(`CREATE DATABASE ${name}`);
  await adminSql.end();

  const url = new URL(admin.toString());
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 4, onnotice: () => {}, prepare: false });
  await sql.unsafe(readFileSync(path.join(process.cwd(), "docker", "init-db.sql"), "utf8"));
  await applyMigrations(sql);

  // The application's lazily-built pool reads DATABASE_URL on first query.
  process.env.DATABASE_URL = url.toString();

  return {
    url: url.toString(),
    sql,
    async drop() {
      await globalThis.__hosksaidPg?.end({ timeout: 2 }).catch(() => {});
      globalThis.__hosksaidPg = undefined;
      await sql.end({ timeout: 2 });
      const a = postgres(admin.toString(), { max: 1, onnotice: () => {} });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic vectors
// ---------------------------------------------------------------------------

export const DIM = 1536;

/** Seeded PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export function randomUnit(seed: number): number[] {
  const r = rng(seed);
  return normalize(Array.from({ length: DIM }, () => r() * 2 - 1));
}

/** A unit vector near `base` (cosine similarity falls as `noise` grows). */
export function near(base: number[], noise: number, seed: number): number[] {
  const r = rng(seed);
  return normalize(base.map((x) => x + (r() * 2 - 1) * noise));
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function vec(v: number[]): string {
  return `[${v.join(",")}]`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface FixtureVideo {
  youtube_id: string;
  title?: string;
  published_at?: string | null;
  status?: string;
  summary?: string | null;
  cleaned_text?: string | null;
  raw_text?: string | null;
  created_at?: string;
  chunks?: { content: string; start?: number | null; end?: number | null; embedding?: number[] }[];
  topics?: string[]; // slugs (must exist in the seed)
  tags?: string[];
}

export async function seedVideo(sql: Sql, v: FixtureVideo): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO videos (youtube_id, title, published_at, status, duration_seconds, created_at)
    VALUES (${v.youtube_id}, ${v.title ?? `Video ${v.youtube_id}`}, ${v.published_at === undefined ? "2026-06-01T12:00:00Z" : v.published_at},
            ${v.status ?? "completed"}, 600, ${v.created_at ?? new Date().toISOString()})
    RETURNING id
  `;
  if (v.cleaned_text !== undefined || v.raw_text !== undefined || v.summary !== undefined) {
    await sql`
      INSERT INTO transcripts (video_id, raw_text, cleaned_text, summary, processing_status)
      VALUES (${row.id}, ${v.raw_text ?? v.cleaned_text ?? null}, ${v.cleaned_text ?? null}, ${v.summary ?? null}, 'completed')
    `;
  }
  for (const c of v.chunks ?? []) {
    await sql`
      INSERT INTO transcript_chunks (video_id, content, start_time, end_time, embedding)
      VALUES (${row.id}, ${c.content}, ${c.start ?? null}, ${c.end ?? null}, ${c.embedding ? vec(c.embedding) : null}::vector)
    `;
  }
  for (const slug of v.topics ?? []) {
    await sql`INSERT INTO video_topics (video_id, topic_id) SELECT ${row.id}, id FROM topics WHERE slug = ${slug}`;
  }
  for (const name of v.tags ?? []) {
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO tags (name) VALUES (${name}) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id
    `;
    await sql`INSERT INTO video_tags (video_id, tag_id) VALUES (${row.id}, ${t.id}) ON CONFLICT DO NOTHING`;
  }
  return row.id;
}
