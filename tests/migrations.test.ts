/** Migration runner: ordering, ledger, idempotence, no-transaction files. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SKIP_DB, createTestDb, type TestDb } from "./helpers/db";
import { applyMigrations, invalidIndexes, loadMigrationFiles, migrationStatus } from "../src/lib/migrations";

describe("migration runner", () => {
  test("files are ordered and uniquely versioned", () => {
    const versions = loadMigrationFiles().map((f) => f.version);
    assert.deepEqual(versions, [...versions].sort());
    assert.equal(new Set(versions).size, versions.length);
  });
});

describe("migration runner against a database", { skip: SKIP_DB }, () => {
  let db: TestDb;
  before(async () => { db = await createTestDb(); });
  after(async () => db?.drop());

  test("everything is applied once and re-running is a no-op", async () => {
    const status = await migrationStatus(db.sql);
    assert.ok(status.every((m) => m.state === "applied"));
    const again = await applyMigrations(db.sql);
    assert.deepEqual(again.applied, []);
    assert.deepEqual(await invalidIndexes(db.sql), []);
  });

  test("the restored per-video chunk index exists", async () => {
    const rows = await db.sql`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_transcript_chunks_video'`;
    assert.equal(rows.length, 1);
  });

  test("a changed migration file is reported as modified, not silently re-applied", async () => {
    await db.sql`UPDATE schema_migrations SET checksum = 'different' WHERE version = '004'`;
    const s = await migrationStatus(db.sql);
    assert.equal(s.find((m) => m.version === "004")?.state, "modified");
    const r = await applyMigrations(db.sql, { dryRun: true });
    assert.deepEqual(r.modified, ["004"]);
    assert.deepEqual(r.pending, []);
  });

  test("CONCURRENTLY fails inside a transaction and succeeds in a no-transaction file", async () => {
    const stmt = "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_migration_runner_probe ON videos (title);\n";
    const dir = (name: string, body: string) => {
      const d = mkdtempSync(path.join(tmpdir(), "hosk-mig-"));
      writeFileSync(path.join(d, name), body);
      return d;
    };
    const txDir = dir("901-probe-tx.sql", stmt);
    const noTxDir = dir("902-probe-no-tx.sql", `-- hosk:no-transaction\n${stmt}`);
    try {
      await assert.rejects(applyMigrations(db.sql, { dir: txDir }), /cannot run inside a transaction block/);
      assert.equal((await db.sql`SELECT 1 FROM schema_migrations WHERE version = '901'`).length, 0, "a failed file is not recorded");
      assert.deepEqual((await applyMigrations(db.sql, { dir: noTxDir })).applied, ["902"]);
      assert.equal((await db.sql`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_migration_runner_probe'`).length, 1);
    } finally {
      rmSync(txDir, { recursive: true, force: true });
      rmSync(noTxDir, { recursive: true, force: true });
    }
  });
});
