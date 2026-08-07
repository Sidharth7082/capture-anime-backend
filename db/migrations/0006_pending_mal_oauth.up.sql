-- Server-side PKCE OAuth state for MyAnimeList.
--
-- The SPA fetches /api/mal/connect with its JWT and receives { authorizeUrl }
-- plus a persisted pending record keyed by `state`. The MAL callback then
-- looks the verifier/user up server-side by state — no cross-origin cookie
-- needed (cookies are unreliable for SPA -> LAN API under third-party
-- cookie blocking, and this flow must work over plain HTTP).

CREATE TABLE pending_mal_oauth (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  state         TEXT NOT NULL UNIQUE,          -- random token, never a secret itself
  code_verifier TEXT NOT NULL,                 -- PKCE verifier (S256)
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX pending_mal_oauth_expires_idx ON pending_mal_oauth (expires_at);
