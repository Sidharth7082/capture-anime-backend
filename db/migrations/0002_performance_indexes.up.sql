-- ============================================================================
-- 0002: Performance indexes
--
-- Every FK column that is not already the leftmost column of an index gets
-- one, plus the indexes that back the platform's hot query patterns:
--   * browse/catalog filters   -> anime (status, format, is_adult), season, ...
--   * "top rated" / "popular"  -> anime (average_score / popularity DESC)
--   * continue watching        -> watch_history (user_id, watched_at DESC)
--   * comment feeds            -> comments (anime_id/episode_id, created_at DESC)
-- Partial indexes keep size down: WHERE clauses match the exact query shapes.
-- ============================================================================

-- --- users ----------------------------------------------------------------
CREATE INDEX users_role_idx        ON users (role);
CREATE INDEX users_created_at_idx  ON users (created_at DESC);
CREATE INDEX users_last_login_idx  ON users (last_login_at DESC) WHERE last_login_at IS NOT NULL;

-- --- anime -----------------------------------------------------------------
-- Catalog browsing: filter by status/format, optionally excluding adult titles.
CREATE INDEX anime_status_format_idx ON anime (status, format, is_adult);
-- Seasonal listings: "Spring 2024".
CREATE INDEX anime_season_idx        ON anime (season_year DESC, season);
-- Sort-by feeds (top-rated, trending).
CREATE INDEX anime_popularity_idx    ON anime (popularity DESC) WHERE popularity IS NOT NULL;
CREATE INDEX anime_score_idx         ON anime (average_score DESC) WHERE average_score IS NOT NULL;
-- "Recently added / updated" feeds and start-date ordered lists.
CREATE INDEX anime_updated_at_idx    ON anime (updated_at DESC);
CREATE INDEX anime_start_date_idx    ON anime (start_date);
-- "Currently airing" dashboards.
CREATE INDEX anime_airing_idx        ON anime (status, start_date) WHERE status = 'RELEASING';

-- --- genres / studios -------------------------------------------------------
CREATE INDEX anime_genres_genre_idx   ON anime_genres (genre_id);
CREATE INDEX anime_studios_studio_idx ON anime_studios (studio_id);
CREATE INDEX studios_name_idx         ON studios (name);

-- --- characters -------------------------------------------------------------
CREATE INDEX anime_characters_character_idx ON anime_characters (character_id);
-- "Main cast" listing for a show's page.
CREATE INDEX anime_characters_anime_sort_idx ON anime_characters (anime_id, role, sort_order);

-- --- staff ------------------------------------------------------------------
CREATE INDEX staff_language_idx         ON staff (language);
CREATE INDEX character_staff_staff_idx  ON character_staff (staff_id);

-- --- episodes ---------------------------------------------------------------
CREATE INDEX episodes_anime_air_date_idx ON episodes (anime_id, air_date);
CREATE INDEX episodes_air_date_idx       ON episodes (air_date);

-- --- favorites ---------------------------------------------------------------
CREATE INDEX favorites_user_created_idx ON favorites (user_id, created_at DESC);
-- Reverse lookups ("who favorited this target") only need rows of one type.
CREATE INDEX favorites_anime_idx     ON favorites (anime_id)     WHERE anime_id IS NOT NULL;
CREATE INDEX favorites_character_idx ON favorites (character_id) WHERE character_id IS NOT NULL;
CREATE INDEX favorites_staff_idx     ON favorites (staff_id)     WHERE staff_id IS NOT NULL;

-- --- watchlists ---------------------------------------------------------------
CREATE INDEX watchlists_user_status_idx ON watchlists (user_id, status);
CREATE INDEX watchlists_status_updated_idx ON watchlists (status, updated_at DESC);

-- --- watch_history ---------------------------------------------------------------
-- Continue-watching feed: most recent views per user.
CREATE INDEX watch_history_user_watched_idx ON watch_history (user_id, watched_at DESC);
-- Resume position and per-episode analytics.
CREATE INDEX watch_history_user_episode_idx ON watch_history (user_id, episode_id);
CREATE INDEX watch_history_episode_idx      ON watch_history (episode_id);

-- --- ratings -------------------------------------------------------------------
CREATE INDEX ratings_anime_score_idx   ON ratings (anime_id, score DESC);
CREATE INDEX ratings_anime_created_idx ON ratings (anime_id, created_at DESC);
CREATE INDEX ratings_user_idx          ON ratings (user_id);

-- --- comments -------------------------------------------------------------------
-- Comment feeds skip soft-deleted rows.
CREATE INDEX comments_anime_created_idx   ON comments (anime_id, created_at DESC)   WHERE is_deleted = FALSE;
CREATE INDEX comments_episode_created_idx ON comments (episode_id, created_at DESC) WHERE is_deleted = FALSE;
CREATE INDEX comments_parent_idx          ON comments (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX comments_user_idx            ON comments (user_id, created_at DESC);
