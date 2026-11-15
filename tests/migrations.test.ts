/** Migration runner: ordering, ledger, idempotence, no-transaction files. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SKIP_DB, createTestDb, type TestDb } from "./helpers/db";
import { applyMigrations, invalidIndexes, loadMigrationFiles, migrationStatus } from "../src/lib/migrations";

describe("migration runner", () => {
  test("files are ordered, uniquely versioned, and CONCURRENTLY only appears in no-transaction files", () => {
    const files = loadMigrationFiles();
    const versions = files.map((f) => f.version);
    assert.deepEqual(versions, [...versions].sort());
    assert.equal(new Set(versions).size, versions.length);
    for (const f of files) {
      if (/CONCURRENTLY/i.test(f.sql.replace(/--.*$/gm, ""))) {
        assert.equal(f.transactional, false, `${f.file} uses CONCURRENTLY inside a transaction`);
        assert.equal(f.sql.replace(/--.*$/gm, "").split(";").filter((s) => s.trim()).length, 1, `${f.file} must be one statement`);
      }
    }
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
});
