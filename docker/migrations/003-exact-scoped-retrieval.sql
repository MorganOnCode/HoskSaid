-- 003-exact-scoped-retrieval.sql
-- Retrieval correctness (audit F1 + F8).
--
-- F1: the ivfflat index runs at ivfflat.probes = 1, so ANN search scans one of
-- 100 lists and missed most true neighbours (sampled recall@30 0.17). At the
-- archive's size (~10k chunks) exact search measured faster than probes = 10,
-- so retrieval now ranks by exact cosine distance. The MATERIALIZED CTE keeps
-- the planner from serving ORDER BY from the ANN index whatever the session's
-- ivfflat/hnsw settings are. The ivfflat index is left in place (dropping it is
-- a separate, reversible decision); it is simply no longer used for ranking.
--
-- F8: scope filters (video, date window, topic) are applied in SQL BEFORE the
-- ORDER BY ... LIMIT, so a scoped question ranks only in-scope chunks instead
-- of filtering the archive-wide top 30 afterwards.
--
-- Date bounds are half-open: published_at >= scope_from AND < scope_to. Videos
-- with an unknown published_at never match a date-scoped query.

CREATE OR REPLACE FUNCTION match_transcript_chunks_scoped (
  query_embedding    vector(1536),
  match_threshold    float,
  match_count        int,
  scope_youtube_ids  text[]      DEFAULT NULL,
  scope_from         timestamptz DEFAULT NULL,
  scope_to           timestamptz DEFAULT NULL,
  scope_topic_slugs  text[]      DEFAULT NULL
)
RETURNS TABLE (
  id           uuid,
  video_id     uuid,
  youtube_id   text,
  title        text,
  published_at timestamptz,
  content      text,
  start_time   integer,
  end_time     integer,
  similarity   float
)
LANGUAGE sql
STABLE
AS $$
  WITH scored AS MATERIALIZED (
    SELECT tc.id, tc.video_id, v.youtube_id, v.title, v.published_at,
           tc.content, tc.start_time, tc.end_time,
           (tc.embedding <=> query_embedding) AS distance
    FROM transcript_chunks tc
    JOIN videos v ON v.id = tc.video_id AND v.status = 'completed'
    WHERE tc.embedding IS NOT NULL
      AND (scope_youtube_ids IS NULL OR v.youtube_id = ANY (scope_youtube_ids))
      AND (scope_from IS NULL OR v.published_at >= scope_from)
      AND (scope_to   IS NULL OR v.published_at <  scope_to)
      AND (scope_topic_slugs IS NULL OR EXISTS (
            SELECT 1 FROM video_topics vt JOIN topics t ON t.id = vt.topic_id
            WHERE vt.video_id = v.id AND t.slug = ANY (scope_topic_slugs)))
  )
  SELECT s.id, s.video_id, s.youtube_id, s.title, s.published_at,
         s.content, s.start_time, s.end_time, (1 - s.distance)::float AS similarity
  FROM scored s
  WHERE 1 - s.distance > match_threshold
  ORDER BY s.distance, s.id
  LIMIT LEAST(GREATEST(match_count, 0), 200);
$$;

-- Keep the original 3-argument entry point (used by older scripts/clients) but
-- route it through the exact, completed-videos-only search above.
CREATE OR REPLACE FUNCTION match_transcript_chunks (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id UUID,
  video_id UUID,
  content TEXT,
  start_time INTEGER,
  end_time INTEGER,
  similarity float
)
LANGUAGE sql
STABLE
AS $$
  SELECT m.id, m.video_id, m.content, m.start_time, m.end_time, m.similarity
  FROM match_transcript_chunks_scoped(query_embedding, match_threshold, match_count) m;
$$;
