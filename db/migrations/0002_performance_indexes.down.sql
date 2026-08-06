-- ============================================================================
-- 0002 (down): drop all indexes created in 0002
-- ============================================================================

DROP INDEX IF EXISTS comments_user_idx;
DROP INDEX IF EXISTS comments_parent_idx;
DROP INDEX IF EXISTS comments_episode_created_idx;
DROP INDEX IF EXISTS comments_anime_created_idx;
DROP INDEX IF EXISTS ratings_user_idx;
DROP INDEX IF EXISTS ratings_anime_created_idx;
DROP INDEX IF EXISTS ratings_anime_score_idx;
DROP INDEX IF EXISTS watch_history_episode_idx;
DROP INDEX IF EXISTS watch_history_user_episode_idx;
DROP INDEX IF EXISTS watch_history_user_watched_idx;
DROP INDEX IF EXISTS watchlists_status_updated_idx;
DROP INDEX IF EXISTS watchlists_user_status_idx;
DROP INDEX IF EXISTS favorites_staff_idx;
DROP INDEX IF EXISTS favorites_character_idx;
DROP INDEX IF EXISTS favorites_anime_idx;
DROP INDEX IF EXISTS favorites_user_created_idx;
DROP INDEX IF EXISTS episodes_air_date_idx;
DROP INDEX IF EXISTS episodes_anime_air_date_idx;
DROP INDEX IF EXISTS character_staff_staff_idx;
DROP INDEX IF EXISTS staff_language_idx;
DROP INDEX IF EXISTS anime_characters_anime_sort_idx;
DROP INDEX IF EXISTS anime_characters_character_idx;
DROP INDEX IF EXISTS studios_name_idx;
DROP INDEX IF EXISTS anime_studios_studio_idx;
DROP INDEX IF EXISTS anime_genres_genre_idx;
DROP INDEX IF EXISTS anime_airing_idx;
DROP INDEX IF EXISTS anime_start_date_idx;
DROP INDEX IF EXISTS anime_updated_at_idx;
DROP INDEX IF EXISTS anime_score_idx;
DROP INDEX IF EXISTS anime_popularity_idx;
DROP INDEX IF EXISTS anime_season_idx;
DROP INDEX IF EXISTS anime_status_format_idx;
DROP INDEX IF EXISTS users_last_login_idx;
DROP INDEX IF EXISTS users_created_at_idx;
DROP INDEX IF EXISTS users_role_idx;
