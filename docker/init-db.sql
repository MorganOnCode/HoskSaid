-- HoskSaid initial schema for self-hosted Postgres (pgvector image).
-- Applied automatically by the official postgres image on first boot
-- because /docker-entrypoint-initdb.d/*.sql files run once when the data
-- volume is empty. Idempotent so it can be re-run by hand against an
-- existing DB without crashing.

-- Extensions: Supabase enables these by default; we have to opt in.
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector for semantic search

-- =============================================================================
-- Schema (mirrors supabase/schema.sql; RLS removed — vanilla Postgres talks
-- only to the app via a single role, so RLS adds no security here)
-- =============================================================================

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  youtube_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  published_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  thumbnail_url TEXT,
  view_count INTEGER,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE UNIQUE,
  raw_text TEXT,
  cleaned_text TEXT,
  summary TEXT,
  source TEXT CHECK (source IN ('youtube_captions', 'extractor', 'whisper')),
  processing_status TEXT DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_tags (
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

CREATE TABLE IF NOT EXISTS error_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  error_type TEXT NOT NULL,
  description TEXT NOT NULL,
  timestamp_seconds INTEGER,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ingestion_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- pgvector chunk table (from supabase/migrations/semantic_search.sql)
CREATE TABLE IF NOT EXISTS transcript_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  start_time INTEGER,
  end_time INTEGER,
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Indexes
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_videos_youtube_id ON videos(youtube_id);
CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id);
CREATE INDEX IF NOT EXISTS idx_videos_published_at ON videos(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_transcripts_video_id ON transcripts(video_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_video_id_fk ON transcripts(video_id);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);

CREATE INDEX IF NOT EXISTS idx_videos_search ON videos USING GIN(
  to_tsvector('english', title || ' ' || COALESCE(description, ''))
);
CREATE INDEX IF NOT EXISTS idx_transcripts_search ON transcripts USING GIN(
  to_tsvector('english', COALESCE(cleaned_text, ''))
);
CREATE INDEX IF NOT EXISTS idx_transcripts_raw_text_search ON transcripts USING GIN(
  to_tsvector('english', COALESCE(raw_text, ''))
);

-- pgvector ANN index. Only build if not present and only on first run when
-- the table may be empty — ivfflat tolerates this.
CREATE INDEX IF NOT EXISTS idx_transcript_chunks_embedding
  ON transcript_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- =============================================================================
-- updated_at trigger
-- =============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE 'plpgsql';

DROP TRIGGER IF EXISTS update_channels_updated_at ON channels;
CREATE TRIGGER update_channels_updated_at
  BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_videos_updated_at ON videos;
CREATE TRIGGER update_videos_updated_at
  BEFORE UPDATE ON videos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_transcripts_updated_at ON transcripts;
CREATE TRIGGER update_transcripts_updated_at
  BEFORE UPDATE ON transcripts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- Semantic search RPC (mirrors Supabase's match_transcript_chunks function;
-- called from src/lib/search-server.ts via a direct SQL invocation now)
-- =============================================================================

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
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    transcript_chunks.id,
    transcript_chunks.video_id,
    transcript_chunks.content,
    transcript_chunks.start_time,
    1 - (transcript_chunks.embedding <=> query_embedding) AS similarity
  FROM transcript_chunks
  WHERE 1 - (transcript_chunks.embedding <=> query_embedding) > match_threshold
  ORDER BY transcript_chunks.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
