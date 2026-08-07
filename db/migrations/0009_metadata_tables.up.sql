-- Stage 2 metadata: link MAL metadata to the existing genre/studio tables
-- and add the missing producers / licensors / themes / demographics tables.

-- genres: add the MAL id as a stable natural key (AniList rows have none).
ALTER TABLE genres ADD COLUMN mal_id BIGINT;
CREATE UNIQUE INDEX genres_mal_id_uidx ON genres (mal_id) WHERE mal_id IS NOT NULL;

-- studios: same, so Jikan studios link to AniList-imported rows.
ALTER TABLE studios ADD COLUMN mal_id BIGINT;
CREATE UNIQUE INDEX studios_mal_id_uidx ON studios (mal_id) WHERE mal_id IS NOT NULL;

-- New metadata tables (MAL id is the natural key; names are not unique).
CREATE TABLE producers (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mal_id     BIGINT UNIQUE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE licensors (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mal_id     BIGINT UNIQUE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE themes (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mal_id     BIGINT UNIQUE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE demographics (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mal_id     BIGINT UNIQUE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Join tables (same shape as anime_genres / anime_studios).
CREATE TABLE anime_producers (
  anime_id    BIGINT NOT NULL REFERENCES anime(id)  ON DELETE CASCADE,
  producer_id BIGINT NOT NULL REFERENCES producers(id) ON DELETE CASCADE,
  PRIMARY KEY (anime_id, producer_id)
);

CREATE TABLE anime_licensors (
  anime_id    BIGINT NOT NULL REFERENCES anime(id)  ON DELETE CASCADE,
  licensor_id BIGINT NOT NULL REFERENCES licensors(id) ON DELETE CASCADE,
  PRIMARY KEY (anime_id, licensor_id)
);

CREATE TABLE anime_themes (
  anime_id BIGINT NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  theme_id BIGINT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  PRIMARY KEY (anime_id, theme_id)
);

CREATE TABLE anime_demographics (
  anime_id       BIGINT NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  demographic_id BIGINT NOT NULL REFERENCES demographics(id) ON DELETE CASCADE,
  PRIMARY KEY (anime_id, demographic_id)
);
