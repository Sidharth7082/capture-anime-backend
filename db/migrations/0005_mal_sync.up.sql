-- MyAnimeList synchronization: OAuth account + synced anime list entries.
-- Tokens are stored ENCRYPTED (AES-256-GCM) — see src/lib/crypto.js — and
-- never leave the server.

CREATE TABLE mal_accounts (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mal_id            BIGINT NOT NULL,                 -- MAL user id
  mal_username      TEXT NOT NULL,
  access_token_enc  TEXT NOT NULL,                   -- AES-256-GCM ciphertext
  refresh_token_enc TEXT,                            -- AES-256-GCM ciphertext
  token_expires_at  TIMESTAMPTZ NOT NULL,
  scopes            TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (user, MAL anime). `anime_id` links to the local catalog when
-- the MAL id matches anime.id_mal (AniList import already stores it).
CREATE TABLE mal_anime_entries (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mal_anime_id    BIGINT NOT NULL,
  anime_id        BIGINT REFERENCES anime(id) ON DELETE SET NULL,
  status          TEXT NOT NULL CHECK (status IN ('watching','completed','on_hold','dropped','plan_to_watch')),
  score           INT  NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 10),
  episodes_watched INT NOT NULL DEFAULT 0 CHECK (episodes_watched >= 0),
  rewatch_count   INT  NOT NULL DEFAULT 0 CHECK (rewatch_count >= 0),
  is_rewatching   BOOLEAN NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mal_anime_entries_user_anime_uidx UNIQUE (user_id, mal_anime_id)
);

CREATE INDEX mal_anime_entries_user_status_idx ON mal_anime_entries (user_id, status);
CREATE INDEX mal_anime_entries_anime_idx ON mal_anime_entries (anime_id);
