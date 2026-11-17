-- Rollback for 008. The previous application code never reads this table.
DROP TABLE IF EXISTS client_usage_daily;
DELETE FROM schema_migrations WHERE version = '008';
