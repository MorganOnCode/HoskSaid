-- Rollback for 009. DESTRUCTIVE once posts exist: removes drafts, published
-- posts and their provenance. Export first:
--   npx tsx src/cli/hosk.ts posts preview <YYYY-MM> --format json --out <file>
DROP TABLE IF EXISTS post_generation_budget;
DROP TABLE IF EXISTS post_generation_runs;
DROP TABLE IF EXISTS post_video_notes;
DROP TABLE IF EXISTS post_events;
DROP TABLE IF EXISTS posts;
DELETE FROM schema_migrations WHERE version = '009';
