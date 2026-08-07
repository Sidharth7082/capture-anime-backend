-- Revert schema hardening.

ALTER TABLE anime_videos         DROP COLUMN IF EXISTS updated_at, DROP COLUMN IF EXISTS created_at;
ALTER TABLE anime_pictures       DROP COLUMN IF EXISTS updated_at, DROP COLUMN IF EXISTS created_at;
ALTER TABLE anime_recommendations DROP COLUMN IF EXISTS updated_at, DROP COLUMN IF EXISTS created_at;
ALTER TABLE anime_relations      DROP COLUMN IF EXISTS updated_at, DROP COLUMN IF EXISTS created_at;
ALTER TABLE anime_staff          DROP COLUMN IF EXISTS updated_at, DROP COLUMN IF EXISTS created_at;

ALTER TABLE episodes   DROP COLUMN IF EXISTS last_synced_at;
ALTER TABLE staff      DROP COLUMN IF EXISTS last_synced_at;
ALTER TABLE characters DROP COLUMN IF EXISTS last_synced_at;

ALTER TABLE demographics DROP COLUMN IF EXISTS last_synced_at, DROP COLUMN IF EXISTS updated_at;
ALTER TABLE themes       DROP COLUMN IF EXISTS last_synced_at, DROP COLUMN IF EXISTS updated_at;
ALTER TABLE licensors    DROP COLUMN IF EXISTS last_synced_at, DROP COLUMN IF EXISTS updated_at;
ALTER TABLE producers    DROP COLUMN IF EXISTS last_synced_at, DROP COLUMN IF EXISTS updated_at;
ALTER TABLE studios      DROP COLUMN IF EXISTS last_synced_at, DROP COLUMN IF EXISTS updated_at;
ALTER TABLE genres       DROP COLUMN IF EXISTS last_synced_at, DROP COLUMN IF EXISTS updated_at;

DROP INDEX IF EXISTS anime_slug_uidx;
ALTER TABLE anime DROP COLUMN IF EXISTS last_synced_at, DROP COLUMN IF EXISTS slug;

DROP INDEX IF EXISTS anime_id_mal_uidx;
