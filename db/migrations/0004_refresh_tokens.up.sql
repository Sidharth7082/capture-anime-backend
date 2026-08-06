-- ============================================================================
-- 0004: refresh_tokens — server-side refresh token storage
--
-- Refresh tokens are rotated on every use and revocable on logout, so a
-- stolen refresh token can be invalidated. Only the SHA-256 hash of the
-- token is stored (never the raw token), making the table useless if dumped.
-- ============================================================================

CREATE TABLE refresh_tokens (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,           -- sha256 hex digest of the token
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ                      -- set on logout / rotation
);

-- Lookup by user for "revoke all sessions" and pruning of live sessions.
CREATE INDEX refresh_tokens_user_active_idx
  ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- Expired rows are garbage: prune by expiry.
CREATE INDEX refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);
