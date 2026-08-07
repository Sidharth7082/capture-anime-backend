-- Allow Jikan-imported titles that have no AniList id yet.
--
-- The importer (importer/) upserts anime by MAL id (anime.id_mal). Jikan
-- responses carry no AniList id, so new titles must be insertable with a
-- NULL anilist_id. The API keeps working: anilistId simply becomes nullable
-- for these rows, and id_mal gains a (non-unique) lookup index for the
-- importer's by-mal-id upserts.

ALTER TABLE anime ALTER COLUMN anilist_id DROP NOT NULL;

CREATE INDEX anime_id_mal_idx ON anime (id_mal);
