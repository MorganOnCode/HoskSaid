-- 006-transcript-search-backfill.sql
-- Fill search_tsv for rows written before 005. Takes row locks (and a SHARE ROW
-- EXCLUSIVE lock to pause the updated_at trigger so transcripts keep their real
-- modification times); concurrent writers wait, readers do not. ~11 s on the
-- production-shaped fixture; idempotent (only NULL rows are touched).
ALTER TABLE transcripts DISABLE TRIGGER update_transcripts_updated_at;
UPDATE transcripts
   SET search_tsv = to_tsvector('english', COALESCE(cleaned_text, ''))
 WHERE search_tsv IS NULL;
ALTER TABLE transcripts ENABLE TRIGGER update_transcripts_updated_at;
