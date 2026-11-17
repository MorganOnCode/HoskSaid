-- 004-site-usage-cap.sql
-- Daily counter for site-funded model calls (audit F2). The application
-- reserves a slot with a conditional upsert before every embedding or answer
-- paid for with the site's provider key; the row lock taken by
-- INSERT ... ON CONFLICT DO UPDATE makes the cap safe across concurrent
-- requests and across processes. Days are UTC calendar days.
CREATE TABLE IF NOT EXISTS site_usage_daily (
  day        date        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('answer', 'embedding')),
  calls      integer     NOT NULL DEFAULT 0 CHECK (calls >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, kind)
);
