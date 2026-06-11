-- 001-handoff-schema.sql
-- Evolves the live HoskSaid schema toward the thehosksaid.com handoff data model
-- and the TubeChat timestamp model. ADDITIVE ONLY — never drops live data.
-- Idempotent: safe to re-run. Apply against the running container with:
--   docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U hosksaid -d hosksaid < docker/migrations/001-handoff-schema.sql
-- The same statements are folded into docker/init-db.sql so a fresh volume
-- comes up correct.

-- =============================================================================
-- 1. Timed transcript segments (the critical timestamp fix)
-- =============================================================================
-- Raw caption cues [{text, offset(ms), duration(ms)}]. generate-embeddings reads
-- these back to produce timed transcript_chunks. (Mirrors TubeChat.)
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS segments JSONB;

-- Allow the yt-dlp json3 source. The original inline CHECK only permitted
-- youtube_captions|extractor|whisper; drop it so we can store the true source.
ALTER TABLE transcripts DROP CONSTRAINT IF EXISTS transcripts_source_check;

-- transcript_chunks.start_time / end_time already exist (init-db.sql) but are
-- never populated today — the Phase 1 pipeline fixes that. Add an optional
-- speaker for the handoff `segment` atom (NULL until diarization exists).
ALTER TABLE transcript_chunks ADD COLUMN IF NOT EXISTS speaker TEXT;

-- =============================================================================
-- 2. Video metadata for the handoff `video` atom
-- =============================================================================
-- Content taxonomy: AMA | Whiteboard | Fireside | Keynote | Interview
ALTER TABLE videos ADD COLUMN IF NOT EXISTS video_type TEXT;
-- Chapters: [{t_seconds, title}]
ALTER TABLE videos ADD COLUMN IF NOT EXISTS chapters JSONB;

-- =============================================================================
-- 3. Topics (curated set + auto-assign). Aggregates (citation_count,
--    video_count, segment_count, trend_pct) are COMPUTED at query time.
-- =============================================================================
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
CREATE INDEX IF NOT EXISTS idx_video_topics_topic ON video_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_video_topics_video ON video_topics(video_id);

-- Curated topic seed (~40). assign-topics.ts classifies videos into these.
-- Topics with zero member videos are simply hidden by the /topics query.
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

-- =============================================================================
-- 4. Persisted answers — powers cite_count / citation_count / trend aggregates
--    and shareable answer permalinks. (Extends TubeChat's answers table.)
-- =============================================================================
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
CREATE INDEX IF NOT EXISTS idx_answers_created ON answers(created_at DESC);

-- =============================================================================
-- 5. Extend the semantic-search RPC to also return end_time.
--    Changing the RETURNS TABLE shape requires a DROP first (CREATE OR REPLACE
--    cannot change a function's return type).
-- =============================================================================
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
