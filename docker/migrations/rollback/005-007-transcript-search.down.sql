-- Rollback for 005-007 (run each statement separately; the first must run
-- outside a transaction). The previous application code never reads search_tsv.
DROP INDEX CONCURRENTLY IF EXISTS idx_transcripts_search_tsv;
DROP TRIGGER IF EXISTS transcripts_search_tsv ON transcripts;
DROP FUNCTION IF EXISTS transcripts_search_tsv_refresh();
ALTER TABLE transcripts DROP COLUMN IF EXISTS search_tsv;
DELETE FROM schema_migrations WHERE version IN ('005', '006', '007');
