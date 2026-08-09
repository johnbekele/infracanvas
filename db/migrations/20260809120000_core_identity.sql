-- migrate:up

-- pgvector is enabled here rather than in the migration that first adds an
-- embedding column, so that a database provisioned from these migrations fails
-- fast on an image without the extension instead of part way through ingestion.
CREATE EXTENSION IF NOT EXISTS vector;

-- Keeps updated_at honest regardless of which service performs the write.
-- Application-side timestamps drift as soon as a second writer appears, and this
-- schema is shared by the TypeScript API, the Python brain, and the Rust engine.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id       bigint      NOT NULL UNIQUE,
  github_username text        NOT NULL,
  github_avatar   text        NOT NULL,
  email           text,
  name            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_github_username_idx ON users (github_username);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One token per user, so user_id is the primary key rather than a unique index
-- on a surrogate. The token is encrypted with AES-256-GCM by the application;
-- the database never sees plaintext.
CREATE TABLE github_tokens (
  user_id                uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  access_token_encrypted text        NOT NULL,
  token_type             text        NOT NULL,
  scope                  text        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER github_tokens_set_updated_at
  BEFORE UPDATE ON github_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down

DROP TABLE IF EXISTS github_tokens;
DROP TABLE IF EXISTS users;
DROP FUNCTION IF EXISTS set_updated_at();
