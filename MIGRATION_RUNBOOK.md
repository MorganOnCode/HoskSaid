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

## Schema migrations (on the VPS)

`docker/init-db.sql` only runs on a **fresh** volume. To evolve the **live** DB,
apply the additive, idempotent files in `docker/migrations/` by hand:

```bash
cd /opt/hosksaid
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U hosksaid -d hosksaid -v ON_ERROR_STOP=1 < docker/migrations/001-handoff-schema.sql
```

`001-handoff-schema.sql` adds: `transcripts.segments`, `videos.video_type` +
`videos.chapters`, `transcript_chunks.speaker`, the `topics`/`video_topics` and
`answers` tables (+ a curated topic seed), loosens the `transcripts.source`
CHECK, and extends `match_transcript_chunks()` to also return `end_time`. It is
additive only and safe to re-run.

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

## Timestamp backfill (laptop — required for seek/deep-links on old videos)

The archive was ingested before `transcripts.segments` existed, so existing
`transcript_chunks` are **untimed** (`start_time` NULL) and there is no way to
retrofit timestamps from the stored plain text. Re-fetch transcripts (captures
timed cues) and rebuild the chunks. yt-dlp now captures timing automatically;
`--reingest` forces re-fetch of already-`completed` videos.

1. Apply the schema migration above (adds the `segments` column).
2. Open the SSH tunnel and set `DATABASE_URL` as in "Ingestion" above.
3. **Pilot (~50 videos):**
   ```bash
   npm run ingest -- --channel=UCiJiqEvUZxT6isIaXK7RXTg --limit=50 --reingest
   psql "$DATABASE_URL" -c "DELETE FROM transcript_chunks;"   # clears old untimed chunks
   npm run generate-embeddings -- --limit=50
   ```
   Verify: `psql "$DATABASE_URL" -c "SELECT count(*) FILTER (WHERE start_time IS NOT NULL) AS timed, count(*) FROM transcript_chunks;"`
4. **Full archive (multi-session, rate-limited):** `npm run ingest -- --channel=UCiJiqEvUZxT6isIaXK7RXTg --reingest` in batches, then `DELETE FROM transcript_chunks;` and `npm run generate-embeddings -- --limit=1000`.

`DELETE FROM transcript_chunks` briefly empties Ask until the re-embed finishes.
The ~52 caption-less videos fall back to Whisper (timed segments too). Embeddings
have no YouTube dependency, so `generate-embeddings` can also run on the VPS.

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
