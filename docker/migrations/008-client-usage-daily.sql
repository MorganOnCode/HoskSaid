-- 008-client-usage-daily.sql
-- Per-client daily allowance for site-funded model calls, reserved in the same
-- transaction as site_usage_daily so one client cannot spend the shared daily
-- budget. `client` is an HMAC of the UTC day and the limiter identity (IP or
-- API key); the raw IP or key is never stored. Rows older than the current UTC
-- day are deleted by the application.
CREATE TABLE IF NOT EXISTS client_usage_daily (
  day        date        NOT NULL,
  client     text        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('answer', 'embedding')),
  calls      integer     NOT NULL DEFAULT 0 CHECK (calls >= 0),
  PRIMARY KEY (day, client, kind)
);
