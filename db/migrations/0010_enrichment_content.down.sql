-- Revert Stage 4 enrichment.

DROP INDEX IF EXISTS anime_recommendations_recommended_anime_id_idx;
DROP INDEX IF EXISTS anime_relations_related_anime_id_idx;

DROP TABLE IF EXISTS anime_videos;
DROP TABLE IF EXISTS anime_pictures;
DROP TABLE IF EXISTS anime_recommendations;
DROP TABLE IF EXISTS anime_relations;
DROP TABLE IF EXISTS anime_staff;

DROP INDEX IF EXISTS staff_mal_id_uidx;
ALTER TABLE staff DROP COLUMN IF EXISTS mal_id;

DROP INDEX IF EXISTS characters_mal_id_uidx;
ALTER TABLE characters DROP COLUMN IF EXISTS mal_id;
