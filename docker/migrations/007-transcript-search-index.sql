-- hosk:no-transaction
-- 007-transcript-search-index.sql
-- GIN index for the stored transcript search vector (see 005/006). Built
-- CONCURRENTLY so ingestion writes are not blocked; must remain one statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transcripts_search_tsv ON transcripts USING GIN (search_tsv);
