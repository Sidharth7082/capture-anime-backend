-- ============================================================================
-- 0003: Search indexes
--
-- Two complementary strategies:
--   1. Trigram GIN indexes (pg_trgm) for fuzzy / partial / typo-tolerant
--      matching on titles and names (ILIKE '%term%' also uses them).
--   2. Generated tsvector columns + GIN for ranked full-text search.
--
-- The tsvector columns are GENERATED ALWAYS ... STORED: Postgres maintains
-- them automatically, so application writes never touch them.
-- ============================================================================

-- --- Fuzzy title/name search (trigram) ---------------------------------------
CREATE INDEX anime_trgm_romaji_idx  ON anime USING GIN (title_romaji gin_trgm_ops);
CREATE INDEX anime_trgm_english_idx ON anime USING GIN (title_english gin_trgm_ops);
CREATE INDEX anime_trgm_native_idx  ON anime USING GIN (title_native gin_trgm_ops);

CREATE INDEX characters_trgm_first_idx ON characters USING GIN (name_first gin_trgm_ops);
CREATE INDEX characters_trgm_last_idx  ON characters USING GIN (name_last gin_trgm_ops);

CREATE INDEX studios_trgm_name_idx ON studios USING GIN (name gin_trgm_ops);
CREATE INDEX genres_trgm_name_idx  ON genres USING GIN (name gin_trgm_ops);

-- --- Full-text search ---------------------------------------------------------

ALTER TABLE anime
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(title_romaji, '')  || ' ' ||
      coalesce(title_english, '') || ' ' ||
      coalesce(title_native, '')
    )
  ) STORED;

CREATE INDEX anime_search_vector_idx ON anime USING GIN (search_vector);

ALTER TABLE characters
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(name_first, '') || ' ' ||
      coalesce(name_last, '')  || ' ' ||
      coalesce(name_native, '')
    )
  ) STORED;

CREATE INDEX characters_search_vector_idx ON characters USING GIN (search_vector);
