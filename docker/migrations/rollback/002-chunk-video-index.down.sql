-- Rollback for 002 (run outside a transaction). Only needed if the index itself
-- causes a problem; it is the index docker/init-db.sql has always declared.
DROP INDEX CONCURRENTLY IF EXISTS idx_transcript_chunks_video;
-- then, in a separate statement: DELETE FROM schema_migrations WHERE version = '002';
