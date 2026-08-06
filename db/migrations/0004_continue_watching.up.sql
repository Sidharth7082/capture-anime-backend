-- Continue watching + per-episode watch history uniqueness.

-- ---------------------------------------------------------------------------
-- 1) continue_watching — one row per (user, anime) with the latest position.
-- ---------------------------------------------------------------------------
CREATE TABLE continue_watching (
  id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id                   UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anime_id                  BIGINT NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  episode_number            INT    NOT NULL CHECK (episode_number >= 1),
  playback_position_seconds INT    NOT NULL DEFAULT 0 CHECK (playback_position_seconds >= 0),
  duration_seconds          INT    CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT continue_watching_user_anime_uidx UNIQUE (user_id, anime_id)
);

CREATE INDEX continue_watching_user_updated_idx
  ON continue_watching (user_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- 2) watch_history — one row per (user, episode): drop the old
--    (user_id, episode_id, watched_at) uniqueness and dedupe first, keeping
--    the most recent watch per episode.
-- ---------------------------------------------------------------------------
DELETE FROM watch_history wh
USING watch_history newer
WHERE newer.user_id = wh.user_id
  AND newer.episode_id = wh.episode_id
  AND (newer.watched_at > wh.watched_at
       OR (newer.watched_at = wh.watched_at AND newer.id > wh.id));

ALTER TABLE watch_history DROP CONSTRAINT watch_history_user_episode_time_uidx;

ALTER TABLE watch_history
  ADD CONSTRAINT watch_history_user_episode_uidx UNIQUE (user_id, episode_id);
