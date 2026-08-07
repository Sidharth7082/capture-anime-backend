-- Revert 0007. Jikan-only rows (no AniList id) are removed first so the
-- NOT NULL constraint can be restored safely.

DROP INDEX IF EXISTS anime_id_mal_idx;

DELETE FROM anime WHERE anilist_id IS NULL;

ALTER TABLE anime ALTER COLUMN anilist_id SET NOT NULL;
