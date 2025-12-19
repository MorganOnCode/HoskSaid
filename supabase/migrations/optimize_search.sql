-- Optimize basic search by indexing raw_text
-- This is crucial because "cleaned_text" is currently empty for most videos,
-- so search falls back to sequential scans or misses data.

CREATE INDEX IF NOT EXISTS idx_transcripts_raw_text_search ON transcripts USING GIN(
  to_tsvector('english', COALESCE(raw_text, ''))
);

-- Also ensure we have an index on the foreign key for joins
CREATE INDEX IF NOT EXISTS idx_transcripts_video_id_fk ON transcripts(video_id);
