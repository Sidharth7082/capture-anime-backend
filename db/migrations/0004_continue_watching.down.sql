-- Revert continue_watching + watch_history changes.

ALTER TABLE watch_history DROP CONSTRAINT IF EXISTS watch_history_user_episode_uidx;
ALTER TABLE watch_history
  ADD CONSTRAINT watch_history_user_episode_time_uidx UNIQUE (user_id, episode_id, watched_at);

DROP INDEX IF EXISTS continue_watching_user_updated_idx;
DROP TABLE IF EXISTS continue_watching;
