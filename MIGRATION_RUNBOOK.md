# HoskSaid runbook

Self-hosted on a VPS, replacing Vercel + Supabase. Migration is complete and
the site is live at https://thehosksaid.com.

## Architecture

The VPS **serves** the site and **hosts** the database. It does **not** run
ingestion — YouTube blocks the VPS's datacenter IP for both the caption API
(`youtube-transcript`) and `yt-dlp`. Ingestion runs from a **residential IP
(your laptop)** against the VPS Postgres over an SSH tunnel.

| Layer | Where | How to reach |
| --- | --- | --- |
| Next.js app (`hosksaid-web`) | docker compose, `127.0.0.1:3001` | `curl http://127.0.0.1:3001/` |
| Postgres + pgvector (`hosksaid-postgres`) | docker compose, `127.0.0.1:5432` (loopback) | `docker compose -f docker-compose.prod.yml exec postgres psql -U hosksaid` |
| Public DNS/TLS | Cloudflare tunnel `f54b9704-…dfda44` | https://thehosksaid.com + www |
| Ingestion | **your laptop** (residential IP) | see "Ingestion" below |

## Operating the server (on the VPS)

```bash
cd /opt/hosksaid
docker compose -f docker-compose.prod.yml up -d            # start stack
docker compose -f docker-compose.prod.yml restart web      # restart app
docker compose -f docker-compose.prod.yml logs -f web      # app logs
docker compose -f docker-compose.prod.yml ps               # health
```

## Ingestion (from your laptop — the only place it works)

YouTube blocks the VPS IP, so run the pipeline from your laptop's residential
connection, writing into the VPS database through an SSH tunnel.

1. **Open a tunnel** to the VPS Postgres (leave this terminal open):
   ```bash
   ssh -L 5432:127.0.0.1:5432 morganic@<vps-ip>
   ```
2. **In your local HoskSaid checkout**, ensure `.env` has:
   ```
   DATABASE_URL=postgres://hosksaid:<POSTGRES_PASSWORD>@localhost:5432/hosksaid
   OPENAI_API_KEY=...
   YOUTUBE_API_KEY=...
   DEFAULT_CHANNEL_ID=UCiJiqEvUZxT6isIaXK7RXTg
   ```
   (`<POSTGRES_PASSWORD>` is the value from the VPS `/opt/hosksaid/.env`.)
3. **Run the scripts** exactly as before:
   ```bash
   npm run ingest -- --channel=UCiJiqEvUZxT6isIaXK7RXTg --limit=20
   npm run enrich -- --limit=50
   npm run generate-embeddings -- --limit=50
   ```
   `yt-dlp` + `ffmpeg` must be installed locally for the Whisper fallback on
   caption-less videos (`brew install yt-dlp ffmpeg`).

To automate, add a `cron`/`launchd` job on the laptop that opens the tunnel
(`ssh -fNL ...`) then runs the three scripts. Kept manual by default.

## Why not automate on the VPS?

Tested 2026-05: 4/4 known-captioned videos returned NULL via `youtube-transcript`
from the VPS, and `yt-dlp` got "Sign in to confirm you're not a bot." A VPS-side
timer would just pile up `failed` rows. If you ever want VPS-side automation,
wire a residential proxy or a YouTube cookies file into `src/lib/transcript.ts`
and `src/lib/whisper.ts`, then re-add a systemd timer invoking the compose
`scheduler` profile.

## Data migration (already done; re-runnable)

`scripts/migrate-via-supabase-js.ts` pulls every row from Supabase via PostgREST
(IPv4, no SDK) and reloads local Postgres. Idempotent (truncates first). Needs
`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `DATABASE_URL` in env.
`scripts/parity-check.ts` verifies row counts match Supabase.

## File map

```
docker-compose.prod.yml          # postgres + web + scheduler (manual profile)
Dockerfile                       # multi-stage Next standalone (+ yt-dlp/ffmpeg)
docker/init-db.sql               # schema + pgvector + match_transcript_chunks
.env.example                     # template; copy to .env
src/lib/db.ts                    # Postgres adapter (replaced src/lib/supabase.ts)
src/lib/search-server.ts         # semantic/tag/hybrid search on db.ts
src/scripts/{ingest,enrich,generate-embeddings}.ts  # rewritten for Postgres
src/app/api/cron/ingest/route.ts # manual trigger (also IP-blocked on VPS)
scripts/migrate-via-supabase-js.ts # Supabase → local migration (PostgREST)
scripts/parity-check.ts          # row-count + embedding parity vs Supabase
scripts/smoke-test.ts            # exercises every db.ts helper
scripts/migrate-from-supabase.sh # pg_dump variant (needs IPv6 to Supabase)
```

## Rollback (cardano402 untouched throughout)

```bash
sudo cp /etc/cloudflared/config.yml.bak-pre-hosksaid /etc/cloudflared/config.yml
sudo systemctl restart cloudflared
docker compose -f docker-compose.prod.yml down -v   # also drops the DB volume
```
