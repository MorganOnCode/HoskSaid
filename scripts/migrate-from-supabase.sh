#!/usr/bin/env bash
# Migrate schema + data from Supabase to the self-hosted Postgres container.
#
# Usage:
#   SUPABASE_DB_URL="postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" \
#     ./scripts/migrate-from-supabase.sh
#
# The connection string is the **direct** (not pooler) URL from
# Supabase Dashboard → Project Settings → Database → Connection string.
# IPv6-only by default for new Supabase projects; if your VPS has no IPv6,
# enable the "Use connection pooler" toggle in their UI and use the
# "Session" mode connection string (port 5432, mode=session) instead.
#
# What this does:
#   1. Sanity-check that local Postgres container is up.
#   2. pg_dump the public schema from Supabase (data only, no roles/extensions).
#   3. psql restore into our local DB.
#   4. Run a per-table row-count parity check.
#
# Safe to run repeatedly: data is wiped from local tables before each restore.

set -euo pipefail

if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
    echo "ERROR: SUPABASE_DB_URL must be set." >&2
    echo "Get it from Supabase Dashboard → Project Settings → Database → Connection string." >&2
    exit 1
fi

cd "$(dirname "$0")/.."

if ! command -v pg_dump >/dev/null 2>&1; then
    echo "pg_dump not found on host; running it from inside the postgres container."
    PG_DUMP="docker compose -f docker-compose.prod.yml exec -T postgres pg_dump"
else
    PG_DUMP="pg_dump"
fi

# Tables to migrate (in dependency-safe insertion order).
TABLES=(channels videos transcripts tags video_tags transcript_chunks
        error_reports ingestion_logs)

# ---------------------------------------------------------------------------
# 1. Health check
# ---------------------------------------------------------------------------
echo "→ Checking local Postgres container..."
docker compose -f docker-compose.prod.yml exec -T postgres \
    pg_isready -U hosksaid -d hosksaid >/dev/null

# ---------------------------------------------------------------------------
# 2. Dump public schema data from Supabase
# ---------------------------------------------------------------------------
DUMP_FILE="$(mktemp -t supabase-dump.XXXXXX.sql)"
trap 'rm -f "$DUMP_FILE"' EXIT

echo "→ Dumping data from Supabase into $DUMP_FILE..."

# --data-only: skip schema (we already created it from supabase/schema.sql).
# --column-inserts: explicit column names → robust against column-order drift.
# --disable-triggers: lets us bypass the updated_at trigger so timestamps
#   round-trip verbatim instead of being rewritten to NOW().
# -t public.<table>: include only the tables we care about (skip Supabase's
#   own auth.*/storage.* schemas).
TABLE_ARGS=()
for t in "${TABLES[@]}"; do
    TABLE_ARGS+=("-t" "public.$t")
done

$PG_DUMP "$SUPABASE_DB_URL" \
    --data-only \
    --column-inserts \
    --disable-triggers \
    --no-owner --no-privileges \
    "${TABLE_ARGS[@]}" \
    > "$DUMP_FILE"

echo "  dump size: $(wc -c < "$DUMP_FILE") bytes"

# ---------------------------------------------------------------------------
# 3. Wipe local tables and restore
# ---------------------------------------------------------------------------
echo "→ Truncating local tables..."
docker compose -f docker-compose.prod.yml exec -T postgres \
    psql -U hosksaid -d hosksaid -c "
        TRUNCATE ingestion_logs, error_reports, transcript_chunks,
                 video_tags, transcripts, videos, channels, tags
        RESTART IDENTITY CASCADE;
    " >/dev/null

echo "→ Restoring into local Postgres..."
docker compose -f docker-compose.prod.yml exec -T postgres \
    psql -U hosksaid -d hosksaid \
    -v ON_ERROR_STOP=1 \
    < "$DUMP_FILE" \
    | tail -20

# ---------------------------------------------------------------------------
# 4. Row-count parity
# ---------------------------------------------------------------------------
echo
echo "→ Row-count parity check:"
printf "  %-25s %12s %12s\n" "table" "supabase" "local"
for t in "${TABLES[@]}"; do
    REMOTE=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM public.$t" 2>/dev/null || \
             docker compose -f docker-compose.prod.yml exec -T postgres \
                 psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM public.$t")
    LOCAL=$(docker compose -f docker-compose.prod.yml exec -T postgres \
            psql -U hosksaid -d hosksaid -At -c "SELECT count(*) FROM public.$t")
    MARK="OK"
    [[ "$REMOTE" != "$LOCAL" ]] && MARK="MISMATCH"
    printf "  %-25s %12s %12s  %s\n" "$t" "$REMOTE" "$LOCAL" "$MARK"
done

echo
echo "✅ Migration complete."
