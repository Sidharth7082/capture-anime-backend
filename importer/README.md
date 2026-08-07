# CaptureOrDie Importer

Standalone TypeScript service that pulls anime data from your **local Jikan
instance** and stores it for the CaptureOrDie platform (PostgreSQL + an
optional Typesense search index).

It lives in its own folder with its own `package.json`/`tsconfig.json` and is
**completely independent** from the Express API in `src/` — it only shares the
database.

> ⚠️ **Stages 1–2 implemented, Stage 3 (search) ready-to-enable.** The importer
> fetches the full Jikan catalogue through a reusable pipeline (fetch →
> normalize → validate → upsert → sink), writes the `anime` table by MAL id,
> **and links all six metadata groups (genres, studios, producers, licensors,
> themes, demographics) in the same per-anime transaction**. Resume support
> (`import_jobs`) is in place and the Typesense sink is wired (flip
> `TYPESENSE_ENABLED=true`). Characters, episodes, relations, pictures and
> trailers are **not** imported yet.

## Pipeline

Every data source (Jikan today; MAL user lists, AniList, TMDB, MangaDex,
Kitsu later) plugs into the same pipeline — a new source only provides a
**Fetcher** and a **Normalizer**:

```text
Source (Jikan)              pipeline/                platform
        │
        ▼
  fetchers.ts ──► normalizers.ts ──► validator.ts ──► upsert-service.ts ──► PostgreSQL
        │                            (zod)               │                 (anime +
        │                                                 │                  genres,
        └────────────  runner.ts (pages, resume,          │                  studios,
                       bookkeeping, cancel) ──► job-store.ts (import_jobs)  producers…)
                                                  │
                                                  ▼
                                          typesense.ts sink (per page)
```

```
importer/
├── src/
│   ├── metrics.ts           # in-memory counters + last/current run (health)
│   ├── health.ts            # GET /health endpoint (node:http)
│   ├── index.ts              # daemon entrypoint: env validation, wiring, shutdown
│   ├── run-import.ts         # CLI: one-shot anime import (see below)
│   ├── jikan.ts              # Jikan v4 API client (axios, timeout, retry, types)
│   ├── database.ts           # PostgreSQL pool wrapper (query, transaction, ping)
│   ├── typesense.ts          # optional search-index client + no-op pipeline sink
│   ├── importer.ts           # composition root: wires the Jikan anime source
│   ├── scheduler.ts          # interval scheduler with overlap guard
│   └── pipeline/
│       ├── types.ts          # Fetcher / Normalizer / Validator / UpsertPort /
│       │                     #   Sink / JobStore contracts + NormalizedAnime
│       ├── fetchers.ts       # JikanAnimeFetcher (other sources add one here)
│       ├── normalizers.ts    # Jikan → platform row + 6 metadata arrays (pure)
│       ├── validator.ts      # zod schema enforcing the anime + metadata contract
│       ├── upsert-service.ts # anime + metadata upsert by mal_id (one txn)
│       ├── job-store.ts      # import_jobs persistence (+ no-op for dry-run)
│       ├── runner.ts         # generic pipeline: pagination, resume, counters
│       └── *.test.ts         # normalizer / validator / runner unit tests
├── package.json
├── tsconfig.json
├── .env.example
├── Dockerfile
└── README.md
```

## Requirements

- Node.js ≥ 20
- A reachable Jikan instance (default `http://192.168.0.193:8081`)
- PostgreSQL (same database as the CaptureOrDie API)

## Setup

