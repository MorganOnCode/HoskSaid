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
  video_type TEXT,             -- AMA | Whiteboard | Fireside | Keynote | Interview
  chapters JSONB,              -- [{ t_seconds, title }]
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- Idempotent for existing databases.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS video_type TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS chapters JSONB;

CREATE TABLE IF NOT EXISTS transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE UNIQUE,
  raw_text TEXT,
  cleaned_text TEXT,
  summary TEXT,
  segments JSONB,              -- timed caption cues [{text, offset(ms), duration(ms)}]
  source TEXT,                 -- youtube_captions | extractor | whisper | yt-dlp
  processing_status TEXT DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- Idempotent for existing databases (and loosen the old source CHECK).
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS segments JSONB;
ALTER TABLE transcripts DROP CONSTRAINT IF EXISTS transcripts_source_check;

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

-- pgvector chunk table (from supabase/migrations/semantic_search.sql).
-- A chunk is the handoff `segment` atom: stable id, parent video, start/end
-- seconds, verbatim text. Citations point at transcript_chunks.id.
CREATE TABLE IF NOT EXISTS transcript_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  start_time INTEGER,
  end_time INTEGER,
  speaker TEXT,
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE transcript_chunks ADD COLUMN IF NOT EXISTS speaker TEXT;

-- Curated topics (~40) + video assignments. Aggregates (citation_count,
-- video_count, segment_count, trend_pct) are COMPUTED at query time.
CREATE TABLE IF NOT EXISTS topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_topics (
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  topic_id UUID REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, topic_id)
);

-- Persisted Ask results: powers cite_count / citation_count / trend aggregates
-- and shareable answer permalinks.
CREATE TABLE IF NOT EXISTS answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  lede TEXT,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  scope JSONB,
  request_id TEXT,
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
CREATE INDEX IF NOT EXISTS idx_transcript_chunks_video ON transcript_chunks(video_id);

CREATE INDEX IF NOT EXISTS idx_video_topics_topic ON video_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_video_topics_video ON video_topics(video_id);
CREATE INDEX IF NOT EXISTS idx_answers_created ON answers(created_at DESC);

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

-- Changing the RETURNS TABLE shape requires a DROP first.
DROP FUNCTION IF EXISTS match_transcript_chunks(vector, float, int);

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
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    transcript_chunks.id,
    transcript_chunks.video_id,
    transcript_chunks.content,
    transcript_chunks.start_time,
    transcript_chunks.end_time,
    1 - (transcript_chunks.embedding <=> query_embedding) AS similarity
  FROM transcript_chunks
  WHERE 1 - (transcript_chunks.embedding <=> query_embedding) > match_threshold
  ORDER BY transcript_chunks.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- =============================================================================
-- Curated topic seed (~40). assign-topics classifies videos into these; topics
-- with zero member videos are simply hidden by the /topics query.
-- =============================================================================
INSERT INTO topics (name, slug, description) VALUES
  ('Governance',        'governance',        'On-chain governance, Voltaire, and how Cardano is run'),
  ('Voltaire',          'voltaire',          'The Voltaire governance era and its rollout'),
  ('Constitution',      'constitution',      'The Cardano constitution and constitutional committee'),
  ('DReps',             'dreps',             'Delegated representatives and on-chain voting'),
  ('Treasury',          'treasury',          'Treasury funding, budgets, and spend'),
  ('Catalyst',          'catalyst',          'Project Catalyst and community funding'),
  ('Intersect',         'intersect',         'Intersect, the member-based governance body'),
  ('Midnight',          'midnight',          'The Midnight sidechain and data protection'),
  ('Hydra',             'hydra',             'Hydra scaling and throughput'),
  ('Leios',             'leios',             'Ouroboros Leios and block production'),
  ('Ouroboros',         'ouroboros',         'The Ouroboros proof-of-stake protocol family'),
  ('Scaling',           'scaling',           'Throughput, layer-2, and the scaling endgame'),
  ('Mithril',           'mithril',           'Mithril stake-based threshold signatures'),
  ('Partner Chains',    'partner-chains',    'Partner chains and sidechains'),
  ('Staking',           'staking',           'Staking, delegation, and rewards'),
  ('Tokenomics',        'tokenomics',        'Inflation, the reserve, and ADA economics'),
  ('Roadmap',           'roadmap',           'The Cardano roadmap and delivery'),
  ('Regulation',        'regulation',        'Crypto regulation and policy'),
  ('SEC',               'sec',               'The SEC, enforcement, and securities law'),
  ('ETF',               'etf',               'Crypto ETFs and institutional access'),
  ('Bitcoin',           'bitcoin',           'Bitcoin, BTCfi, and Cardano bridges'),
  ('Ethereum',          'ethereum',          'Ethereum comparisons and interoperability'),
  ('Ripple',            'ripple',            'Ripple, XRP, and related commentary'),
  ('Stablecoins',       'stablecoins',       'Stablecoins, trust, and design'),
  ('DeFi',              'defi',              'Decentralized finance on Cardano'),
  ('RealFi',            'realfi',            'Real-world finance and inclusion'),
  ('Smart Contracts',   'smart-contracts',   'Plutus, smart contracts, and dApps'),
  ('Marlowe',           'marlowe',           'Marlowe and financial contracts'),
  ('Identity',          'identity',          'Decentralized identity and Atala PRISM'),
  ('Africa',            'africa',            'The Africa strategy and deployments'),
  ('Adoption',          'adoption',          'Real-world adoption and partnerships'),
  ('Decentralization',  'decentralization',  'Decentralization of the network and stewardship'),
  ('Interoperability',  'interoperability',  'Cross-chain interoperability and bridges'),
  ('Privacy',           'privacy',           'Privacy, ZK, and confidentiality'),
  ('Quantum',           'quantum',           'Quantum resistance and cryptography'),
  ('Wallets',           'wallets',           'Wallets, Lace, and user experience'),
  ('Node',              'node',              'The Cardano node and infrastructure'),
  ('Education',         'education',         'Education, peer review, and formal methods'),
  ('Philosophy',        'philosophy',        'Hoskinson on philosophy, governance theory, and first principles'),
  ('Community',         'community',         'The community, culture, and ecosystem'),
  ('Charles Personal',  'charles-personal',  'Personal updates, the ranch, and off-topic asides')
ON CONFLICT (slug) DO NOTHING;
