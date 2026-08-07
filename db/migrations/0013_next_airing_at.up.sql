-- AniList-only field: when the next episode airs (null when unknown/finished).

ALTER TABLE anime ADD COLUMN next_airing_at TIMESTAMPTZ;
