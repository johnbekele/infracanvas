-- migrate:up

-- A sign-in, recorded so it can be ended.
--
-- The JWT alone cannot be revoked: it is valid until it expires because that is
-- what a signature means. Logging out therefore only stopped the browser from
-- sending the cookie, and anyone who had copied it kept access for the rest of
-- the hour. The row is what makes "log out" true rather than cosmetic.
CREATE TABLE sessions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  -- Touched only when a session is refreshed, not on every request: writing on
  -- each authenticated call would make the busiest table in the system the one
  -- carrying the least information.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  -- Which sign-in path issued this, so the interface can say so and an
  -- operator can tell an OAuth session from a local token one.
  auth_method  text        NOT NULL CHECK (auth_method IN ('oauth', 'token')),
  -- Where the token came from under the local method: 'env' or 'gh-cli'.
  token_origin text,
  user_agent   text
);

-- Supports listing and revoking a user's live sessions. Partial, because a
-- revoked row is only ever read by an audit, never by the request path.
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- migrate:down

DROP TABLE IF EXISTS sessions;
