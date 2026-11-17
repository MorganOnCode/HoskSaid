-- 009-monthly-posts.sql
-- Monthly blog drafts generated from Charles's published videos (never from
-- visitors' questions or external feeds). One logical post per (kind, period).
-- Generation only ever writes unedited drafts; publication and withdrawal are
-- explicit operator actions recorded in post_events.
CREATE TABLE IF NOT EXISTS posts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('monthly')),
  period       text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  slug         text NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'withdrawn')),
  -- Bumped on every content change; edits and publication must name the
  -- revision they were reviewed against.
  revision     integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  title        text NOT NULL,
  dek          text,
  body         jsonb NOT NULL,     -- { intro: [{text, cites}], sections: [{heading, paragraphs: [{text, cites}]}] }
  sources      jsonb NOT NULL,     -- [{ id: "S1", video_id, title, published_at, moments: [{ id: "S1.1", segment_id, start_seconds, excerpt }] }]
  coverage     jsonb NOT NULL,     -- public-safe completeness summary (period bounds, counts, missing videos)
  generation   jsonb NOT NULL,     -- private: model, limits, cutoff, calls, evidence-check rejections
  input_hash   text NOT NULL,
  edited_at    timestamptz,
  edited_by    text,
  published_at timestamptz,
  published_by text,
  withdrawn_at timestamptz,
  withdrawn_by text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, period)
);
CREATE INDEX IF NOT EXISTS idx_posts_published ON posts (published_at DESC) WHERE status = 'published';

-- Operator/generator provenance for every state or content change.
CREATE TABLE IF NOT EXISTS post_events (
  id       bigserial PRIMARY KEY,
  post_id  uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  action   text NOT NULL CHECK (action IN ('generated', 'regenerated', 'edited', 'published', 'withdrawn')),
  actor    text NOT NULL,
  revision integer NOT NULL,
  detail   jsonb,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_post_events_post ON post_events (post_id, at);

-- Validated per-video notes, keyed by the exact material, prompt and model, so a
-- retry after a partial failure only pays for the videos that did not finish.
CREATE TABLE IF NOT EXISTS post_video_notes (
  video_id       uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  material_hash  text NOT NULL,
  notes          jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, material_hash)
);

-- Every generation attempt (CLI or schedule): outcome, model calls used.
CREATE TABLE IF NOT EXISTS post_generation_runs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  period      text NOT NULL,
  trigger     text NOT NULL CHECK (trigger IN ('cli', 'schedule')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome     text,
  calls       integer NOT NULL DEFAULT 0,
  detail      jsonb
);
CREATE INDEX IF NOT EXISTS idx_post_generation_runs_period ON post_generation_runs (kind, period, started_at DESC);

-- Model calls charged against a period's explicit budget, reserved with a
-- conditional upsert before each call so retries and concurrent runs cannot
-- exceed it.
CREATE TABLE IF NOT EXISTS post_generation_budget (
  kind       text NOT NULL,
  period     text NOT NULL,
  calls      integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, period)
);
