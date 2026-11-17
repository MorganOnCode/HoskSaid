-- 010-analytics-rankings.sql
-- Derived phrase/keyword rankings for /analytics. Written only by the operator
-- command `hosk analytics refresh`, which reads transcripts without changing
-- them and publishes one complete snapshot per run in a single transaction
-- (older snapshots are deleted in that same transaction, so readers always see
-- either the previous snapshot or the new one, never a partial one).
-- Additive only: no existing table is altered. Live coverage/source queries do
-- not use these tables; they read videos/transcripts directly.
CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id               bigserial   PRIMARY KEY,
  method           text        NOT NULL,
  generated_at     timestamptz NOT NULL DEFAULT now(),
  -- Transcripts (dated, completed videos with cleaned text) the run counted.
  videos_computed  integer     NOT NULL CHECK (videos_computed >= 0),
  words_computed   bigint      NOT NULL CHECK (words_computed >= 0),
  -- [{ "year": 2025, "videos": 120 }, ...]: per-year denominators of this run.
  years            jsonb       NOT NULL,
  -- Method parameters (edge words, minimum support, stoplist sizes, ...).
  params           jsonb       NOT NULL,
  -- max(transcripts.updated_at) over the rows read, for staleness checks.
  source_updated_at timestamptz
);

CREATE TABLE IF NOT EXISTS analytics_rankings (
  snapshot_id  bigint  NOT NULL REFERENCES analytics_snapshots(id) ON DELETE CASCADE,
  year_from    integer NOT NULL,
  year_to      integer NOT NULL CHECK (year_to >= year_from),
  list         text    NOT NULL CHECK (list IN ('phrases', 'keywords', 'distinctive', 'formulas')),
  rank         integer NOT NULL CHECK (rank >= 1),
  item         text    NOT NULL,
  -- Videos in [year_from, year_to] containing the item, of all counted videos there.
  videos       integer NOT NULL CHECK (videos >= 0),
  of_videos    integer NOT NULL CHECK (of_videos >= 0),
  -- Distinctive keywords only: the comparison years of the same caption era.
  cmp_videos   integer,
  cmp_of       integer,
  lift         real,
  -- Share of long videos containing the item where it occurs only near the
  -- start or end (the intro/sign-off rule).
  edge_share   real,
  PRIMARY KEY (snapshot_id, year_from, year_to, list, rank)
);
