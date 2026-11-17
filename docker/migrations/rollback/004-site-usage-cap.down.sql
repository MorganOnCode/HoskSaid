-- Rollback for 004. Removing the table also removes usage history; the old
-- application code never reads it.
DROP TABLE IF EXISTS site_usage_daily;
DELETE FROM schema_migrations WHERE version = '004';
