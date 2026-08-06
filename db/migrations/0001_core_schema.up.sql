-- ============================================================================
-- 0001: Core schema — extensions, enums, tables, constraints, triggers
--
-- Tables (in dependency order):
--   users, anime, genres, anime_genres, studios, anime_studios,
--   characters, anime_characters, staff, character_staff, episodes,
--   favorites, watchlists, watch_history, ratings, comments
--
-- Conventions:
--   * Every row has created_at / updated_at; updated_at is maintained by the
--     set_updated_at() trigger.
--   * Foreign keys use ON DELETE CASCADE: user content dies with its owner,
--     relation rows die with either side. Anime/catalog rows are never
--     physically deleted in practice (soft-delete via status where needed).
--   * AniList's numeric ids are stored alongside our own identity columns so
--     the import stays idempotent (anilist_id is UNIQUE) and our ids stay
--     stable even if upstream renumbers.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Extensions
-- ----------------------------------------------------------------------------
-- pgcrypto is only needed on PostgreSQL < 13 (gen_random_uuid() is core since
-- 13, which is the minimum supported version). pg_trgm powers fuzzy title and
-- name search (see 0003).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ----------------------------------------------------------------------------
-- Enumerated types
-- ----------------------------------------------------------------------------
-- Values mirror the AniList GraphQL enums so the importer can map 1:1.

CREATE TYPE media_type    AS ENUM ('ANIME', 'MANGA');
CREATE TYPE media_format  AS ENUM ('TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC');
CREATE TYPE media_status  AS ENUM ('FINISHED', 'RELEASING', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS');
CREATE TYPE media_season  AS ENUM ('WINTER', 'SPRING', 'SUMMER', 'FALL');
CREATE TYPE media_source  AS ENUM (
  'ORIGINAL', 'MANGA', 'LIGHT_NOVEL', 'VISUAL_NOVEL', 'VIDEO_GAME', 'OTHER',
  'NOVEL', 'DOUJINSHI', 'ANIME', 'WEB_NOVEL', 'LIVE_ACTION', 'GAME', 'COMIC',
  'MULTIMEDIA_PROJECT', 'PICTURE_BOOK'
);
CREATE TYPE character_role AS ENUM ('MAIN', 'SUPPORTING', 'BACKGROUND');
CREATE TYPE user_role     AS ENUM ('viewer', 'moderator', 'admin');
CREATE TYPE user_status   AS ENUM ('active', 'suspended', 'deleted');
CREATE TYPE watchlist_status AS ENUM ('PLANNING', 'WATCHING', 'COMPLETED', 'ON_HOLD', 'DROPPED', 'REWATCHING');

-- ----------------------------------------------------------------------------
-- Helper functions
-- ----------------------------------------------------------------------------

-- Keeps updated_at fresh on every UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- A reply must target the same anime/episode as its parent, otherwise comment
-- trees can silently cross between unrelated discussions.
CREATE OR REPLACE FUNCTION comments_check_parent_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_anime_id  BIGINT;
  parent_episode_id BIGINT;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT anime_id, episode_id INTO parent_anime_id, parent_episode_id
      FROM comments
     WHERE id = NEW.parent_id;
    IF parent_anime_id   IS DISTINCT FROM NEW.anime_id
       OR parent_episode_id IS DISTINCT FROM NEW.episode_id THEN
      RAISE EXCEPTION 'comment parent must target the same anime or episode';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- users
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL CHECK (char_length(username) BETWEEN 3 AND 32),
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  avatar_url    TEXT,
  role          user_role   NOT NULL DEFAULT 'viewer',
  status        user_status NOT NULL DEFAULT 'active',
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_username_chars_check CHECK (username ~ '^[A-Za-z0-9_]+$')
);

-- Case-insensitive uniqueness without the citext extension.
CREATE UNIQUE INDEX users_username_lower_uidx ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower_uidx   ON users (lower(email));

