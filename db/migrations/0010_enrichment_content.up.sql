-- Stage 4 enrichment: characters/staff get MAL ids (link AniList-imported
-- rows), and the content relationships imported from Jikan detail endpoints
-- get their own tables. Voice actors reuse the existing staff +
-- character_staff model (dub language lives on the join).

-- characters / staff: add the MAL id as a stable natural key.
ALTER TABLE characters ADD COLUMN mal_id BIGINT;
CREATE UNIQUE INDEX characters_mal_id_uidx ON characters (mal_id) WHERE mal_id IS NOT NULL;

ALTER TABLE staff ADD COLUMN mal_id BIGINT;
CREATE UNIQUE INDEX staff_mal_id_uidx ON staff (mal_id) WHERE mal_id IS NOT NULL;

-- Staff positions per anime (staff rows also serve as voice actors via
-- character_staff; positions belong to the anime relationship).
CREATE TABLE anime_staff (
  anime_id  BIGINT NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  staff_id  BIGINT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  positions TEXT[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (anime_id, staff_id)
);

-- Relations to other works (anime or manga); related_anime_id is resolved
-- when the target exists in the local catalog, else NULL.
CREATE TABLE anime_relations (
  anime_id          BIGINT NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  related_anime_id  BIGINT REFERENCES anime(id) ON DELETE CASCADE,
  mal_id            BIGINT NOT NULL,
  media_type        TEXT NOT NULL,            -- 'anime' | 'manga' | ...
  name              TEXT NOT NULL,
  relation          TEXT NOT NULL,            -- 'Sequel' | 'Prequel' | ...
  sort_order        SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (anime_id, mal_id, media_type)
);

-- MAL "users also liked" recommendations.
CREATE TABLE anime_recommendations (
  anime_id              BIGINT NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  recommended_anime_id  BIGINT REFERENCES anime(id) ON DELETE CASCADE,
  mal_id                BIGINT NOT NULL,
  title                 TEXT NOT NULL,
  votes                 INT NOT NULL DEFAULT 0 CHECK (votes >= 0),
  sort_order            SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (anime_id, mal_id)
);

-- Screenshots / gallery from the pictures endpoint (per-anime ordered list).
CREATE TABLE anime_pictures (
  anime_id        BIGINT NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  image_url       TEXT NOT NULL,
  large_image_url TEXT,
  webp_url        TEXT,
  sort_order      SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (anime_id, sort_order)
);

-- Promo trailers and per-episode video links from the videos endpoint.
CREATE TABLE anime_videos (
  anime_id         BIGINT NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('promo', 'episode')),
  youtube_id       TEXT,
  title            TEXT NOT NULL,
  url              TEXT,
  embed_url        TEXT,
  thumbnail_large  TEXT,
  episode_number   INT CHECK (episode_number IS NULL OR episode_number > 0),
  sort_order       SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (anime_id, sort_order)
);

-- Cover-gallery queries join on this index.
CREATE INDEX anime_relations_related_anime_id_idx ON anime_relations (related_anime_id);
CREATE INDEX anime_recommendations_recommended_anime_id_idx ON anime_recommendations (recommended_anime_id);
