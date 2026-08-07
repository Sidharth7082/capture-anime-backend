# CaptureOrDie — Anime Streaming Platform (Backend)

Production backend for an anime streaming site: a **REST API** (Express +
PostgreSQL) that serves the frontend, and a **catalog pipeline** (Node/TS
importer) that fills the database from upstream anime databases.

```text
Jikan (MyAnimeList) ──►  Catalog Pipeline (importer/)  ──►  PostgreSQL
                              │                                   │
                              ▼                                   ▼
                         Typesense (search index)         Express API (src/)  ──►  React frontend
```

The frontend lives in a separate repo ([capture-anime](https://github.com/Sidharth7082/capture-anime))
and calls this API. The pipeline is built like a small production data
platform: reusable stages, resume support, idempotent re-runs, and
observability — not a one-off script.

---

## Repository layout

```
capture-anime-backend/
├── src/                        # Express REST API (the frontend's backend)
│   ├── app.js                  # app factory: middleware, routes, error handling
│   ├── server.js               # entrypoint (binds PORT)
│   ├── modules/                # one folder per domain
│   │   ├── anime/              # GET /api/anime, /api/anime/:id, search, genres, studios, episodes
│   │   ├── auth/               # register / login / refresh / logout (JWT)
│   │   ├── user/               # profile, favorites, history, continue-watching
│   │   ├── mal/                # MyAnimeList OAuth + list sync
│   │   └── watch/              # stream URLs + prefetch (self-hosted streaming)
│   ├── lib/                    # errors, jwt, password, pagination, cache, crypto, logger
│   ├── services/anivexa.js     # streaming provider client (episode stream resolution)
│   ├── openapi.yaml            # Swagger spec for all 30 endpoints
│   └── cli.js / db.js          # legacy CLI + pg pool
├── importer/                   # catalog pipeline (TypeScript, independent of the API)
│   └── src/
│       ├── index.ts            # daemon: env validation, scheduler, health endpoint
│       ├── run-import.ts       # CLI: one-shot anime import / enrichment
│       ├── verify-catalog.ts   # catalog health checks (npm run catalog:verify)
│       ├── jikan.ts            # Jikan v4 client (timeout, retries, 429-aware)
│       ├── anilist.ts          # AniList GraphQL client (throttle, Retry-After, token)
│       ├── database.ts         # pg pool wrapper (query, transaction, ping)
│       ├── typesense.ts        # search index client + per-page sink
│       ├── metrics.ts          # current/last run counters for /health
│       ├── health.ts           # GET /health (last import, job status, next run)
│       └── pipeline/           # the reusable data pipeline (see below)
├── db/
│   ├── migrate.js              # SQL migration runner (up/down/status/create)
│   └── migrations/             # 0001..0011 — see "Database" below
├── scripts/                    # ops helpers (verify-setup, report-counts, secrets, e2e)
├── test/                       # backend test suite (node:test + supertest)
└── docker-compose.yml          # optional: postgres + importer
```

## The catalog pipeline (`importer/`)

Every data source plugs into the **same pipeline** — a new source only
supplies a `Fetcher` + a `Normalizer`:

```text
Fetcher ──► Normalizer ──► Validator ──► UpsertService ──► PostgreSQL
    │          (pure)         (zod)          │
    │                                        ▼
    └── Runner (pages · resume · cancel) ── JobStore (import_jobs)
                                            │
                                            ▼
                                      Typesense sink (per page)
```

| Stage | What it imports | How |
|---|---|---|
| **1. Anime** | the catalogue (`anime` table) | paginated `GET /v4/anime?page=N`, upsert by `mal_id` |
| **2. Metadata** | genres, studios, producers, licensors, themes, demographics | embedded in list items — same transaction as the anime row |
| **3. Search** | Typesense index | flip `TYPESENSE_ENABLED=true`; per-page upsert of search docs |
| **4. Enrichment** | characters, voice actors, staff, relations, recommendations, pictures, videos | per-anime detail endpoints (`GET /v4/anime/{id}/…`), own resume point |
| **5. AniList (canonical)** | the authoritative anime row (banner, cover color, trailer, mean score, next airing, synopsis) | GraphQL `Page.media`; matches by `anilist_id` then `id_mal` — Jikan rows updated in place, never duplicated; incremental via `UPDATED_AT_DESC` + previous run cursor |

Guarantees that make re-runs safe:

- **Idempotent** — upserts by external id (`mal_id`); enrichment is
  replace-per-anime, so the DB mirrors Jikan exactly.
- **Resumable** — progress is written to `import_jobs` after every page; a
  crash on page 1,247 resumes at 1,248 (`--reset` to start over).
- **Failure isolation** — a bad row or a failed endpoint is counted, never a
  crash; a partially-failed anime still enriches what succeeded.
- **Stale-only refresh** — every imported row carries `last_synced_at`;
  `ENRICH_STALE_DAYS=30` re-fetches only stale rows.
- **Observable** — JSON logs (`LOG_FORMAT=json`), metrics, and a health
  endpoint: `GET :9090/health` (uptime, current/last import, next run, jobs).

### Pipeline files

```
importer/src/pipeline/
├── types.ts               # Fetcher / Normalizer / Validator / UpsertPort / Sink / JobStore contracts
├── fetchers.ts            # JikanAnimeFetcher (list) + JikanEnrichFetcher (detail)
├── normalizers.ts         # Jikan → platform rows (pure, unit-tested)
├── validator.ts           # zod schemas enforcing the table contract
├── upsert-service.ts      # anime + metadata upsert (slug, sync cursor, one transaction)
├── enrich-upsert-service.ts # characters/staff/VAs/relations/… (replace-per-anime)
├── job-store.ts           # import_jobs persistence (+ no-op for dry-run)
├── runner.ts              # generic pipeline: pagination, resume, counters, cancel
└── *.test.ts              # unit tests with in-memory fakes
```

### CLI

```bash
cd importer
npm run import:anime                        # full catalogue (resumes)
npm run import:anime -- --limit 200         # test run
npm run import:anime -- --dry-run           # fetch + normalize, NO writes
npm run import:enrich -- --limit 10         # characters/staff/relations/… (Stage 4)
npm run dev                                 # daemon: scheduler + health endpoint
```

---

## The REST API (`src/`)

Express + PostgreSQL + JWT auth. All routes are documented in
`src/openapi.yaml` (Swagger, 30 endpoints). Main groups:

| Group | Endpoints |
|---|---|
| Anime | `/api/anime`, `/api/anime/:id`, `/trending`, `/popular`, `/recent`, `/search?q=`, `/genre/:id`, `/studio/:id` |
| Episodes | `/api/episodes/:animeId` |
| Watch | `/api/watch/:animeId/*` (stream URLs, prefetch) |
| Auth | `/api/auth/register|login|refresh|logout` |
| User | `/api/user/profile`, `/favorites`, `/history`, `/continue-watching` |
| MAL | `/api/mal/connect|callback|me|disconnect|sync|list|progress` |

### Module pattern

Every module is a vertical slice: `routes → schemas (zod) → controller →
service → repository`. `createApp({ …services })` wires them together with
dependency injection, so tests swap real services for fakes.

---

## Database (`db/migrations/`)

PostgreSQL ≥ 13, managed by a small SQL migration runner
(`npm run migrate`). Each migration has `.up.sql` + `.down.sql`.

| Migration | Purpose |
|---|---|
| `0001` | core schema: users, anime, genres, studios, characters, staff, episodes, watchlists, favorites, ratings, comments, enums |
| `0002`–`0003` | performance + search indexes (trigram / full-text) |
| `0004` | refresh tokens, continue-watching |
| `0005`–`0006` | MAL sync tables + PKCE pending state |
| `0007` | `anime.anilist_id` nullable (Jikan rows have none) + `id_mal` index |
| `0008` | `import_jobs` (pipeline resume) |
| `0009` | metadata tables: producers, licensors, themes, demographics + `mal_id` on genres/studios |
| `0010` | enrichment content: anime_staff, anime_relations, anime_recommendations, anime_pictures, anime_videos + `mal_id` on characters/staff |
| `0011` | schema hardening: unique `id_mal`/`slug`, `last_synced_at` on every imported table |
| `0012` | `anime.enrich_synced_at` — enrichment-only cursor for stale refresh |
| `0013` | `anime.next_airing_at` — AniList-only field |

**Canonical record** — one row per anime, enriched from multiple providers
over time (Jikan today; AniList/TMDB planned as *enrichers* that only
`UPDATE` existing rows, never insert duplicates). External IDs are unique
(`anilist_id`, `id_mal`, `slug`), and each row tracks when it was last
synced so refreshes can be incremental.

---

## Running it

### Requirements

- Node.js ≥ 20, PostgreSQL ≥ 13

### 1. Database + migrations

```bash
cp .env.example .env          # DATABASE_URL, JWT secrets, etc.
npm install
npm run migrate               # applies all 0011 migrations
```

### 2. API

```bash
npm run dev                   # API on PORT (default 3000)
```

### 3. Importer

```bash
cd importer
cp .env.example .env          # JIKAN_API_URL, DATABASE_URL, …
npm install
npm run import:anime -- --limit 200     # test
npm run import:anime                    # full catalogue
npm run import:enrich -- --limit 10     # enrich a few
npm run import:enrich                   # full enrichment
```

### 4. Health & observability (daemon)

```bash
cd importer && npm run dev    # scheduler + GET /health on :9090
curl http://localhost:9090/health
```

### Docker

`docker-compose.yml` provides postgres + the importer. The API runs from
`npm start` (or the included `Dockerfile`).

---

## Testing

| Suite | Where | Command |
|---|---|---|
| Backend (unit + route tests, supertest + fakes) | `test/` | `npm test` (144 tests) |
| **DB-backed repository + integrity tests** (real schema on PGlite: migrations, unique/FK/cascade, transactions, advisory locks, auth/user/mal/anime repositories) | `test/unit/db/` | part of `npm test` |
| Importer (normalizer/validator/runner/upsert with in-memory fakes) | `importer/src/**/*.test.ts` | `cd importer && npm test` (67 tests) |
| Ops smoke checks | `scripts/` | `npm run db:verify`, `npm run verify-setup` |
| HTTP-layer throughput bench | `scripts/bench/http.mjs` | `npm run bench` |

## Feature roadmap (current focus)

The catalog pipeline is stable and frozen except for bug fixes. Next:

1. AniList enrichment (UPDATE-only: `anilist_id`, banner, trailer, mean score)
2. TMDB enrichment (movies, posters, backdrops, cast)
3. Platform features on top: profiles, watch parties, comments, notifications,
   recommendations, admin dashboard, analytics
