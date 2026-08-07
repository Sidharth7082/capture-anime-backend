# Anime Streaming Platform — PostgreSQL schema + AniList importer

A production-oriented PostgreSQL database for an anime streaming platform, plus
a Node.js importer that fills it from the [AniList GraphQL API](https://anilist.gitbook.io/anilist-apiv2-docs/).

```
anime-platform/
├── db/
│   ├── migrate.js               # SQL migration runner (up/down/status/create)
│   └── migrations/
│       ├── 0001_core_schema.{up,down}.sql        # extensions, enums, 16 tables
│       ├── 0002_performance_indexes.{up,down}.sql
│       └── 0003_search_indexes.{up,down}.sql     # trigram + full-text search
├── src/
│   ├── cli.js                   # importer CLI entry point
│   ├── db.js                    # pg connection pool
│   └── anilist/
│       ├── client.js            # rate-limit-aware GraphQL client
│       ├── queries.js           # GraphQL queries (page + by-id)
│       └── importer.js          # upsert logic (transactional, idempotent)
└── test/
    ├── migrations.smoke.test.mjs  # runs migrations on an in-memory Postgres
    └── e2e.import.test.mjs        # live AniList data through the real importer
```

Requirements: Node ≥ 20, PostgreSQL ≥ 13 (13+ gives `gen_random_uuid()` in core;
16+ recommended).

---

## 1. Schema design

### Entity-relationship overview

```
                  ┌──────────┐   m:n   ┌──────────┐
        ┌────────▶│  genres  │◀────────│          │
        │         └──────────┘         │          │   m:n   ┌─────────┐
        │                              │  anime   │────────▶│ studios │
        │   ┌────────────────────┐     │          │         └─────────┘
        │   │     characters     │◀────│          │
        │   │  (anime_characters)│     └────┬─────┘
        │   └─────────┬──────────┘          │
        │             │ n:m                 │ 1:n
        │   ┌─────────▼──────────┐    ┌─────▼──────┐
        │   │       staff        │    │  episodes  │
        │   │  (character_staff) │    └─────┬──────┘
        │   └────────────────────┘          │
        │                                   │
  ┌─────▼──────┐   ┌────────────┐   ┌──────▼────────┐
  │  favorites │   │ watchlists │   │ watch_history │      ┌──────────┐
  └────────────┘   └────────────┘   └───────────────┘      │ comments │
        ▲              ▲                    ▲               └────┬─────┘
        └──────────────┴────────────────────┴───────────────────┤
                                                        ┌───────▼───────┐
                                                        │     users     │
                                                        └───────────────┘
```

### Tables and their roles

| Table | Purpose | Key design decisions |
|---|---|---|
| `users` | Accounts | UUID PK (`gen_random_uuid()`), case-insensitive unique `email`/`username` via expression indexes, role (`viewer`/`moderator`/`admin`) and status (`active`/`suspended`/`deleted`) enums for soft delete |
| `anime` | Catalog root | Own `BIGINT IDENTITY` PK **plus** `anilist_id UNIQUE` so the import is idempotent and upstream renumbers never break our FKs. Enum columns (`media_type`, `format`, `status`, `season`, `source`) mirror AniList values 1:1. CHECKs keep scores in 0–100, dates sane, counts non-negative |
| `genres` / `anime_genres` | m:n genres | `genres.name UNIQUE`; junction PK `(anime_id, genre_id)` |
| `studios` / `anime_studios` | m:n studios | `is_animation_studio` on the studio; `is_main` on the link (primary studio) |
| `characters` / `anime_characters` | m:n characters per show | `anime_characters.role` is `MAIN`/`SUPPORTING`/`BACKGROUND`; `sort_order` from AniList's `favouriteOrder`; `favourites` denormalized for sorting |
| `staff` / `character_staff` | Voice actors | `staff` is the AniList Staff shape; `character_staff` links a VA to a character **per dub language** (`Japanese`, `English`, …) |
| `episodes` | Per-episode rows | `UNIQUE (anime_id, number)`, `is_filler`/`is_recap` flags, `video_url` reserved for streaming assets |
| `favorites` | User favorites | Polymorphic: exactly one of `anime_id`/`character_id`/`staff_id` per row (CHECK `num_nonnulls(...) = 1`); partial unique indexes give "one favorite per user per target" |
| `watchlists` | The user's anime list | `UNIQUE (user_id, anime_id)`; status enum (watching/completed/planning/…), episode progress, personal score 0–10, `started_at` required once progress > 0 |
| `watch_history` | Episode view log | Append-only; drives "continue watching". Unique on `(user_id, episode_id, watched_at)`; app upserts to avoid duplicates |
| `ratings` | Platform scores | `UNIQUE (user_id, anime_id)`, score 1–10, optional review text; platform average is computed from here (independent of AniList scores) |
| `comments` | Threaded discussion | Attached to exactly one of `anime_id`/`episode_id`; `parent_id` self-FK for replies with **trigger-enforced rule** that a reply targets the same object as its parent; soft delete (`is_deleted`) preserves trees |

### Cross-cutting rules

* **Foreign keys** — every relation uses `ON DELETE CASCADE`: user content
  dies with its owner; junction rows die with either side. Catalog rows are
  never physically deleted in operation (soft-delete via status).
* **Timestamps** — every mutable table has `created_at`/`updated_at`; a
  `set_updated_at()` trigger keeps `updated_at` fresh on UPDATE.
* **Search** (0003) — two strategies:
  * `pg_trgm` GIN indexes for fuzzy/partial title & name matching
    (`ILIKE '%term%'` and similarity operators).
  * Generated `tsvector` columns (`search_vector`, `GENERATED ALWAYS … STORED`)
    + GIN indexes for ranked full-text search — the database maintains them,
    application code never writes them.
* **Indexes** (0002) — every non-covered FK column is indexed, plus the hot
  query patterns: browse filters (`status, format, is_adult`), seasonal lists
  (`season_year, season`), top-rated/trending (`average_score`/`popularity
  DESC` partial indexes), continue-watching (`watch_history(user_id,
  watched_at DESC)`), comment feeds (partial, `WHERE is_deleted = FALSE`).

---

## 2. Migrations

Plain SQL files, one transaction per migration, tracked in `schema_migrations`:

```bash
cp .env.example .env          # set DATABASE_URL
npm run migrate               # apply all pending migrations
npm run migrate:status        # show applied/pending
npm run migrate:down          # roll back the most recent migration
npm run migrate:create <name> # scaffold new 000N_<name>.up/.down.sql
```

A session-level advisory lock prevents concurrent runners; `down` refuses to
run when no `.down.sql` exists rather than guessing.

---

## 3. AniList importer

```bash
npm run import                              # full anime catalog (popularity order)
npm run import -- --season WINTER --year 2024 --format TV
npm run import -- --ids 21,16498            # specific titles
npm run import -- --sort TRENDING_DESC --max-pages 5
npm run import -- --dry-run --max-pages 1   # validate without writing
```

### Flags

| Flag | Default | Description |
|---|---|---|
| `--type` | `ANIME` | `ANIME` or `MANGA` |
| `--sort` | `POPULARITY_DESC` | Any AniList `MediaSort` |
| `--season`, `--year` | – | Seasonal filter (`--year` requires `--season`) |
| `--format` | – | `TV`, `TV_SHORT`, `MOVIE`, `SPECIAL`, `OVA`, `ONA`, `MUSIC` |
| `--status` | – | `FINISHED`, `RELEASING`, `NOT_YET_RELEASED`, `CANCELLED`, `HIATUS` |
| `--ids` | – | Import specific AniList ids instead of a page walk |
| `--page`, `--max-pages`, `--per-page` | 1 / ∞ / 50 | Pagination |
| `--characters` | 25 | Max characters imported per title (AniList caps at 25) |
| `--va-language` | `JAPANESE` | Which dub's voice actors to import |
| `--include-adult` | off | Also import adult titles |
| `--skip-episodes` | off | Don't seed episode placeholders |
| `--delay-ms` | 400 | Min ms between API requests (AniList ≈ 90 req/min) |
| `--dry-run` | off | Fetch and print, write nothing |

### Behaviour

* **Idempotent** — every write is an upsert keyed on `anilist_id`; re-running
  refreshes metadata instead of duplicating rows (verified by the e2e test).
* **Transactional per title** — a title that fails midway rolls back whole.
* **Rate-limit aware** — spacing between requests, exponential backoff on
  429/5xx honoring `Retry-After`, optional `ANILIST_ACCESS_TOKEN` for a higher
  quota.
* **Relation sync** — `anime_genres` and `anime_studios` are pruned so they
  match the API exactly. `anime_characters`/`character_staff` are *not*
  pruned, because only the first N (≤ 25) characters are fetched per title —
  pruning would delete characters we never looked at.
* **Episodes** — AniList exposes only an episode *count*, so the importer
  seeds numbered placeholder rows (`ON CONFLICT DO NOTHING`) giving
  watch-history/comments concrete episodes to attach to. Real episode
  metadata (titles, thumbnails, air dates) must come from another source;
  set `--skip-episodes` if you manage episodes yourself.

### Known upstream quirks (handled)

* AniList returns **HTTP 400 with no body** for queries with *omitted* vs
  *null* enum filters handled differently — unset filters are omitted from the
  variables entirely (passing a batch of `null`s silently returns 0 media).
* `CharacterEdge` has `favouriteOrder`, not `favourites`; the favourites count
  lives on the character `node`.
* Character roles include `BACKGROUND` beyond `MAIN`/`SUPPORTING`.

---

## 4. Express REST API backend

A production-oriented Express API on top of the same database.

```
src/
├── app.js                  # createApp({services, cache}) — DI factory (testable)
├── server.js               # bootstrap + graceful shutdown + token pruner
├── config/env.js           # zod-validated env (fails fast on bad config)
├── db/pool.js              # pg pool (INT8 -> number) + withTransaction
├── lib/                    # logger (winston), jwt, password, crypto (AES-GCM), cache, pagination, errors
├── middleware/             # authenticate, validate (zod), error-handler, cache, request-logger
├── modules/
│   ├── auth/               # repository -> service -> controller -> routes
│   ├── anime/              # catalog queries (parameterized, whitelisted sorts)
│   ├── user/               # profile, favorites, watch history, continue watching
│   ├── watch/              # Anivexa stream proxy (HLS) + prefetch + cache
│   └── mal/                # MyAnimeList OAuth2 PKCE sync (encrypted tokens)
└── openapi.yaml            # complete OpenAPI 3 spec (served at /api-docs)
```

### Endpoints

| Area | Routes |
|---|---|
| Catalog | `GET /api/anime`, `/api/anime/:id`, `/api/anime/trending`, `/api/anime/popular`, `/api/anime/recent`, `/api/anime/search?q=`, `/api/anime/genre/:id`, `/api/anime/studio/:id`, `GET /api/episodes/:animeId` |
| Auth | `POST /api/auth/register`, `/login`, `/refresh`, `/logout` |
| User (JWT) | `GET /api/user/profile`, `GET|POST /api/user/favorites`, `DELETE /api/user/favorites/:id` (also matches by anime id), `GET|POST /api/user/history`, `GET|PUT|DELETE /api/user/continue-watching(/:animeId)` |
| Watch (JWT) | `GET /api/watch/:animeId/:episode`, `GET /api/watch/:animeId/prefetch` — streams via the self-hosted Anivexa API (HLS), cached 30–60 min with SWR |
| MyAnimeList (JWT) | `GET /api/mal/connect` → `{ authorizeUrl }`, `GET /api/mal/callback` (browser), `GET /api/mal/me`, `POST /api/mal/disconnect`, `POST /api/mal/sync`, `GET|POST /api/mal/list`, `PUT|DELETE /api/mal/list/:malAnimeId`, `POST /api/mal/progress` |

All list endpoints support `page`/`limit` pagination (`data` + `meta` envelope),
`sort` where relevant, and are cached (`X-Cache: HIT|MISS`). Full request/response
schemas are in the Swagger UI at **`/api-docs`** (JSON: `/api-docs.json`).

### Auth design

* **Access token** (15m, HS256, pinned algorithm) in `Authorization: Bearer`.
* **Refresh token** (30d) rotated on every use, stored **hashed (SHA-256)** in
  `refresh_tokens`, delivered as an httpOnly cookie **and** in the body (mobile
  clients); `Secure` in production (`COOKIE_SECURE` override available).
* **Replay protection**: presenting a revoked token kills the user's whole
  token family; a concurrent double-submit is detected via rotation `rowCount`.
* bcrypt (10 rounds) with an explicit 72-byte limit; login timing is constant
  via a dummy hash; register returns a generic conflict message.
* Login/register/refresh are rate-limited (default 10 per 15 min per IP).

### Run locally

```bash
cp .env.example .env
node scripts/generate-secrets.mjs   # paste JWT_ACCESS_SECRET / JWT_REFRESH_SECRET
npm run migrate                     # applies db/migrations/*
npm run dev                         # watch mode on :3000 (default)
npm test                            # 111 unit tests (node:test + supertest)
```

### Docker

```bash
cp .env.example .env && node scripts/generate-secrets.mjs
docker compose up -d --build        # Postgres 16 + API (migrations run on boot)
# API http://localhost:3000 · Swagger http://localhost:3000/api-docs
```

The compose stack refuses to start without `POSTGRES_PASSWORD`, both JWT
secrets and an explicit `CORS_ORIGIN` (no `*` in production — the app throws at
startup). The API container runs as non-root.

## 4b. MyAnimeList sync

Full OAuth 2.0 PKCE (S256) flow, with the user's MAL tokens stored
**encrypted at rest** (AES-256-GCM) — they never leave the server.

* `GET /api/mal/connect` (JWT) persists a PKCE pair server-side
  (`pending_mal_oauth`, keyed by `state`) and returns `{ authorizeUrl }` as
  JSON. The SPA fetches this with its Bearer token, then redirects the
  browser — a plain link would 401.
* `GET /api/mal/callback` consumes the pending state atomically, exchanges
  the code, fetches the MAL profile, stores the encrypted tokens and
  redirects to `${FRONTEND_URL}/profile#mal=connected|denied|expired|error`.
* Expired access tokens are refreshed automatically (lazy, on demand); a dead
  refresh token yields `401 — reconnect`.
* `POST /api/mal/sync` pulls the full list (paged, `id_mal` matching against
  the catalog, pruned only after a complete fetch). List CRUD round-trips to
  MAL v2; `POST /api/mal/progress` lets the player auto-update episodes
  watched when an episode is finished.

Required env (see `.env.example`):

| Var | Notes |
|---|---|
| `MAL_CLIENT_ID` | public MAL app client id (myanimelist.net/apiconfig) |
| `MAL_CLIENT_SECRET` | optional for PKCE, but set it |
| `MAL_TOKEN_ENCRYPTION_KEY` | 32-byte key (raw/base64/hex) for AES-GCM token encryption |
| `FRONTEND_URL` | where the callback redirects the browser after linking |

The MAL app's registered redirect URI must be a single URL:
`{BACKEND_URL}/api/mal/callback` (e.g. `http://192.168.0.193:3000/api/mal/callback`).

Live verification (no real MAL needed — runs the real flow against a local
mock of myanimelist.net):

```bash
node scripts/verify-mal-oauth.mjs
```

---

## 5. Production notes

* **Connection pooling** — `src/db.js` exports a `pg.Pool` (`PGPOOLMAX`,
  default 10); scale it with the app's concurrency.
* **Scheduling** — run the full import nightly via cron and targeted imports
  (`--ids`) whenever your content team adds titles.
* **RLS** — the schema is RLS-ready; add `ALTER TABLE … ENABLE ROW LEVEL
  SECURITY` + policies if the platform serves multi-tenant data.
* **Backups / HA** — standard: continuous WAL archiving, `pg_dump` for
  migrations, and `pg_restore --jobs` for recovery.
* **Observability** — the importer logs pages and request counts; wire it into
  your log aggregator. The `watch_history` and `ratings` tables are sized for
  partitioning if you ever exceed tens of millions of rows (partition by
  `watched_at` / `created_at`).
* **Migration safety** — `CREATE INDEX` in 0002/0003 uses default blocking
  builds; on very large catalogs use `CREATE INDEX CONCURRENTLY` (which
  cannot run inside a transaction — apply those migrations out-of-band).

---

## 6. Tests

```bash
npm run test:smoke   # apply + roll back all migrations on in-memory Postgres
npm run test:e2e     # real AniList data through the importer into in-memory Postgres
```

The test suites run the actual migration files and importer SQL against
[PGlite](https://github.com/electric-sql/pglite) (a real PostgreSQL engine
compiled to WASM). The full `db/migrate.js` runner round-trip against a real
server is best exercised on your local PostgreSQL:

```bash
createdb anime_platform && cp .env.example .env && npm run migrate && npm run import
```
