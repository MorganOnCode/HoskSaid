#!/usr/bin/env bash
#
# hosksaid nightly backup
# ───────────────────────
# Streams a compressed custom-format pg_dump of the hosksaid-postgres container
# straight into a restic repository on a cloud bucket (no intermediate file),
# then applies a retention policy. Mirrors /opt/tubechat/scripts/backup.sh.
#
# Credentials live in /opt/hosksaid/.backup.env (gitignored) — copy
# .backup.env.example and fill it in. See that file for repo/provider syntax.
#
# Install the cron (runs as the morganic user, which can talk to docker):
#   sudo cp /opt/hosksaid/scripts/hosksaid-backup.cron /etc/cron.d/hosksaid-backup
#   sudo chmod 644 /etc/cron.d/hosksaid-backup
#
# Logs: /opt/hosksaid/data/backup.log (the cron redirects here).
# Manual run / first run:  /opt/hosksaid/scripts/backup.sh
#
set -euo pipefail

APP_DIR="/opt/hosksaid"
ENV_FILE="${APP_DIR}/.backup.env"
CONTAINER="hosksaid-postgres"
DB_NAME="hosksaid"
DB_USER="hosksaid"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# ── credentials ────────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Copy .backup.env.example -> .backup.env and fill it in." >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a   # RESTIC_REPOSITORY, RESTIC_PASSWORD, provider creds

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY not set in .backup.env}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD not set in .backup.env}"

# DB password is read from the app .env (never printed)
PGPASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "${APP_DIR}/.env" | head -1 | cut -d= -f2-)"
export PGPASSWORD
[[ -n "$PGPASSWORD" ]] || { echo "ERROR: POSTGRES_PASSWORD missing from ${APP_DIR}/.env" >&2; exit 1; }

# ── run ────────────────────────────────────────────────────────────────────
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
log "hosksaid backup starting → ${RESTIC_REPOSITORY}"

# Initialise the repo on first run (idempotent: ignore "already initialized").
if ! restic snapshots >/dev/null 2>&1; then
  log "restic repo not initialised — running restic init"
  restic init
fi

# pipefail makes the pipeline fail if pg_dump fails (don't back up a partial dump).
# DB dump → its own snapshot (tag: db).
docker exec -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" \
    pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc \
  | restic backup --stdin --stdin-filename "hosksaid-${STAMP}.dump" \
      --tag hosksaid --tag db --tag nightly

# App secrets → its own snapshot (tag: secrets) so a fresh-machine restore has the
# API keys / DB password / CRON_SECRET, not just the data. Tiny; restic dedups.
# NOTE: the restic password itself must live OFF-box (see .backup.env / LastPass) —
# it cannot protect itself from inside the repo it encrypts.
log "backing up app secrets (.env)"
restic backup --tag hosksaid --tag secrets "${APP_DIR}/.env"

# Retention is applied PER snapshot-type: a same-day keep-daily would otherwise
# keep only one of the (db, secrets) pair each night and evict the other.
log "applying retention (keep 7 daily / 4 weekly / 6 monthly, per type)"
restic forget --tag db      --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 6
restic forget --tag secrets --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 6

log "hosksaid backup complete"
