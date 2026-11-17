/**
 * Minimal versioned migration runner (server/CLI only).
 *
 * Files live in docker/migrations as `NNN-name.sql`. Each applied version is
 * recorded in `schema_migrations` with a checksum so drift is visible. A file
 * whose first line is `-- hosk:no-transaction` runs outside a transaction (for
 * CREATE INDEX CONCURRENTLY) and must contain a single statement; every other
 * file runs inside one transaction together with its ledger insert.
 *
 * Every migration in this repo is written to be idempotent, so applying 001 to
 * a database that already has it (the production baseline) is safe.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

export const MIGRATIONS_DIR = path.join(process.cwd(), "docker", "migrations");
const FILE_RE = /^(\d{3})-([a-z0-9-]+)\.sql$/;
const NO_TX_MARKER = "-- hosk:no-transaction";

export interface MigrationFile {
  version: string;
  name: string;
  file: string;
  checksum: string;
  transactional: boolean;
  sql: string;
}

export interface MigrationState extends MigrationFile {
  state: "applied" | "pending" | "modified";
  applied_at: string | null;
}

export function loadMigrationFiles(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .map((file) => {
      const [, version, name] = FILE_RE.exec(file)!;
      const sql = readFileSync(path.join(dir, file), "utf8");
      return {
        version,
        name,
        file,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
        transactional: !sql.trimStart().startsWith(NO_TX_MARKER),
      };
    });
}

async function ensureLedger(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

export async function migrationStatus(sql: Sql, dir = MIGRATIONS_DIR): Promise<MigrationState[]> {
  await ensureLedger(sql);
  const applied = new Map(
    (await sql<{ version: string; checksum: string; applied_at: Date }[]>`
      SELECT version, checksum, applied_at FROM schema_migrations
    `).map((r) => [r.version, r])
  );
  return loadMigrationFiles(dir).map((m) => {
    const row = applied.get(m.version);
    return {
      ...m,
      state: !row ? "pending" : row.checksum === m.checksum ? "applied" : "modified",
      applied_at: row ? new Date(row.applied_at).toISOString() : null,
    };
  });
}

/** Indexes left INVALID by an interrupted CREATE INDEX CONCURRENTLY. */
export async function invalidIndexes(sql: Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE NOT i.indisvalid
  `;
  return rows.map((r) => r.name);
}

export async function applyMigrations(
  sql: Sql,
  opts: { dryRun?: boolean; dir?: string; target?: string } = {}
): Promise<{ applied: string[]; pending: string[]; modified: string[] }> {
  const status = await migrationStatus(sql, opts.dir);
  const modified = status.filter((m) => m.state === "modified").map((m) => m.version);
  const pending = status.filter(
    (m) => m.state === "pending" && (!opts.target || m.version <= opts.target)
  );
  if (opts.dryRun) return { applied: [], pending: pending.map((m) => m.version), modified };

  const applied: string[] = [];
  for (const m of pending) {
    if (m.transactional) {
      await sql.begin(async (tx) => {
        await tx.unsafe(m.sql);
        await tx`
          INSERT INTO schema_migrations (version, name, checksum)
          VALUES (${m.version}, ${m.name}, ${m.checksum})
        `;
      });
    } else {
      await sql.unsafe(m.sql);
      await sql`
        INSERT INTO schema_migrations (version, name, checksum)
        VALUES (${m.version}, ${m.name}, ${m.checksum})
        ON CONFLICT (version) DO NOTHING
      `;
    }
    applied.push(m.version);
  }
  return { applied, pending: [], modified };
}
