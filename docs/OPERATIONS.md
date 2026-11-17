# HoskSaid operations

How to run, migrate and operate thehosksaid. Nothing in this document runs on its own: there is no installed cron entry and no automatic migration. Every step below is an explicit operator action.

## Operator CLI

```sh
npx tsx src/cli/hosk.ts                 # live summary: migrations, today's site-funded usage
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
| 008 | `client_usage_daily` (per-client daily allowance) | new table |

**Apply migrations before the new image goes live.** Run `migrate apply` (with the new image, e.g. `docker compose -f docker-compose.prod.yml run --rm web npx tsx src/cli/hosk.ts migrate apply`) and confirm `migrate` shows nothing pending before switching traffic to it. This release's code needs 003, 004, 005 and 008: without them Ask, `/api/search` and the MCP search tools return 500 (missing function or tables), and Library keyword search with `q` returns 500 (missing `search_tsv`). Every migration is additive, so the previous image keeps working against the migrated schema. Later schema changes follow the same order: migrate first, then activate the image that needs them.

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

Every call paid with the site's `OPENAI_API_KEY` passes a per-process concurrency gate, then one Postgres transaction that reserves against the calling client's daily allowance and then the site-wide daily cap. Both reservations are conditional upserts in the same transaction, so neither bound can be exceeded under concurrency or across processes, and a request refused by either bound charges nothing to the other.

| Setting | Default | Meaning |
|---|---|---|
| `SITE_DAILY_ANSWER_CAP` | 200 | site-model answers per UTC day (`0` disables) |
| `SITE_DAILY_EMBEDDING_CAP` | 2000 | query embeddings per UTC day (`0` disables) |
| `CLIENT_DAILY_ANSWER_CAP` | 20 | site-model answers per client per UTC day (`0` disables) |
| `CLIENT_DAILY_EMBEDDING_CAP` | 200 | query embeddings per client per UTC day (`0` disables) |
| `CLIENT_QUOTA_SECRET` | random per process | HMAC key for stored client identifiers; set it so allowances survive restarts |
| `SITE_MAX_CONCURRENT_CALLS` | 4 | in-flight site calls per process; queued callers wait up to 15 s, then `503 busy` |

When a cap is reached, Ask, search and MCP return `503 site_budget_exhausted` with `Retry-After` set to the next UTC midnight and `budget` naming the cap (`answer` or `embedding`). The embedding cap also blocks Ask, because every answer needs a query embedding; Library keyword search needs neither. Each Ask reserves its answer (client allowance and site cap together) before paying for retrieval, so a refused Ask makes no paid call even under concurrency; the reservation is handed back if the answer model is never called (no match, or retrieval refused or failed). Absent or invalid configuration falls back to the defaults. There is no "unlimited" value.

When one client's allowance is spent, that client gets `429 client_quota_exhausted` (same `budget` and `Retry-After` fields) and no paid call is made; other clients are unaffected. The client defaults are development values chosen well below the site caps. Production values are an activation decision for the operator.

A client is the rate limiter's identity: an allow-listed API key, otherwise the `CF-Connecting-IP` address when `TRUST_CLOUDFLARE_IP=true`. Limits of this identity:

- **Shared IPs:** everyone behind one address (an office, a carrier NAT, a VPN exit) shares one allowance.
- **No trusted IP:** without `TRUST_CLOUDFLARE_IP=true`, every anonymous visitor is the single client `anon`, so the anonymous per-client allowance becomes the whole anonymous allowance. Raise the client caps or enable the trusted header before relying on this.
- **Distributed clients:** someone using many addresses gets one allowance per address. The site cap still bounds the total.

`client_usage_daily` stores `(day, client, kind, calls)`. `client` is an HMAC-SHA256 of the UTC day and the identity under `CLIENT_QUOTA_SECRET`; the raw IP or API key is never written, and the value changes every day. Rows from earlier days are deleted by the application on the first reservation of each new UTC day, so the live table holds at most the current day (plus the previous day until the next paid call); database backups taken meanwhile still contain those rows.

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

`npx tsx src/cli/hosk.ts usage` shows today's site-wide counts.

## Visitor keys (bring your own key)

`POST /api/converse` lets a website visitor answer with their own OpenAI, Anthropic or OpenRouter key and an explicitly chosen model. It needs no configuration and no site credential.

- **Fixed hosts.** The server calls only `https://api.openai.com/v1/chat/completions`, `https://api.anthropic.com/v1/messages` or `https://openrouter.ai/api/v1/chat/completions`, through the official SDKs over a guarded transport that refuses any other URL, method or redirect. There are no custom provider URLs and no server requests to private networks. The CSP `connect-src` stays `'self'`: the browser only talks to this site.
- **No environment pickup.** The key is passed explicitly and the outgoing headers are rebuilt from an allow-list, so `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_CUSTOM_HEADERS`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`, workspace ids, profiles and base-URL overrides never reach the provider. SDK logging, telemetry and retries are off.
- **One attempt, no fallback.** A failure, timeout or refusal returns `502`/`504 provider_error` with a fixed `provider_error` code and message (`site_model_used: false`). It never retries on another model, another provider or the site's key. Provider error text is never echoed or logged; the log line is `[byok] <provider> call failed: <code>`.
- **Key handling.** The key travels in the `x-provider-key` header only, is used for that one call and is not stored, cached or logged. It is never used as an identity: rate limits, allowances and the in-flight limit key on the normal limiter identity. In the browser it lives in module memory only (no local/session storage, cookies or URL), with *Forget key*.
- **Same origin.** The route serves same-origin browser requests only (`Origin` must be this site; `Sec-Fetch-Site`, when sent, must be `same-origin`), so other sites cannot drive it.
- **Budgets.** Visitor answers never reserve, debit or wait on `SITE_DAILY_ANSWER_CAP` / `CLIENT_DAILY_ANSWER_CAP`. Retrieval still spends one site-funded query embedding under the normal embedding caps; when those are spent the response is `client_quota_exhausted` / `site_budget_exhausted` with `budget: "embedding"`, `retrieval_limited: true` and a `keyword_search` link, and the provider is not called. The concurrency gate is taken before retrieval, so a saturated gate refuses without spending an embedding.
- **Isolation.** Visitor questions and answers are not written to `answers`, not put in the answer cache, and their query embeddings are not added to the embedding cache (an existing cached vector may be reused).
- **Conversation.** The browser keeps the thread. A follow-up sends at most 4 earlier turns (answers ≤2000 characters) plus up to 12 cited segment ids per turn; the server re-fetches at most 6 of those ids and drops any that are missing or outside the conversation's video/date/topic scope. Earlier answers are passed as context marked "not evidence", and citations point only at segments supplied in the current call. An answer that cites nothing is returned with no sources (`grounded: false`).

| Setting | Default | Meaning |
|---|---|---|
| `BYOK_MAX_CONCURRENT_CALLS` | 4 | visitor-key provider calls in flight per process; queued callers wait up to 15 s, then `503 busy` |
| `BYOK_MAX_IN_FLIGHT_PER_CLIENT` | 2 | visitor-key requests one client may have open; more get `429 too_many_in_flight` |
| `BYOK_PROVIDER_TIMEOUT_MS` | 90000 | per-call provider timeout |

Per-call bounds: body ≤48 KiB, question ≤1000 characters, 12 context segments × ≤1500 characters, answer output ≤6000 tokens (reasoning tokens included, billed to the visitor).

**Activation:** the route ships with the code; there is nothing to configure. **Rollback:** redeploy the previous image. To disable the route alone, block `POST /api/converse` at the edge; the rest of the site is unaffected.

## Security and privacy

- **Proxy (`src/proxy.ts`)** sets a per-request nonce Content-Security-Policy on pages. With `CANONICAL_REDIRECTS=true` (set in the production Compose file) it also issues a 308 from `http` to `https`, using the tunnel's `X-Forwarded-Proto`, and from `www.` to the apex.
- **Static headers** (`next.config.ts`): HSTS (1 year, no `includeSubDomains`/preload), nosniff, `Referrer-Policy`, `X-Frame-Options: DENY`, COOP and `Permissions-Policy`. `x-powered-by` is off.
- **CSP rollout:** `CSP_REPORT_ONLY=true` sends the policy as report-only.
- **Cron route:** `/api/cron/ingest` accepts the secret only in the `x-cron-secret` header, compared in constant time.
- **Privacy page:** `/privacy` describes actual storage. Keep it in step with the code. Questions are retained indefinitely until a retention policy is approved. No deletion sweep exists.

## Caching

- Pages render dynamically so the CSP nonce can be applied.
- Public browse data is memoised in process: catalogue lists and topics for 120 s, archive stats for 600 s. `PUBLIC_DATA_CACHE_SECONDS` overrides this.
- Questions, answers, keys and operator data are never put in the public memo. Visitor-key answers are never cached at all. The separate 5-minute answer cache is keyed by the normalised question text, filters and citation flag, so it only returns an answer to someone who sent that same question.
- Within one request, the video page reads the video once (React `cache()`), shared by metadata and the page.
