-- Rollback for 003: restore the original plpgsql match_transcript_chunks
-- (ANN ordering, probes as configured) and drop the scoped function. The old
-- application code only calls the 3-argument function.
CREATE OR REPLACE FUNCTION match_transcript_chunks (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
RETURNS TABLE (id UUID, video_id UUID, content TEXT, start_time INTEGER, end_time INTEGER, similarity float)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT transcript_chunks.id, transcript_chunks.video_id, transcript_chunks.content,
         transcript_chunks.start_time, transcript_chunks.end_time,
         1 - (transcript_chunks.embedding <=> query_embedding) AS similarity
  FROM transcript_chunks
  WHERE 1 - (transcript_chunks.embedding <=> query_embedding) > match_threshold
  ORDER BY transcript_chunks.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
DROP FUNCTION IF EXISTS match_transcript_chunks_scoped(vector, float, int, text[], timestamptz, timestamptz, text[]);
DELETE FROM schema_migrations WHERE version = '003';