```bash
cd importer
cp .env.example .env      # fill in DATABASE_URL, Jikan URL, etc.
npm install
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | watch mode via `tsx` (auto-restart on change) |
| `npm run build` | type-check + compile to `dist/` (ESM) |
| `npm run start` | run the compiled daemon (`node dist/index.js`) |
| `npm run import:anime` | one-shot anime catalogue import (see below) |
| `npm run typecheck` | type-check only, no emit |
| `npm test` | unit tests (normalization) |

## Importing anime (Stage 1)

```bash
npm run import:anime                       # full catalogue (resumes)
npm run import:anime -- --limit 200        # first 200 titles (test first!)
npm run import:anime -- --maxPages 5       # first 5 pages
npm run import:anime -- --dry-run          # fetch + normalize, NO DB writes
npm run import:anime -- --reset            # ignore the saved resume point
```

How it works:

1. The **pipeline runner** (`pipeline/runner.ts`) drives the Jikan source:
   fetch page → normalize → validate (zod) → upsert by `mal_id` (per-row
   transaction) → per-page progress persisted.
2. Iterates `GET /v4/anime?page={page}` until `pagination.has_next_page` is
   false (sequential, with a polite per-page delay —
   `JIKAN_PAGE_DELAY_MS`).
3. Logs every page: `page N: +inserted / ~updated / !failed (fetched)`.
4. `Ctrl-C` (SIGINT/SIGTERM) stops at the next page boundary; upserts are
   idempotent, so re-running resumes cleanly.

### Resume support

After every successful page the runner writes `last_page` into the
`import_jobs` table (one row per source). A crash on page 1,247 therefore
resumes at page **1,248** on the next run — no re-fetching. `--reset`
starts from page 1; dry-runs never touch the job table. Job rows record
`status` (`running` / `completed` / `failed`), `total_items`,
`started_at` / `finished_at` and the last `error`, so you can inspect the
history per source:

```sql
SELECT source, status, last_page, total_items, started_at, finished_at
FROM import_jobs;
```

> **Migrations required once** (apply from the repo root with
> `npm run migrate`):
> - `0007_importer_anime_id` — `anime.anilist_id` nullable (Jikan titles have
>   no AniList id) + `anime_id_mal_idx`
> - `0008_import_jobs` — resume/progress table

Covered fields: mal_id, titles (romaji/english/native/synonyms), description,
type→format, status, source, episodes, duration, aired dates, season/year,
score (×10 → 0–100), members→popularity, favorites, is_adult (Rx rating),
cover images, and **all six metadata groups** (genres, studios, producers,
licensors, themes, demographics — linked + pruned per anime). Everything
else (trailers, banner, characters, episodes rows) stays untouched for
later stages.

### Stage 2 metadata (genres · studios · producers · licensors · themes · demographics)

Jikan list items embed all six arrays, so metadata rides along with every
anime row — **no extra API calls**. For each anime, inside the same
per-row transaction:

1. Each metadata row is resolved by `mal_id`, then by `name` (this links
   genres/studios already imported from AniList), else inserted.
2. Join rows are written (`anime_genres`, `anime_studios`, `anime_producers`, …)
   with `ON CONFLICT DO NOTHING`.
3. Stale joins Jikan no longer lists are pruned, so the DB mirrors MAL
   exactly.

> **Migration required once**: `0009_metadata_tables` adds `mal_id` to
> `genres`/`studios` and creates `producers`, `licensors`, `themes`,
> `demographics` (+ their join tables). Apply with `npm run migrate` from the
> repo root.

### Typesense search index (Stage 3)

Set `TYPESENSE_ENABLED=true` (+ `TYPESENSE_URL`, `TYPESENSE_API_KEY`). The
runner feeds every completed page into the sink, which:

- creates the `anime` collection on first use (schema in
  `ANIME_COLLECTION_FIELDS`, `default_sorting_field: popularity`),
- upserts documents keyed `anime:{mal_id}` (stable across reimports),
- flattens genres/studios/producers/licensors/themes/demographics into
  `string[]` facets and strips HTML from the synopsis.

### Observability

- **Structured logs** — `LOG_FORMAT=json` emits one JSON object per line
  (`{ts, level, msg, source, page, inserted, …}`), `pretty` for local dev.
- **Metrics** — the daemon records current page + counters and the last run
  (counts, duration, status) in memory (`metrics.ts`).
- **Health endpoint** — `GET :HEALTH_PORT/health` (default 9090) reports
  uptime, the current/last import, the next scheduled run and the
  `import_jobs` table:

```bash
curl http://localhost:9090/health
# {"status":"ok","uptimeSeconds":…,"import":{…},"jobs":[…]}
```

## Configuration (`.env`)

| Var | Default | Notes |
|---|---|---|
| `JIKAN_API_URL` | `http://192.168.0.193:8081` | base URL of the local Jikan v4 API |
| `JIKAN_TIMEOUT_MS` | `15000` | per-request timeout |
| `JIKAN_RETRY_COUNT` | `3` | retries with backoff (429-aware) |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `PG_POOL_MAX` | `5` | pool size |
| `TYPESENSE_ENABLED` | `false` | `true` indexes every imported page |
| `TYPESENSE_URL` / `TYPESENSE_API_KEY` / `TYPESENSE_COLLECTION` | — | Typesense connection |
| `RUN_ON_START` | `true` | run one import immediately at boot |
| `SCHEDULER_ENABLED` | `true` | run imports on an interval |
| `SCHEDULER_INTERVAL_MS` | `3600000` | interval between runs |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_FORMAT` | json (prod) / pretty (dev) | structured vs human-readable logs |
| `HEALTH_ENABLED` / `HEALTH_PORT` | `true` / `9090` | health endpoint |

Invalid/missing required vars fail **at boot** with the exact missing key
(zod validation) — never halfway through a run.

## Docker

```bash
cd importer
docker build -t capture-anime-importer .
docker run --rm --env-file .env capture-anime-importer
```

The image is multi-stage (compile in `node:22-alpine`, run as non-root with
production deps only). Compose users can add:

```yaml
  importer:
    build: ./importer
    env_file: ./importer/.env
    restart: unless-stopped
```

## Implementing the importer (next steps)

All stages go in `src/importer.ts` as separate methods, each unit-testable in
isolation:

1. **Fetch** — paginate `JikanClient.getJson` over the endpoints you need
   (e.g. `/top/anime`, `/seasons/now`, `/anime?page=N`) using the
   `JikanPage<T>` envelope (`pagination.has_next_page`).
2. **Normalize** — map Jikan shapes to the platform's canonical record
   (id, titles, images, genres, studios, dates, scores, synopsis, ...).
3. **Persist** — idempotent upserts (`ON CONFLICT`) via `Database.query`.
   Reuse the API's existing tables; never create ad-hoc schema.
4. **Index** — when `TYPESENSE_ENABLED`, mirror normalized records into the
   configured collection (keep the no-op path when disabled).

Design rules:

- The importer never imports the Express API's modules — only the database
  and Jikan/Typesense are shared concerns.
- All HTTP goes through `JikanClient` (single timeout/retry policy).
- All SQL goes through `Database.query` (parameterized).
- Runs must be idempotent and re-runnable (the scheduler may overlap-free
  re-run them hourly).
