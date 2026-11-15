-- 005-transcript-search-column.sql
-- Library keyword search over full transcripts. The existing expression index
-- (idx_transcripts_search) only helps rare terms: for a common word the planner
-- correctly picks a sequential scan, which recomputes to_tsvector() over every
-- ~25k-character transcript (measured ~3.5 s on a production-shaped fixture).
-- Store the vector once per write instead.
--
-- Lock-friendly rollout in three steps:
--   005 (this file): nullable column + maintenance trigger. ADD COLUMN without a
--       default is a catalogue-only change, so the ACCESS EXCLUSIVE lock is brief.
--   006: backfill existing rows (row locks only; readers are never blocked).
--   007: build the GIN index CONCURRENTLY.
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS search_tsv tsvector;

CREATE OR REPLACE FUNCTION transcripts_search_tsv_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv := to_tsvector('english', COALESCE(NEW.cleaned_text, ''));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transcripts_search_tsv ON transcripts;
CREATE TRIGGER transcripts_search_tsv
  BEFORE INSERT OR UPDATE OF cleaned_text ON transcripts
  FOR EACH ROW EXECUTE FUNCTION transcripts_search_tsv_refresh();
