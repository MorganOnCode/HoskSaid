# HoskSaid operations

How to run, migrate and operate thehosksaid. Nothing in this document runs on its own: there is no installed cron entry, no automatic migration and no automatic sending. Every step below is an explicit operator action.

## Operator CLI

```sh
npx tsx src/cli/hosk.ts                 # live summary: migrations, posts, issues, usage
npx tsx src/cli/hosk.ts <command> --help
```

The CLI reads `DATABASE_URL` from the environment or `.env`. On the VPS that is `localhost:5432` (loopback bind). Inside the web container it is already set:

```sh
docker compose -f docker-compose.prod.yml exec web npx tsx src/cli/hosk.ts
```

Output is TOON on stdout. Errors are structured on stdout too, with exit code 1 for failures and 2 for usage errors. Unknown flags are rejected, never ignored.

## Schema migrations

Migrations live in `docker/migrations/NNN-name.sql`. Each is idempotent, and the runner records it in `schema_migrations` with a checksum. Rollback scripts are in `docker/migrations/rollback/`.

```sh
npx tsx src/cli/hosk.ts migrate                   # status
npx tsx src/cli/hosk.ts migrate apply --dry-run   # what would run
npx tsx src/cli/hosk.ts migrate apply             # apply in order
```

| Version | What | Locking |
|---|---|---|
| 001 | Handoff schema (already in production; re-applying is a no-op) | — |
| 002 | `idx_transcript_chunks_video` (`CREATE INDEX CONCURRENTLY`) | none for readers or writers |
| 003 | Exact, scoped retrieval function; legacy function delegates to it | brief catalogue lock |
| 004 | `site_usage_daily` (daily paid-call cap) | new table |
| 005 | `transcripts.search_tsv` column + maintenance trigger | brief (catalogue-only `ADD COLUMN`) |
| 006 | Backfill `search_tsv` | row locks only; writers to `transcripts` wait ~10 s, readers never |
| 007 | GIN index on `search_tsv` (`CONCURRENTLY`) | none |

A fresh volume runs `docker/init-db.sql` on first boot. Run `migrate apply` afterwards.

Files marked `-- hosk:no-transaction` run outside a transaction and hold a single statement. If a concurrent index build is interrupted, `migrate status` lists the INVALID index. Drop it and re-apply.

## Retrieval

Ask, `/api/search` and the MCP search tools rank by **exact** cosine distance (`match_transcript_chunks_scoped`). They do not use the `ivfflat` index, because at `probes = 1` it returned the wrong neighbours. Scope filters run in SQL before ranking:

- video ids
- a half-open UTC date window
- topic slugs

At about 10k chunks an exact search takes roughly 90 ms on a production-shaped fixture. Past roughly 50k chunks, consider an HNSW index with iterative scans and re-measure recall against exact search first.

Videos without chunks are not reachable by Ask. They are reachable by Library keyword search, which covers titles, tags and full transcripts. Video pages say so instead of offering a scoped Ask that cannot succeed.

### Coverage and backfill (costs money: needs approval)

```sh
npx tsx src/cli/hosk.ts coverage                                   # read-only report + estimate
npx tsx src/scripts/generate-embeddings.ts --dry-run --limit=400   # no API calls
npx tsx src/scripts/generate-embeddings.ts --limit=50 --max-chunks=2000   # paid; bounded
```

The backfill is resumable. Each video's chunks are written in one transaction, so a stopped run never leaves a half-embedded video. Topic, type and chapter enrichment (`assign-topics`, `classify-video-type`, `derive-chapters`) are separate paid passes.

## Paid-call bounds

Every call paid with the site's `OPENAI_API_KEY` passes two guards: a per-process concurrency gate, then a reservation against a daily cap in Postgres. The reservation is a conditional upsert, so it is safe under concurrency and across processes.

| Setting | Default | Meaning |
|---|---|---|
| `SITE_DAILY_ANSWER_CAP` | 200 | site-model answers per UTC day (`0` disables) |
| `SITE_DAILY_EMBEDDING_CAP` | 2000 | query embeddings per UTC day (`0` disables) |
| `SITE_MAX_CONCURRENT_CALLS` | 4 | in-flight site calls per process; queued callers wait up to 15 s, then `503 busy` |

When the cap is reached, Ask, search and MCP return `503 site_budget_exhausted` with `Retry-After` set to the next UTC midnight. Absent or invalid configuration falls back to the defaults. There is no "unlimited" value.

Per-call bounds:

| Bound | Value |
|---|---|
| Query length | 1000 characters |
| Ask body | 16 KiB |
| MCP body | 64 KiB |
| Messages per MCP POST | 8; each one charged to the rate limiter and handled one at a time |
| Context per answer | 12 segments × ≤1500 characters |
| Answer output | ≤1100 tokens |
| Provider timeout | 45 s, with no SDK retries |

Repeated questions are served from a 5-minute in-memory answer cache, and repeated queries reuse cached embeddings.

**These are call counts, not money.** The OpenAI project budget alert and hard limit remain the only spend ceiling. Set them in the provider dashboard.

`npx tsx src/cli/hosk.ts usage` shows today's counts.

## Security and privacy

- **Proxy (`src/proxy.ts`)** sets a per-request nonce Content-Security-Policy on pages. With `CANONICAL_REDIRECTS=true` (set in the production Compose file) it also issues a 308 from `http` to `https`, using the tunnel's `X-Forwarded-Proto`, and from `www.` to the apex.
- **Static headers** (`next.config.ts`): HSTS (1 year, no `includeSubDomains`/preload), nosniff, `Referrer-Policy`, `X-Frame-Options: DENY`, COOP and `Permissions-Policy`. `x-powered-by` is off.
- **CSP rollout:** `CSP_REPORT_ONLY=true` sends the policy as report-only.
- **Cron route:** `/api/cron/ingest` accepts the secret only in the `x-cron-secret` header, compared in constant time.
- **Privacy page:** `/privacy` describes actual storage. Keep it in step with the code. Questions are retained indefinitely until a retention policy is approved. No deletion sweep exists.

## Caching

- Pages render dynamically so the CSP nonce can be applied.
- Public browse data is memoised in process: catalogue lists and topics for 120 s, archive stats for 600 s. `PUBLIC_DATA_CACHE_SECONDS` overrides this.
- Answers, keys, subscriber data and operator data are never cached publicly.