-- ----------------------------------------------------------------------------
-- anime — the catalog root. One row per series/movie/OVA imported from AniList.
-- ----------------------------------------------------------------------------
CREATE TABLE anime (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anilist_id         BIGINT NOT NULL,              -- upstream natural key
  id_mal             BIGINT,                       -- MyAnimeList id for cross-refs
  title_romaji       TEXT,
  title_english      TEXT,
  title_native       TEXT,
  synonyms           TEXT[] NOT NULL DEFAULT '{}',
  description        TEXT,                         -- HTML, as served by AniList
  media_type         media_type    NOT NULL DEFAULT 'ANIME',
  format             media_format,
  status             media_status,
  episodes           INT,                          -- declared episode count
  duration_minutes   INT,
  start_date         DATE,
  end_date           DATE,
  season             media_season,
  season_year        INT,
  average_score      SMALLINT,                     -- 0..100
  mean_score         SMALLINT,                     -- 0..100
  popularity         INT,
  favourites         INT,
  source             media_source,
  is_adult           BOOLEAN NOT NULL DEFAULT FALSE,
  cover_image_large  TEXT,
  cover_image_medium TEXT,
  cover_image_color  TEXT,
  banner_image       TEXT,
  trailer_id         TEXT,
  trailer_site       TEXT,
  trailer_thumbnail  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT anime_anilist_id_uidx UNIQUE (anilist_id),
  CONSTRAINT anime_episodes_check       CHECK (episodes IS NULL OR episodes >= 0),
  CONSTRAINT anime_duration_check       CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
  CONSTRAINT anime_average_score_check  CHECK (average_score IS NULL OR average_score BETWEEN 0 AND 100),
  CONSTRAINT anime_mean_score_check     CHECK (mean_score IS NULL OR mean_score BETWEEN 0 AND 100),
  CONSTRAINT anime_popularity_check     CHECK (popularity IS NULL OR popularity >= 0),
  CONSTRAINT anime_favourites_check     CHECK (favourites IS NULL OR favourites >= 0),
  CONSTRAINT anime_season_year_check    CHECK (season_year IS NULL OR season_year BETWEEN 1917 AND 2100),
  CONSTRAINT anime_dates_check          CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);

