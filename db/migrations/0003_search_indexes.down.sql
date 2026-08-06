-- ============================================================================
-- 0003 (down): drop search indexes and generated columns
-- ============================================================================

DROP INDEX IF EXISTS characters_search_vector_idx;
DROP INDEX IF EXISTS anime_search_vector_idx;

ALTER TABLE characters DROP COLUMN IF EXISTS search_vector;
ALTER TABLE anime      DROP COLUMN IF EXISTS search_vector;

DROP INDEX IF EXISTS genres_trgm_name_idx;
DROP INDEX IF EXISTS studios_trgm_name_idx;
DROP INDEX IF EXISTS characters_trgm_last_idx;
DROP INDEX IF EXISTS characters_trgm_first_idx;
DROP INDEX IF EXISTS anime_trgm_native_idx;
DROP INDEX IF EXISTS anime_trgm_english_idx;
DROP INDEX IF EXISTS anime_trgm_romaji_idx;
