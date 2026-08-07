-- Schema hardening: unique external ids, slugs, and sync timestamps on every
-- imported table so re-imports only UPDATE and stale rows can be refreshed
-- with `WHERE last_synced_at < NOW() - interval '30 days'`.

-- 1) anime: id_mal must be unique (defensive dedupe keeps the newest row),
--    plus a stable URL slug and a sync cursor.
DELETE FROM anime a USING anime b
 WHERE a.id_mal = b.id_mal AND a.id_mal IS NOT NULL AND a.id < b.id;

CREATE UNIQUE INDEX anime_id_mal_uidx ON anime (id_mal) WHERE id_mal IS NOT NULL;

ALTER TABLE anime
  ADD COLUMN slug TEXT,
  ADD COLUMN last_synced_at TIMESTAMPTZ;

-- Backfill slugs for existing rows; the importer replaces the 'anime-N'
-- fallback with a title-based slug on the next sync.
UPDATE anime SET slug = 'anime-' || id_mal WHERE slug IS NULL AND id_mal IS NOT NULL;

CREATE UNIQUE INDEX anime_slug_uidx ON anime (slug) WHERE slug IS NOT NULL;

-- 2) metadata tables: updated_at + sync cursor (mal_id uniques already exist).
ALTER TABLE genres
  ADD COLUMN updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_synced_at TIMESTAMPTZ;

ALTER TABLE studios
  ADD COLUMN updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_synced_at TIMESTAMPTZ;

ALTER TABLE producers
  ADD COLUMN updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_synced_at TIMESTAMPTZ;

ALTER TABLE licensors
  ADD COLUMN updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_synced_at TIMESTAMPTZ;

ALTER TABLE themes
  ADD COLUMN updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_synced_at TIMESTAMPTZ;

ALTER TABLE demographics
  ADD COLUMN updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_synced_at TIMESTAMPTZ;

-- 3) entity tables that already track updated_at gain the sync cursor.
ALTER TABLE characters ADD COLUMN last_synced_at TIMESTAMPTZ;
ALTER TABLE staff      ADD COLUMN last_synced_at TIMESTAMPTZ;
ALTER TABLE episodes   ADD COLUMN last_synced_at TIMESTAMPTZ;

-- 4) per-anime derived content tables: created/updated bookkeeping so the
--    API can report when each group was last written.
ALTER TABLE anime_staff          ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE anime_relations      ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE anime_recommendations ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE anime_pictures       ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE anime_videos         ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
