-- HoskSaid Database Schema
-- Run this in Supabase SQL Editor

-- Channels table
CREATE TABLE channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Videos table
CREATE TABLE videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  youtube_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  published_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  thumbnail_url TEXT,
  view_count INTEGER,
  status TEXT DEFAULT 'pending', -- pending, processing, completed, failed
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transcripts table
CREATE TABLE transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE UNIQUE,
  raw_text TEXT,
  cleaned_text TEXT,
  summary TEXT,
  source TEXT CHECK (source IN ('youtube_captions', 'extractor', 'whisper')),
  processing_status TEXT DEFAULT 'pending', -- pending, processing, completed, failed
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tags table
CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Video-Tags junction table
CREATE TABLE video_tags (
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

-- Error reports from users
CREATE TABLE error_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  error_type TEXT NOT NULL, -- 'typo', 'missing_content', 'wrong_speaker', 'other'
  description TEXT NOT NULL,
  timestamp_seconds INTEGER, -- optional: where in the video
  status TEXT DEFAULT 'pending', -- pending, reviewed, fixed, dismissed
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ingestion logs for debugging
CREATE TABLE ingestion_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for search performance
CREATE INDEX idx_videos_youtube_id ON videos(youtube_id);
CREATE INDEX idx_videos_channel_id ON videos(channel_id);
CREATE INDEX idx_videos_published_at ON videos(published_at DESC);
CREATE INDEX idx_videos_status ON videos(status);
CREATE INDEX idx_transcripts_video_id ON transcripts(video_id);
CREATE INDEX idx_tags_name ON tags(name);

-- Full-text search indexes
CREATE INDEX idx_videos_search ON videos USING GIN(
  to_tsvector('english', title || ' ' || COALESCE(description, ''))
);
CREATE INDEX idx_transcripts_search ON transcripts USING GIN(
  to_tsvector('english', COALESCE(cleaned_text, ''))
);

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers
CREATE TRIGGER update_channels_updated_at
  BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_videos_updated_at
  BEFORE UPDATE ON videos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_transcripts_updated_at
  BEFORE UPDATE ON transcripts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security (RLS) policies
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_reports ENABLE ROW LEVEL SECURITY;

-- Public read access policies
CREATE POLICY "Public can read channels" ON channels FOR SELECT USING (true);
CREATE POLICY "Public can read videos" ON videos FOR SELECT USING (status = 'completed');
CREATE POLICY "Public can read transcripts" ON transcripts FOR SELECT USING (processing_status = 'completed');
CREATE POLICY "Public can read tags" ON tags FOR SELECT USING (true);
CREATE POLICY "Public can read video_tags" ON video_tags FOR SELECT USING (true);

-- Public can submit error reports
CREATE POLICY "Public can insert error reports" ON error_reports FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can read own error reports" ON error_reports FOR SELECT USING (true);

-- Service role has full access (for backend operations)
-- This is handled automatically by Supabase service role key