-- ----------------------------------------------------------------------------
-- genres (many-to-many with anime)
-- ----------------------------------------------------------------------------
CREATE TABLE genres (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE anime_genres (
  anime_id BIGINT NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  genre_id BIGINT NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (anime_id, genre_id)
);

-- ----------------------------------------------------------------------------
-- studios (many-to-many with anime; is_main marks the primary studio)
-- ----------------------------------------------------------------------------
CREATE TABLE studios (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anilist_id          BIGINT,
  name                TEXT NOT NULL,
  is_animation_studio BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT studios_anilist_id_uidx UNIQUE (anilist_id)
);

CREATE TABLE anime_studios (
  anime_id  BIGINT NOT NULL REFERENCES anime(id)    ON DELETE CASCADE,
  studio_id BIGINT NOT NULL REFERENCES studios(id)  ON DELETE CASCADE,
  is_main   BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (anime_id, studio_id)
);

-- ----------------------------------------------------------------------------
-- characters
-- ----------------------------------------------------------------------------
CREATE TABLE characters (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anilist_id   BIGINT,
  name_first   TEXT NOT NULL,
  name_last    TEXT,
  name_native  TEXT,
  description  TEXT,
  image_large  TEXT,
  image_medium TEXT,
  favourites   INT NOT NULL DEFAULT 0 CHECK (favourites >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT characters_anilist_id_uidx UNIQUE (anilist_id),
  CONSTRAINT characters_name_check CHECK (name_first IS NOT NULL OR name_last IS NOT NULL OR name_native IS NOT NULL)
);

-- Which characters appear in which anime, and how prominent they are.
CREATE TABLE anime_characters (
  anime_id     BIGINT NOT NULL REFERENCES anime(id)      ON DELETE CASCADE,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  role         character_role NOT NULL DEFAULT 'SUPPORTING',
  sort_order   SMALLINT NOT NULL DEFAULT 0,
  favourites   INT NOT NULL DEFAULT 0 CHECK (favourites >= 0),
  PRIMARY KEY (anime_id, character_id)
);

-- ----------------------------------------------------------------------------
-- staff — holds voice actors (the columns cover the AniList Staff shape).
-- ----------------------------------------------------------------------------
CREATE TABLE staff (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anilist_id  BIGINT,
  name_first  TEXT NOT NULL,
  name_last   TEXT,
  name_native TEXT,
  language    TEXT NOT NULL DEFAULT 'Japanese',
  image_large TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staff_anilist_id_uidx UNIQUE (anilist_id),
  CONSTRAINT staff_name_check CHECK (name_first IS NOT NULL OR name_last IS NOT NULL OR name_native IS NOT NULL)
);

-- A voice actor voicing a character, in a given dub language.
CREATE TABLE character_staff (
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  staff_id     BIGINT NOT NULL REFERENCES staff(id)      ON DELETE CASCADE,
  language     TEXT NOT NULL DEFAULT 'Japanese',
  PRIMARY KEY (character_id, staff_id, language)
);

-- ----------------------------------------------------------------------------
-- episodes
-- ----------------------------------------------------------------------------
CREATE TABLE episodes (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anilist_id       BIGINT,               -- reserved; AniList has no episode API
  anime_id         BIGINT NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  number           INT NOT NULL CHECK (number > 0 AND number <= 10000),
  title            TEXT,
  title_japanese   TEXT,
  synopsis         TEXT,
  thumbnail_url    TEXT,
  duration_seconds INT CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  air_date         DATE,
  is_filler        BOOLEAN NOT NULL DEFAULT FALSE,
  is_recap         BOOLEAN NOT NULL DEFAULT FALSE,
  video_url        TEXT,                 -- streaming asset, populated by the platform
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT episodes_anime_number_uidx UNIQUE (anime_id, number),
  CONSTRAINT episodes_anilist_id_uidx UNIQUE (anilist_id)
);

-- ----------------------------------------------------------------------------
-- favorites — one row per (user, target); exactly one target column set.
-- ----------------------------------------------------------------------------
CREATE TABLE favorites (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  anime_id     BIGINT REFERENCES anime(id)            ON DELETE CASCADE,
  character_id BIGINT REFERENCES characters(id)       ON DELETE CASCADE,
  staff_id     BIGINT REFERENCES staff(id)            ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT favorites_single_target_check CHECK (num_nonnulls(anime_id, character_id, staff_id) = 1)
);

-- Partial unique indexes emulate "UNIQUE (user_id, <target>)" while allowing
-- NULLs in the two unused target columns.
CREATE UNIQUE INDEX favorites_anime_user_uidx     ON favorites (user_id, anime_id)     WHERE anime_id IS NOT NULL;
CREATE UNIQUE INDEX favorites_character_user_uidx ON favorites (user_id, character_id) WHERE character_id IS NOT NULL;
CREATE UNIQUE INDEX favorites_staff_user_uidx     ON favorites (user_id, staff_id)     WHERE staff_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- watchlists — the user's anime list with progress and a personal score.
-- ----------------------------------------------------------------------------
CREATE TABLE watchlists (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  anime_id           BIGINT NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  status             watchlist_status NOT NULL DEFAULT 'PLANNING',
  progress_episodes  INT NOT NULL DEFAULT 0 CHECK (progress_episodes >= 0),
  score              SMALLINT CHECK (score IS NULL OR score BETWEEN 0 AND 10),
  notes              TEXT,
  started_at         DATE,
  completed_at       DATE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT watchlists_user_anime_uidx UNIQUE (user_id, anime_id),
  CONSTRAINT watchlists_progress_check CHECK (progress_episodes = 0 OR started_at IS NOT NULL)
);

-- ----------------------------------------------------------------------------
-- watch_history — an append-only log of episode views (the "continue watching"
-- feed is derived from this).
-- ----------------------------------------------------------------------------
CREATE TABLE watch_history (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  episode_id       BIGINT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  watched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  progress_seconds INT CHECK (progress_seconds IS NULL OR progress_seconds >= 0),
  duration_seconds INT CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  completed        BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT watch_history_user_episode_time_uidx UNIQUE (user_id, episode_id, watched_at)
);

-- ----------------------------------------------------------------------------
-- ratings — one score per (user, anime); the aggregate used for the platform's
-- own average (distinct from AniList's average_score).
-- ----------------------------------------------------------------------------
CREATE TABLE ratings (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  anime_id   BIGINT NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  score      SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 10),
  review     TEXT CHECK (review IS NULL OR char_length(review) <= 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ratings_user_anime_uidx UNIQUE (user_id, anime_id)
);

-- ----------------------------------------------------------------------------
-- comments — threaded discussion on either an anime or an episode.
-- ----------------------------------------------------------------------------
CREATE TABLE comments (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  anime_id   BIGINT REFERENCES anime(id)         ON DELETE CASCADE,
  episode_id BIGINT REFERENCES episodes(id)      ON DELETE CASCADE,
  parent_id  BIGINT REFERENCES comments(id)      ON DELETE CASCADE,
  content    TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  is_edited  BOOLEAN NOT NULL DEFAULT FALSE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,      -- soft delete keeps the tree intact
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT comments_single_target_check   CHECK (num_nonnulls(anime_id, episode_id) = 1),
  CONSTRAINT comments_parent_not_self_check CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TRIGGER comments_check_parent_target_trg
  BEFORE INSERT OR UPDATE ON comments
  FOR EACH ROW EXECUTE FUNCTION comments_check_parent_target();

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------
CREATE TRIGGER users_set_updated_at        BEFORE UPDATE ON users        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER anime_set_updated_at        BEFORE UPDATE ON anime        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER characters_set_updated_at   BEFORE UPDATE ON characters   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER staff_set_updated_at        BEFORE UPDATE ON staff        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER episodes_set_updated_at     BEFORE UPDATE ON episodes     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER watchlists_set_updated_at   BEFORE UPDATE ON watchlists   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ratings_set_updated_at      BEFORE UPDATE ON ratings      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER comments_set_updated_at     BEFORE UPDATE ON comments     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
