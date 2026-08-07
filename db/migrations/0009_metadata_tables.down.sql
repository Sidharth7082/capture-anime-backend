-- Revert Stage 2 metadata.

DROP TABLE IF EXISTS anime_demographics;
DROP TABLE IF EXISTS anime_themes;
DROP TABLE IF EXISTS anime_licensors;
DROP TABLE IF EXISTS anime_producers;
DROP TABLE IF EXISTS demographics;
DROP TABLE IF EXISTS themes;
DROP TABLE IF EXISTS licensors;
DROP TABLE IF EXISTS producers;

DROP INDEX IF EXISTS studios_mal_id_uidx;
ALTER TABLE studios DROP COLUMN IF EXISTS mal_id;

DROP INDEX IF EXISTS genres_mal_id_uidx;
ALTER TABLE genres DROP COLUMN IF EXISTS mal_id;
