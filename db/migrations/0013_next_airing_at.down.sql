-- Revert next_airing_at.

ALTER TABLE anime DROP COLUMN IF EXISTS next_airing_at;
