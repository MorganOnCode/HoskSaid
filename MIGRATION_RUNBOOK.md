# HoskSaid migration runbook

Self-hosted on this VPS, replacing Vercel + Supabase.

## Stack at a glance

| Layer | Where | How to reach |
| --- | --- | --- |
| Next.js app (`hosksaid-web`) | docker compose, bound to `127.0.0.1:3001` | `curl http://127.0.0.1:3001/` |
| Postgres + pgvector (`hosksaid-postgres`) | docker compose, internal network only | `docker compose -f docker-compose.prod.yml exec postgres psql -U hosksaid` |
| Public DNS | Cloudflare tunnel `f54b9704-…dfda44` | `thehosksaid.com` → `http://localhost:3001` *(pending DNS, see below)* |
| Daily ingest | systemd `hosksaid-ingest.timer` (04:00 UTC) | `journalctl -u hosksaid-ingest -f` |

## Day-to-day

```bash
cd /opt/hosksaid

# Bring up / restart the stack
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml restart web

# Logs
docker compose -f docker-compose.prod.yml logs -f web
docker compose -f docker-compose.prod.yml logs -f postgres

# Run the pipeline by hand (channel ID + limit are optional)
docker compose -f docker-compose.prod.yml --profile scheduler run --rm scheduler

# Or a single step
docker compose -f docker-compose.prod.yml --profile scheduler run --rm scheduler \
  npx tsx src/scripts/ingest.ts --channel=UCiJiqEvUZxT6isIaXK7RXTg --limit=10
```

## Remaining manual steps (in order)

1. **Add API keys to `.env`** (`OPENAI_API_KEY`, `YOUTUBE_API_KEY`). Without these
   the scheduler and `/api/cron/ingest` fail.

2. **Migrate Supabase data**
   ```bash
   SUPABASE_DB_URL="postgresql://postgres:<pw>@db.<project-ref>.supabase.co:5432/postgres" \
     ./scripts/migrate-from-supabase.sh
   ```
   The connection string is the *direct* one from
   Supabase Dashboard → Project Settings → Database → Connection string. If
   the VPS has no IPv6, switch to the pooler in "Session" mode (port 5432).

3. **Activate the daily timer**
   ```bash
   sudo systemctl enable --now hosksaid-ingest.timer
   systemctl list-timers hosksaid-ingest.timer
   ```

4. **Public DNS for `thehosksaid.com`**
   *Pre-req:* the domain must be added as a zone on the Cloudflare account that
   owns this tunnel's `cert.pem` (the cardano402 account). Add via dashboard,
   change nameservers at the registrar, wait for "Active" status, then:
   ```bash
   cloudflared tunnel route dns f54b9704-3347-47a2-8a45-975721dfda44 thehosksaid.com
   cloudflared tunnel route dns f54b9704-3347-47a2-8a45-975721dfda44 www.thehosksaid.com
   ```
   Then delete the stray `thehosksaid.com.cardano402.com` CNAME that was
   created on the first attempt (Cloudflare dashboard → DNS for cardano402.com).

5. **Decommission Supabase**: once `/api/videos` and `/search` look correct via
   the public URL, cancel the Supabase paid sub.

## File map (new + changed)

```
docker-compose.prod.yml          # postgres + web + scheduler (profile)
Dockerfile                       # multi-stage Next standalone
docker/init-db.sql               # schema + pgvector + RPC function
.env.example                     # template; copy to .env
src/lib/db.ts                    # NEW — replaces src/lib/supabase.ts (deleted)
src/lib/search-server.ts         # rewritten against db.ts
src/scripts/{ingest,enrich,generate-embeddings}.ts  # rewritten
src/app/api/cron/ingest/route.ts # rewritten
systemd/hosksaid-ingest.{service,timer}             # installed to /etc/systemd/system
scripts/migrate-from-supabase.sh # one-shot Supabase → local dump+restore
scripts/smoke-test.ts            # exercises every db.ts helper end-to-end
```

## Rollback (cardano402 stays untouched throughout)

```bash
sudo cp /etc/cloudflared/config.yml.bak-pre-hosksaid /etc/cloudflared/config.yml
sudo systemctl restart cloudflared
docker compose -f docker-compose.prod.yml down -v   # nukes the postgres volume too
```
