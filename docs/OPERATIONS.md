# HoskSaid operations

How to run, migrate and operate thehosksaid. Nothing in this document runs on its own: there is no installed cron entry and no automatic migration. Every step below is an explicit operator action. The one schedulable job, monthly blog drafts, ships as an opt-in compose service that is off by default (see [Monthly blog drafts](#monthly-blog-drafts)).

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
| 009 | `posts`, `post_events`, `post_video_notes`, `post_generation_runs`, `post_generation_budget` (monthly drafts) | new tables |

**Apply migrations before the new image goes live.** Run `migrate apply` (with the new image, e.g. `docker compose -f docker-compose.prod.yml run --rm web npx tsx src/cli/hosk.ts migrate apply`) and confirm `migrate` shows nothing pending before switching traffic to it. This release's code needs 003, 004, 005 and 008: without them Ask, `/api/search` and the MCP search tools return 500 (missing function or tables), and Library keyword search with `q` returns 500 (missing `search_tsv`). The `posts` CLI and the monthly scheduler need 009; until it is applied `/blog` shows no posts. Every migration is additive, so the previous image keeps working against the migrated schema. Later schema changes follow the same order: migrate first, then activate the image that needs them.

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

## Security and privacy

- **Proxy (`src/proxy.ts`)** sets a per-request nonce Content-Security-Policy on pages. With `CANONICAL_REDIRECTS=true` (set in the production Compose file) it also issues a 308 from `http` to `https`, using the tunnel's `X-Forwarded-Proto`, and from `www.` to the apex.
- **Static headers** (`next.config.ts`): HSTS (1 year, no `includeSubDomains`/preload), nosniff, `Referrer-Policy`, `X-Frame-Options: DENY`, COOP and `Permissions-Policy`. `x-powered-by` is off.
- **CSP rollout:** `CSP_REPORT_ONLY=true` sends the policy as report-only.
- **Cron route:** `/api/cron/ingest` accepts the secret only in the `x-cron-secret` header, compared in constant time.
- **Privacy page:** `/privacy` describes actual storage. Keep it in step with the code. Questions are retained indefinitely until a retention policy is approved. No deletion sweep exists.

## Caching

- Pages render dynamically so the CSP nonce can be applied.
- Public browse data is memoised in process: catalogue lists and topics for 120 s, archive stats for 600 s. `PUBLIC_DATA_CACHE_SECONDS` overrides this.
- Questions, answers, keys and operator data are never put in the public memo. The separate 5-minute answer cache is keyed by the normalised question text, filters and citation flag, so it only returns an answer to someone who sent that same question.
- Within one request, the video page reads the video once (React `cache()`), shared by metadata and the page.

## Monthly blog drafts

**Source material:** every video published in the calendar month (half-open local window `[1st 00:00, next 1st 00:00)` in `MONTHLY_DRAFT_TIMEZONE`). Completed videos contribute their stored summary and transcript excerpts; videos not yet processed, or with no stored text, are listed as missing. Visitors' questions (`answers`) and external feeds are never read.

**How a draft is made** (bounded, coverage-preserving):

1. One notes call per video, with only that video's material: its summary (≤2,000 chars) and up to 16 evenly spaced transcript excerpts (≤900 chars each, ≤16,000 chars per video in total). Longer transcripts are sampled, and the draft records how much was used. Valid notes are cached by the exact material, so a retry pays only for videos that did not finish.
2. If the notes exceed one synthesis input (60,000 chars), reduce calls condense contiguous groups of videos (≤2 levels).
3. One final call writes the title, intro and 3–6 themed sections.
4. Any video with notes that the synthesis did not cite is added under **Also this month**, using its own note. No processed video is silently dropped.

**Checks:**

- Every statement must cite ids from the supplied material: `S3` for a video, `S3.2` for a timed moment.
- Every statement must also pass the evidence check against the cited text. Numbers and names must appear in that text, and at least half of its content words must too.
- Anything else is rejected and recorded with a reason. Timestamps come from the database, and only real timings (inside the video) are linked.

The evidence check is lexical: it catches invented specifics and off-source paraphrase, not every distortion. Review the evidence before publishing.

**Bounds:**

- The whole run is planned before the first call.
- A plan over the per-run limit (150 calls) or over the month's remaining `MONTHLY_DRAFT_CALL_BUDGET` is refused with zero calls. The plan sizes every notes and reduce block at its worst case (full-length text, the maximum citations at the longest ids), and a run never makes more calls than its plan.
- Each call is reserved against the budget atomically, so neither retries nor concurrent runs can exceed it.
- Output is capped at 700 tokens per notes call, 1,800 per reduce call and 3,000 for the final call.
- There is no default budget and no "unlimited" setting.

```sh
npx tsx src/cli/hosk.ts posts generate --month previous --dry-run    # inputs, missing videos, call plan; no model call
npx tsx src/cli/hosk.ts posts generate --month 2026-10                # needs OPENAI_API_KEY + MONTHLY_DRAFT_CALL_BUDGET
npx tsx src/cli/hosk.ts posts show 2026-10                            # coverage, rejections, revision, events
npx tsx src/cli/hosk.ts posts preview 2026-10 --format html --out review.html   # PRIVATE review page with cited evidence
npx tsx src/cli/hosk.ts posts publish 2026-10 --by <name> --revision <n> [--accept-incomplete]
npx tsx src/cli/hosk.ts posts withdraw 2026-10 --by <name>
```

**Rules:**

- **One post per month.** `UNIQUE(kind, period)`. Concurrent runs for the same month are serialised by an advisory lock; the loser reports `busy` and does nothing.
- **Safe retries.** Unchanged inputs make no model call. A draft whose videos failed (`model_failed`, `not_attempted`) retries only those videos; if they still produce no usable notes, the body and sources are not rewritten and no synthesis call is made. A retry that fails the same way leaves the draft and its revision as they were (`unchanged`); one that only changes a video's missing reason (for example to *no statement passed the source check*) updates the coverage alone, as a new revision recorded in `post_events`, so the next recheck does not pay for it again. Only a *draft* is regenerated, for example after late ingestion. Published and withdrawn posts are reported as `kept`, together with any videos published since.
- **Visible incompleteness.** Every post stores coverage: videos in the window, videos covered, and missing videos with a reason. Pages print it ("Covers 10 of 12 videos…"). Publishing an incomplete month needs `--accept-incomplete`.
- **Nothing misleading is written.** An empty month, a month with no grounded notes, or unusable synthesis output writes no post.
- **Strict output.** Every generated draft is validated whole before it is stored: oversized text, too many sections or paragraphs, bad or unknown citations, and line breaks fail the run; nothing is trimmed or dropped.
- **Explicit publication.** `publish` names the reviewed revision and records `--by`. Every generation, publish and withdrawal is in `post_events`. There is no web admin and no mutation route.
- **Public surfaces.** `/blog` and `/blog/<YYYY-MM>` show **published** posts only, from public columns only. Generation metadata (model, limits, rejections) stays in the CLI.

### Schedule (opt-in, off by default)

The `monthly-drafts` compose service runs `posts schedule run`. It checks every `MONTHLY_SCHEDULE_CHECK_MINUTES` (60) and drafts each closed month once due: day `MONTHLY_SCHEDULE_DAY` (1) of the next month at `MONTHLY_SCHEDULE_HOUR` (06:00), local to `MONTHLY_DRAFT_TIMEZONE`.

- **Missed runs.** The last `MONTHLY_SCHEDULE_CATCHUP_MONTHS` (2) closed months are considered on every check, so a scheduler that was down on the day catches up when it next runs.
- **Rechecks.** A month checked within `MONTHLY_SCHEDULE_RECHECK_HOURS` (24) is skipped. After that it is re-run: a no-op unless a draft's inputs changed or its failed videos now produce notes.
- **Never publishes, never emails.** It is not coupled to any newsletter.

**Timezone.** `UTC` is the development default until the production zone is confirmed. `posts schedule status` labels it as the default.

**Activation** needs approval and is a production action. Nothing here has been done.

```sh
# .env: MONTHLY_DRAFT_CALL_BUDGET=<approved calls/month>, MONTHLY_DRAFT_TIMEZONE=<zone>,
#       MONTHLY_DRAFTS_SCHEDULE_ENABLED=true   (OPENAI_API_KEY is already set)
docker compose -f docker-compose.prod.yml exec web npx tsx src/cli/hosk.ts migrate apply
docker compose -f docker-compose.prod.yml exec web npx tsx src/cli/hosk.ts posts schedule status
docker compose -f docker-compose.prod.yml exec web npx tsx src/cli/hosk.ts posts schedule run --once --dry-run
docker compose -f docker-compose.prod.yml --profile monthly-drafts up -d monthly-drafts
docker logs hosksaid-monthly-drafts
```

The service needs both switches: the profile **and** `MONTHLY_DRAFTS_SCHEDULE_ENABLED=true`.

- With the flag off it prints `disabled (no-op)` and exits 0, so it stays stopped.
- With the budget or key missing it exits 78 and names the missing variables, never their values.

**Rollback:** `docker compose -f docker-compose.prod.yml --profile monthly-drafts stop monthly-drafts` (or set the flag to `false`). Drafts already written stay drafts. `posts withdraw` unpublishes a post.
