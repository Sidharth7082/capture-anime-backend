-- Enrichment-specific sync cursor.
--
-- The catalog import (Stage 1) bumps anime.last_synced_at on every row it
-- touches, which would defeat an ENRICH_STALE_DAYS filter keyed on that
-- column (the scheduler runs import then enrich back-to-back). This column
-- tracks the LAST ENRICHMENT only, so stale-refresh re-enriches anime whose
-- characters/staff/pictures/etc. have not been refreshed recently.

ALTER TABLE anime ADD COLUMN enrich_synced_at TIMESTAMPTZ;

CREATE INDEX anime_enrich_synced_at_idx ON anime (enrich_synced_at) WHERE enrich_synced_at IS NOT NULL;
