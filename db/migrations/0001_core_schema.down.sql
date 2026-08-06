-- ============================================================================
-- 0001 (down): drop everything created in 0001, reverse order
-- ============================================================================

DROP TRIGGER IF EXISTS comments_set_updated_at     ON comments;
DROP TRIGGER IF EXISTS ratings_set_updated_at      ON ratings;
DROP TRIGGER IF EXISTS watchlists_set_updated_at   ON watchlists;
DROP TRIGGER IF EXISTS episodes_set_updated_at     ON episodes;
DROP TRIGGER IF EXISTS staff_set_updated_at        ON staff;
DROP TRIGGER IF EXISTS characters_set_updated_at   ON characters;
DROP TRIGGER IF EXISTS anime_set_updated_at        ON anime;
DROP TRIGGER IF EXISTS users_set_updated_at        ON users;

DROP TRIGGER IF EXISTS comments_check_parent_target_trg ON comments;

DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS ratings;
DROP TABLE IF EXISTS watch_history;
DROP TABLE IF EXISTS watchlists;
DROP TABLE IF EXISTS favorites;
DROP TABLE IF EXISTS episodes;
DROP TABLE IF EXISTS character_staff;
DROP TABLE IF EXISTS staff;
DROP TABLE IF EXISTS anime_characters;
DROP TABLE IF EXISTS characters;
DROP TABLE IF EXISTS anime_studios;
DROP TABLE IF EXISTS studios;
DROP TABLE IF EXISTS anime_genres;
DROP TABLE IF EXISTS genres;
DROP TABLE IF EXISTS anime;
DROP TABLE IF EXISTS users;

DROP FUNCTION IF EXISTS comments_check_parent_target();
DROP FUNCTION IF EXISTS set_updated_at();

DROP TYPE IF EXISTS watchlist_status;
DROP TYPE IF EXISTS user_status;
DROP TYPE IF EXISTS user_role;
DROP TYPE IF EXISTS character_role;
DROP TYPE IF EXISTS media_source;
DROP TYPE IF EXISTS media_season;
DROP TYPE IF EXISTS media_status;
DROP TYPE IF EXISTS media_format;
DROP TYPE IF EXISTS media_type;
