-- Revert enrichment sync cursor.

DROP INDEX IF EXISTS anime_enrich_synced_at_idx;
ALTER TABLE anime DROP COLUMN IF EXISTS enrich_synced_at;
