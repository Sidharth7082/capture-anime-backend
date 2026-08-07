# CaptureOrDie Importer

Standalone TypeScript service that pulls anime data from your **local Jikan
instance** and stores it for the CaptureOrDie platform (PostgreSQL + an
optional Typesense search index).

It lives in its own folder with its own `package.json`/`tsconfig.json` and is
**completely independent** from the Express API in `src/` — it only shares the
database.

> ⚠️ **Stage 1 — anime import implemented.** The importer now fetches the full
> Jikan catalogue, normalizes each title and upserts it into the platform's
> `anime` table by MAL id. Characters, episodes, studios, genres, relations,
> themes, pictures, trailers and Typesense are **not** imported yet — they
> arrive in later stages.

## Layout

```
importer/
├── src/
│   ├── index.ts        # daemon entrypoint: env validation, wiring, shutdown
│   ├── run-import.ts   # CLI: one-shot anime import (see "Importing anime")
│   ├── jikan.ts        # Jikan v4 API client (axios, timeout, retry, types)
│   ├── database.ts     # PostgreSQL pool wrapper (query, transaction, ping)
│   ├── typesense.ts    # optional search-index client (no-op when disabled)
│   ├── importer.ts     # Stage 1: normalizeAnimeItem + importAnime (upsert by mal_id)
│   ├── scheduler.ts    # interval scheduler with overlap guard
│   └── importer.test.ts# normalization unit tests
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
npm run import:anime                       # full catalogue
npm run import:anime -- --limit 200        # first 200 titles (test first!)
npm run import:anime -- --maxPages 5       # first 5 pages
npm run import:anime -- --dry-run          # fetch + normalize, NO DB writes
```

How it works:

1. Iterates `GET /v4/anime?page={page}` on the configured Jikan server until
   `pagination.has_next_page` is false (sequential, with a polite per-page
   delay — `JIKAN_PAGE_DELAY_MS`).
2. Normalizes each title into the platform's `anime` row shape
   (`src/importer.ts` — `normalizeAnimeItem`, unit-tested).
3. Upserts **by MAL id** inside a per-row transaction: updates the existing
   row when `anime.id_mal` matches, otherwise inserts a new row (with a NULL
   `anilist_id` — see the migration note below).
4. Logs every page: `page N: +inserted / ~updated / !failed (fetched)`.
5. `Ctrl-C` (SIGINT/SIGTERM) stops at the next page boundary; upserts are
   idempotent, so re-running resumes cleanly.

> **Migration required once** (applies to the shared database, in the repo
> root): `db/migrations/0007_importer_anime_id.up.sql` makes `anime.anilist_id`
> nullable (Jikan titles have no AniList id) and indexes `anime.id_mal`.
> Apply with the repo's normal migration runner (`npm run migrate`).

Covered fields (Stage 1): mal_id, titles (romaji/english/native/synonyms),
description, type→format, status, source, episodes, duration, aired dates,
season/year, score (×10 → 0–100), members→popularity, favorites, is_adult
(Rx rating), cover images. Everything else (trailers, banner, genres,
studios, characters, episodes rows, Typesense) stays untouched for later
stages.

## Configuration (`.env`)

| Var | Default | Notes |
|---|---|---|
| `JIKAN_API_URL` | `http://192.168.0.193:8081` | base URL of the local Jikan v4 API |
| `JIKAN_TIMEOUT_MS` | `15000` | per-request timeout |
| `JIKAN_RETRY_COUNT` | `3` | retries with backoff (429-aware) |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `PG_POOL_MAX` | `5` | pool size |
| `TYPESENSE_ENABLED` | `false` | set `true` when the search step is implemented |
| `TYPESENSE_URL` / `TYPESENSE_API_KEY` / `TYPESENSE_COLLECTION` | — | Typesense connection |
| `RUN_ON_START` | `true` | run one import immediately at boot |
| `SCHEDULER_ENABLED` | `true` | run imports on an interval |
| `SCHEDULER_INTERVAL_MS` | `3600000` | interval between runs |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

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
