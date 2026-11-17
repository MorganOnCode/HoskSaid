-- Rollback for 010. Only /analytics rankings read these tables; without them the
-- page reports that rankings have not been computed and queries keep working.
DROP TABLE IF EXISTS analytics_rankings;
DROP TABLE IF EXISTS analytics_snapshots;
DELETE FROM schema_migrations WHERE version = '010';
