-- Resumable import jobs. One row per import source ('jikan-anime' today;
-- later 'mal-user-list', 'anilist', 'tmdb', ...). last_page is the last
-- successfully completed page, so a crashed run resumes from last_page + 1.

CREATE TABLE import_jobs (
  source      TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'running'
              CHECK (status IN ('running', 'completed', 'failed')),
  last_page   INT NOT NULL DEFAULT 0,
  total_items INT,
  error       TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
