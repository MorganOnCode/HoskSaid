-- hosk:no-transaction
-- 002-chunk-video-index.sql
-- Restores the per-video chunk index that docker/init-db.sql declares but the
-- production database lacks (schema drift found by the 2026-11-15 audit: the
-- Timeline/Topics/Home correlated counts each seq-scan transcript_chunks).
-- CONCURRENTLY avoids blocking ingestion writes, so this file must stay a single
-- statement and run outside a transaction (the migration runner honours the
-- no-transaction marker above). If a concurrent build is interrupted it can
-- leave an INVALID index; `hosk migrate status` reports that case.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transcript_chunks_video ON transcript_chunks (video_id);
